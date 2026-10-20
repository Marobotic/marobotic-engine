// Vault's native side: only what a web page can't do. Everything secret is opened in the window;
// the file written here is already sealed.
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{Emitter, Manager};


fn vault_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("vault.json"))
}

#[tauri::command]
fn vault_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(vault_file(&app)?.display().to_string())
}

#[tauri::command]
fn load_vault(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = vault_file(&app)?;
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("can't read {}: {e}", path.display())),
    }
}

/// Written to a temporary file and renamed over the old one, so a crash mid-write never leaves half
/// a vault; the previous version stays as vault.json.bak.
#[tauri::command]
fn save_vault(app: tauri::AppHandle, json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|_| "refusing to save something that isn't a vault".to_string())?;
    let path = vault_file(&app)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json.as_bytes()).map_err(|e| e.to_string())?;
    if path.exists() {
        let _ = fs::copy(&path, path.with_extension("json.bak"));
    }
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// One attempt at XIVLauncher's OTP endpoint (https://goatcorp.github.io/faq/mobile_otp):
/// GET http://<host>:4646/ffxivlauncher/<code>. True when it answered 200.
#[tauri::command]
fn xl_send(code: String, host: String) -> bool {
    if code.is_empty() || code.len() > 10 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    if host.is_empty() || !host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b':') {
        return false;
    }
    let Some(addr) = (host.as_str(), 4646).to_socket_addrs().ok().and_then(|mut a| a.next()) else { return false };
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(1500)) else { return false };
    let _ = s.set_read_timeout(Some(Duration::from_millis(1500)));
    let req = format!("GET /ffxivlauncher/{code} HTTP/1.1\r\nHost: {host}:4646\r\nConnection: close\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut head = [0u8; 32];
    let n = s.read(&mut head).unwrap_or(0);
    let status = String::from_utf8_lossy(&head[..n]);
    status.starts_with("HTTP/1.1 200") || status.starts_with("HTTP/1.0 200")
}

/// Windows: you pick the QR code on screen, like a snipping tool. Vault steps aside, every monitor is
/// captured, and each gets a full-screen window showing its picture dimmed (snip.html); you drag a box
/// around the QR code there. The text of the code(s) in that box comes back, or None when cancelled.
#[cfg(windows)]
#[derive(Default)]
struct Snip {
    shots: std::sync::Mutex<Vec<xcap::image::RgbaImage>>,
    reply: std::sync::Mutex<Option<std::sync::mpsc::Sender<Option<Vec<String>>>>>,
}

#[cfg(windows)]
const SNIP: &str = "snip-";
/// The main window's additionalBrowserArgs in tauri.conf.json, word for word.
#[cfg(windows)]
const MAIN_BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows";

#[cfg(windows)]
fn snip_index(window: &tauri::WebviewWindow) -> Option<usize> {
    window.label().strip_prefix(SNIP)?.parse().ok()
}

#[cfg(windows)]
#[tauri::command]
async fn scan_screen(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Option<Vec<String>>, String> {
    use tauri::{PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};
    let _ = window.hide();
    let shots = tauri::async_runtime::spawn_blocking(|| {
        std::thread::sleep(Duration::from_millis(350)); // let the window finish disappearing
        xcap::Monitor::all().map(|ms| {
            ms.iter()
                .filter_map(|m| Some((m.x().ok()?, m.y().ok()?, m.capture_image().ok()?)))
                .collect::<Vec<_>>()
        })
    })
    .await
    .map_err(|e| e.to_string())?;
    let back = |w: &tauri::WebviewWindow| {
        let _ = w.show();
        let _ = w.set_focus();
    };
    let shots = match shots {
        Ok(s) if !s.is_empty() => s,
        Ok(_) => {
            back(&window);
            return Err("no screen could be captured".into());
        }
        Err(e) => {
            back(&window);
            return Err(e.to_string());
        }
    };
    let snip = app.state::<Snip>();
    let (tx, rx) = std::sync::mpsc::channel();
    *snip.reply.lock().unwrap() = Some(tx);
    let places: Vec<_> = shots.iter().map(|(x, y, img)| (*x, *y, img.width(), img.height())).collect();
    *snip.shots.lock().unwrap() = shots.into_iter().map(|(_, _, img)| img).collect();
    for (i, (x, y, w, h)) in places.into_iter().enumerate() {
        // Same browser arguments as the main window: WebView2 refuses a second set in one profile.
        let built = WebviewWindowBuilder::new(&app, format!("{SNIP}{i}"), WebviewUrl::App("snip.html".into()))
            .title("Vault - pick the QR code")
            .decorations(false)
            .resizable(false)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .additional_browser_args(MAIN_BROWSER_ARGS)
            .build();
        match built {
            Ok(win) => {
                let _ = win.set_position(PhysicalPosition::new(x, y));
                let _ = win.set_size(PhysicalSize::new(w.max(1), h.max(1)));
            }
            Err(e) => {
                close_snips(&app);
                back(&window);
                return Err(e.to_string());
            }
        }
    }
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten()).await.map_err(|e| e.to_string())?;
    close_snips(&app);
    back(&window);
    Ok(picked)
}

#[cfg(windows)]
fn close_snips(app: &tauri::AppHandle) {
    let snip = app.state::<Snip>();
    snip.shots.lock().unwrap().clear();
    snip.reply.lock().unwrap().take();
    for (label, w) in app.webview_windows() {
        if label.starts_with(SNIP) {
            let _ = w.destroy();
        }
    }
}

/// The picture of the monitor a snip window covers: width and height (u32, little endian), then RGBA.
#[cfg(windows)]
#[tauri::command]
fn snip_shot(window: tauri::WebviewWindow, snip: tauri::State<Snip>) -> Result<tauri::ipc::Response, String> {
    let shots = snip.shots.lock().unwrap();
    let img = snip_index(&window).and_then(|i| shots.get(i)).ok_or("no picture for this window")?;
    let mut out = Vec::with_capacity(8 + img.as_raw().len());
    out.extend_from_slice(&img.width().to_le_bytes());
    out.extend_from_slice(&img.height().to_le_bytes());
    out.extend_from_slice(img.as_raw());
    Ok(tauri::ipc::Response::new(out))
}

/// Shown once its picture is drawn, so the screen never flashes blank.
#[cfg(windows)]
#[tauri::command]
fn snip_show(window: tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
}

/// A second opinion on the picked box when the page's reader (jsQR) found nothing: rqrr, at the
/// size it is and blown up 2x and 3x (small QR codes on a dense screen).
#[cfg(windows)]
#[tauri::command]
fn snip_decode(window: tauri::WebviewWindow, snip: tauri::State<Snip>, x: u32, y: u32, w: u32, h: u32) -> Vec<String> {
    let shots = snip.shots.lock().unwrap();
    let Some(img) = snip_index(&window).and_then(|i| shots.get(i)) else { return Vec::new() };
    let (x, y) = (x.min(img.width().saturating_sub(1)), y.min(img.height().saturating_sub(1)));
    let (w, h) = (w.min(img.width() - x).max(1), h.min(img.height() - y).max(1));
    let px = img.as_raw();
    let stride = img.width() as usize;
    let mut found = Vec::new();
    for scale in [1usize, 2, 3] {
        let (sw, sh) = (w as usize * scale, h as usize * scale);
        let mut prepared = rqrr::PreparedImage::prepare_from_greyscale(sw, sh, |cx, cy| {
            let i = ((y as usize + cy / scale) * stride + x as usize + cx / scale) * 4;
            ((px[i] as u32 * 77 + px[i + 1] as u32 * 150 + px[i + 2] as u32 * 29) >> 8) as u8
        });
        for grid in prepared.detect_grids() {
            if let Ok((_, text)) = grid.decode() {
                if !found.contains(&text) {
                    found.push(text);
                }
            }
        }
        if !found.is_empty() {
            break;
        }
    }
    found
}

/// The box was picked (the codes in it), or the snip was cancelled (None).
#[cfg(windows)]
#[tauri::command]
fn snip_done(snip: tauri::State<Snip>, texts: Option<Vec<String>>) {
    if let Some(tx) = snip.reply.lock().unwrap().take() {
        let _ = tx.send(texts);
    }
}

#[cfg(not(windows))]
#[tauri::command]
fn scan_screen() -> Option<Vec<String>> {
    None
}
#[cfg(not(windows))]
#[tauri::command]
fn snip_shot() {}
#[cfg(not(windows))]
#[tauri::command]
fn snip_show() {}
#[cfg(not(windows))]
#[tauri::command]
fn snip_decode() -> Vec<String> {
    Vec::new()
}
#[cfg(not(windows))]
#[tauri::command]
fn snip_done() {}

/// Windows: otpauth:// links (a site's "add to authenticator app" button) open Vault. Per user, no admin.
#[cfg(windows)]
#[tauri::command]
fn set_link_handler(on: bool) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let reg = |args: &[&str]| {
        std::process::Command::new("reg").args(args).creation_flags(0x0800_0000).output().map_err(|e| e.to_string())
    };
    let key = r"HKCU\Software\Classes\otpauth";
    let exe = std::env::current_exe().map_err(|e| e.to_string())?.display().to_string();
    if on {
        reg(&["add", key, "/ve", "/d", "URL:otpauth", "/f"])?;
        reg(&["add", key, "/v", "URL Protocol", "/d", "", "/f"])?;
        reg(&["add", &format!(r"{key}\DefaultIcon"), "/ve", "/d", &format!("{exe},0"), "/f"])?;
        reg(&["add", &format!(r"{key}\shell\open\command"), "/ve", "/d", &format!("\"{exe}\" \"%1\""), "/f"])?;
    } else {
        // Only remove the handler when it is Vault's, never another authenticator's.
        let cur = reg(&["query", &format!(r"{key}\shell\open\command"), "/ve"])?;
        if String::from_utf8_lossy(&cur.stdout).contains(&exe) {
            reg(&["delete", key, "/f"])?;
        }
    }
    Ok(())
}

#[cfg(not(windows))]
#[tauri::command]
fn set_link_handler(_on: bool) {}

/// Windows: Brave, Chrome and Edge stop offering and filling their own saved passwords (and their
/// address and card autofill), so only Vault suggests anything. A browser keeps filling passwords it
/// saved before even with "Offer to save" off; its PasswordManagerEnabled policy is the switch for that.
/// Policies can only be written by an administrator, so this asks once (UAC) and writes them for the
/// whole PC. Nothing saved in the browser is deleted; it shows "managed by your organization" while on.
#[cfg(windows)]
const BROWSERS: [(&str, &str, &str); 3] = [
    ("Brave", r"BraveSoftware\Brave-Browser", r"SOFTWARE\Policies\BraveSoftware\Brave"),
    ("Chrome", r"Google\Chrome", r"SOFTWARE\Policies\Google\Chrome"),
    ("Edge", r"Microsoft\Edge", r"SOFTWARE\Policies\Microsoft\Edge"),
];
#[cfg(windows)]
const LOCKDOWN_VALUES: [&str; 3] = ["PasswordManagerEnabled", "AutofillAddressEnabled", "AutofillCreditCardEnabled"];

#[cfg(windows)]
fn installed_browsers() -> Vec<(&'static str, &'static str)> {
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    BROWSERS.iter().filter(|(_, dir, _)| std::path::Path::new(&local).join(dir).exists()).map(|(n, _, k)| (*n, *k)).collect()
}

/// Which installed browsers have their own password manager turned off (read from the registry).
#[cfg(windows)]
#[tauri::command]
fn browser_lockdown_state() -> Vec<(String, bool)> {
    use std::os::windows::process::CommandExt;
    installed_browsers().into_iter().map(|(name, key)| {
        let out = std::process::Command::new("reg").args(["query", &format!(r"HKLM\{key}"), "/v", "PasswordManagerEnabled"])
            .creation_flags(0x0800_0000).output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
        (name.to_string(), out.contains("0x0"))
    }).collect()
}

#[cfg(windows)]
#[tauri::command]
fn set_browser_lockdown(on: bool) -> Result<Vec<String>, String> {
    use std::os::windows::process::CommandExt;
    let browsers = installed_browsers();
    if browsers.is_empty() {
        return Ok(Vec::new());
    }
    let mut script = String::from("@echo off\r\n");
    for (_, key) in &browsers {
        for value in LOCKDOWN_VALUES {
            script += &if on {
                format!("reg add \"HKLM\\{key}\" /v {value} /t REG_DWORD /d 0 /f\r\n")
            } else {
                format!("reg delete \"HKLM\\{key}\" /v {value} /f\r\n")
            };
        }
    }
    let path = std::env::temp_dir().join("vault-browser-lockdown.cmd");
    std::fs::write(&path, script).map_err(|e| e.to_string())?;
    // One UAC prompt; declining it is an error the window reports.
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command",
            &format!("Start-Process -FilePath cmd.exe -ArgumentList '/c \"{}\"' -Verb RunAs -Wait -WindowStyle Hidden", path.display())])
        .creation_flags(0x0800_0000).status().map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&path);
    if !status.success() {
        return Err("Windows didn't allow it (the administrator prompt was declined)".into());
    }
    Ok(browsers.iter().map(|(n, _)| n.to_string()).collect())
}

#[cfg(not(windows))]
#[tauri::command]
fn browser_lockdown_state() -> Vec<(String, bool)> {
    Vec::new()
}

#[cfg(not(windows))]
#[tauri::command]
fn set_browser_lockdown(_on: bool) -> Vec<String> {
    Vec::new()
}

/// The otpauth:// link Vault was started with (Windows), handed to the window once.
struct LaunchLink(std::sync::Mutex<Option<String>>);

fn link_in(args: &[String]) -> Option<String> {
    args.iter().find(|a| a.to_ascii_lowercase().starts_with("otpauth")).cloned()
}

#[tauri::command]
fn take_launch_link(state: tauri::State<LaunchLink>) -> Option<String> {
    state.0.lock().ok()?.take()
}

#[tauri::command]
fn show_window(app: tauri::AppHandle) {
    #[cfg(desktop)]
    show_main(&app);
    #[cfg(not(desktop))]
    let _ = app;
}

/// Bring the window back from the tray (or from behind other windows).
#[cfg(desktop)]
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Closing the window keeps Vault running in the tray, unlocked, for quick codes. Quit from the
/// tray menu ends it, and the next start asks for the password again.
#[cfg(desktop)]
fn tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let show = MenuItem::with_id(app, "show", "Show Vault", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit (locks Vault)", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut tray = TrayIconBuilder::with_id("vault").tooltip("Vault").menu(&menu).show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(|app, e| match e.id.as_ref() {
        "show" => show_main(app),
        "quit" => app.exit(0),
        _ => {}
    })
    .on_tray_icon_event(|tray, e| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
            show_main(tray.app_handle());
        }
    })
    .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().manage(LaunchLink(std::sync::Mutex::new(link_in(&std::env::args().collect::<Vec<_>>()))));
    #[cfg(windows)]
    let builder = builder.manage(Snip::default());
    // Starting Vault again (Start menu, shortcut, an otpauth:// link) shows the one already in the tray.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            show_main(app);
            if let Some(link) = link_in(&args) {
                let _ = app.emit_to("main", "link", link);
            }
        }))
        .setup(|app| Ok(tray(app)?))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            // A snip window closed some other way (Alt+F4): the same as Esc.
            #[cfg(windows)]
            if let tauri::WindowEvent::Destroyed = event {
                if window.label().starts_with(SNIP) {
                    snip_done(window.state::<Snip>(), None);
                }
            }
        });
    builder
        .invoke_handler(tauri::generate_handler![
            vault_path, load_vault, save_vault, xl_send, scan_screen, snip_shot, snip_show, snip_decode, snip_done, set_link_handler, take_launch_link, show_window, set_browser_lockdown, browser_lockdown_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running Vault");
}
