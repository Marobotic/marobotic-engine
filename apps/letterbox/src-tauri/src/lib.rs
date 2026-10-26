// Letterbox's native side: session persistence on this PC, saving mail attachments to Downloads,
// single-instance window activation, and the system tray.
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

fn session_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("session.json"))
}

#[tauri::command]
fn load_session(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = session_file(&app)?;
    match fs::read_to_string(&path) {
        Ok(text) => {
            let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
            Ok(v["session"].as_str().map(|s| s.to_string()).filter(|s| !s.is_empty()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("can't read {}: {e}", path.display())),
    }
}

#[tauri::command]
fn save_session(app: tauri::AppHandle, session: String) -> Result<(), String> {
    let path = session_file(&app)?;
    if session.trim().is_empty() {
        let _ = fs::remove_file(&path);
        return Ok(());
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::json!({ "session": session.trim() }).to_string();
    fs::write(&tmp, body.as_bytes()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn b64_val(b: u8) -> Option<u8> {
    match b {
        b'A'..=b'Z' => Some(b - b'A'),
        b'a'..=b'z' => Some(b - b'a' + 26),
        b'0'..=b'9' => Some(b - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn b64_decode(input: &str) -> Result<Vec<u8>, String> {
    let clean: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if clean.len() % 4 != 0 {
        return Err("invalid base64 length".into());
    }
    let mut out = Vec::with_capacity(clean.len() / 4 * 3);
    for chunk in clean.chunks(4) {
        let a = b64_val(chunk[0]).ok_or("invalid base64")?;
        let b = b64_val(chunk[1]).ok_or("invalid base64")?;
        out.push((a << 2) | (b >> 4));
        if chunk[2] != b'=' {
            let c = b64_val(chunk[2]).ok_or("invalid base64")?;
            out.push((b << 4) | (c >> 2));
            if chunk[3] != b'=' {
                let d = b64_val(chunk[3]).ok_or("invalid base64")?;
                out.push((c << 6) | d);
            }
        }
    }
    Ok(out)
}

fn safe_filename(name: &str) -> String {
    let leaf = name.rsplit(['/', '\\']).find(|s| !s.is_empty()).unwrap_or(name);
    let cleaned: String = leaf
        .chars()
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c })
        .collect::<String>()
        .trim_matches(|c: char| c == '.' || c.is_whitespace())
        .to_string();
    if cleaned.is_empty() { "attachment".into() } else { cleaned }
}

fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let base = safe_filename(name);
    let candidate = dir.join(&base);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match base.rfind('.') {
        Some(i) if i > 0 => (&base[..i], &base[i..]),
        _ => (base.as_str(), ""),
    };
    for n in 1..1000 {
        let p = dir.join(format!("{stem} ({n}){ext}"));
        if !p.exists() {
            return p;
        }
    }
    candidate
}

#[tauri::command]
fn save_attachment(app: tauri::AppHandle, name: String, data_b64: String) -> Result<String, String> {
    let bytes = b64_decode(&data_b64)?;
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = unique_path(&dir, &name);
    fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    Ok(dest.file_name().and_then(|s| s.to_str()).unwrap_or("attachment").to_string())
}

fn clip(s: &str, max_chars: usize) -> String {
    let clean = s.trim();
    if clean.chars().count() <= max_chars {
        return clean.to_string();
    }
    let mut out: String = clean.chars().take(max_chars.saturating_sub(1)).collect();
    out.push('…');
    out
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let u = url.trim();
    if !(u.starts_with("https://") || u.starts_with("http://")) {
        return Err("only http and https links can be opened".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "shell32")]
        extern "system" {
            fn ShellExecuteW(
                hwnd: *mut core::ffi::c_void,
                lp_operation: *const u16,
                lp_file: *const u16,
                lp_parameters: *const u16,
                lp_directory: *const u16,
                n_show_cmd: i32,
            ) -> isize;
        }
        let op: Vec<u16> = std::ffi::OsStr::new("open").encode_wide().chain(Some(0)).collect();
        let file: Vec<u16> = std::ffi::OsStr::new(u).encode_wide().chain(Some(0)).collect();
        unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                op.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1, // SW_SHOWNORMAL
            );
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(u).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("xdg-open").arg(u).spawn();
    }
    Ok(())
}

#[tauri::command]
fn notify(title: String, body: String) {
    let t = clip(if title.trim().is_empty() { "Letterbox" } else { &title }, 60);
    let b = clip(if body.trim().is_empty() { "New message" } else { &body }, 200);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let exe = std::env::current_exe().ok().and_then(|p| p.into_os_string().into_string().ok()).unwrap_or_default();
        let ps = "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; \
                  $n = New-Object System.Windows.Forms.NotifyIcon; \
                  try { if ($env:LETTERBOX_EXE) { $n.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:LETTERBOX_EXE) } } catch {}; \
                  if (-not $n.Icon) { $n.Icon = [System.Drawing.SystemIcons]::Information }; \
                  $n.Text = 'Letterbox'; \
                  $n.Visible = $true; \
                  $n.ShowBalloonTip(10000, $env:LETTERBOX_TITLE, $env:LETTERBOX_BODY, [System.Windows.Forms.ToolTipIcon]::None); \
                  Start-Sleep -Seconds 11; \
                  $n.Dispose()";
        let _ = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps])
            .env("LETTERBOX_EXE", exe)
            .env("LETTERBOX_TITLE", &t)
            .env("LETTERBOX_BODY", &b)
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("notify-send").args(["-a", "Letterbox", &t, &b]).spawn();
    }
}

#[cfg(desktop)]
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg(desktop)]
fn tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let show = MenuItem::with_id(app, "show", "Show Letterbox", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut tray = TrayIconBuilder::with_id("letterbox").tooltip("Letterbox").menu(&menu).show_menu_on_left_click(false);
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
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .setup(|app| Ok(tray(app)?))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        });
    builder
        .invoke_handler(tauri::generate_handler![load_session, save_session, save_attachment, open_url, notify])
        .run(tauri::generate_context!())
        .expect("error while running Letterbox");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_and_filenames() {
        assert_eq!(b64_decode("aGVsbG8gd29ybGQ=").unwrap(), b"hello world");
        assert_eq!(b64_decode("YQ==").unwrap(), b"a");
        assert_eq!(safe_filename("..//invoice:2026?.pdf"), "invoice_2026_.pdf");
        assert_eq!(safe_filename("..."), "attachment");
        assert_eq!(clip("hello", 10), "hello");
        assert_eq!(clip("abcdefghij", 5), "abcd…");
    }
}
