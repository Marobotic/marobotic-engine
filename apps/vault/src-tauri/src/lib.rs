// Vault's native side: only what a web page can't do. Everything secret is opened in the window;
// the file written here is already sealed.
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{Emitter, Manager};

#[cfg(desktop)]
mod bridge;

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

/// Windows: every QR code on every monitor. Vault's own window steps aside for the capture, so a
/// QR code behind it is read too.
#[cfg(windows)]
#[tauri::command]
async fn scan_screen(window: tauri::WebviewWindow) -> Result<Vec<String>, String> {
    let _ = window.hide();
    let shots = tauri::async_runtime::spawn_blocking(|| {
        std::thread::sleep(Duration::from_millis(350)); // let the window finish disappearing
        xcap::Monitor::all().map(|ms| ms.iter().filter_map(|m| m.capture_image().ok()).collect::<Vec<_>>())
    })
    .await
    .map_err(|e| e.to_string())?;
    let _ = window.show();
    let _ = window.set_focus();
    let shots = shots.map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut found = Vec::new();
        for img in shots {
            let (w, h) = (img.width() as usize, img.height() as usize);
            let px = img.as_raw();
            let mut prepared = rqrr::PreparedImage::prepare_from_greyscale(w, h, |x, y| {
                let i = (y * w + x) * 4;
                ((px[i] as u32 * 77 + px[i + 1] as u32 * 150 + px[i + 2] as u32 * 29) >> 8) as u8
            });
            for grid in prepared.detect_grids() {
                if let Ok((_, text)) = grid.decode() {
                    if !found.contains(&text) {
                        found.push(text);
                    }
                }
            }
        }
        found
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
#[tauri::command]
fn scan_screen() -> Vec<String> {
    Vec::new()
}

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

/// The otpauth:// link Vault was started with (Windows), handed to the window once.
struct LaunchLink(std::sync::Mutex<Option<String>>);

fn link_in(args: &[String]) -> Option<String> {
    args.iter().find(|a| a.to_ascii_lowercase().starts_with("otpauth")).cloned()
}

#[tauri::command]
fn take_launch_link(state: tauri::State<LaunchLink>) -> Option<String> {
    state.0.lock().ok()?.take()
}

/// The window's answer to one browser-extension request (see bridge.rs).
#[tauri::command]
fn bridge_reply(app: tauri::AppHandle, id: u64, json: String) {
    #[cfg(desktop)]
    bridge::reply(&app, id, json);
    #[cfg(not(desktop))]
    let _ = (app, id, json);
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
pub(crate) fn show_main(app: &tauri::AppHandle) {
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
    // Starting Vault again (Start menu, shortcut, an otpauth:// link) shows the one already in the tray.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            show_main(app);
            if let Some(link) = link_in(&args) {
                let _ = app.emit_to("main", "link", link);
            }
        }))
        .manage(bridge::Pending::default())
        .setup(|app| {
            tray(app)?;
            bridge::start(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        });
    builder
        .invoke_handler(tauri::generate_handler![
            vault_path, load_vault, save_vault, xl_send, scan_screen, set_link_handler, take_launch_link, show_window, bridge_reply
        ])
        .run(tauri::generate_context!())
        .expect("error while running Vault");
}
