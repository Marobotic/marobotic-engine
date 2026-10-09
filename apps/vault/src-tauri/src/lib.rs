// Vault's native side: only what a web page can't do. Everything secret is opened in the window;
// the file written here is already sealed.
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::time::Duration;
use tauri::Manager;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![vault_path, load_vault, save_vault, xl_send])
        .run(tauri::generate_context!())
        .expect("error while running Vault");
}
