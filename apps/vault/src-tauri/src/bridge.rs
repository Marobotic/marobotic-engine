// The browser extension's way in: a tiny HTTP endpoint on 127.0.0.1 that only answers browser
// extensions (web pages can't fake the Origin header, and a DNS-rebound name fails the Host check).
// Each request goes to the window, which holds the open vault, checks the extension's token and the
// page's site, and answers; nothing secret is kept here.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub const PORT: u16 = 47350;
const MAX_BODY: usize = 64 * 1024;

#[derive(Default)]
pub struct Pending {
    next: AtomicU64,
    waiting: Mutex<HashMap<u64, mpsc::Sender<String>>>,
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let Ok(listener) = TcpListener::bind(("127.0.0.1", PORT)) else {
            eprintln!("vault: port {PORT} is taken; the browser extension can't connect");
            return;
        };
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || {
                let _ = serve(&app, stream);
            });
        }
    });
}

pub fn reply(app: &AppHandle, id: u64, json: String) {
    if let Some(tx) = app.state::<Pending>().waiting.lock().ok().and_then(|mut w| w.remove(&id)) {
        let _ = tx.send(json);
    }
}

fn respond(s: &mut TcpStream, status: &str, body: &str) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    s.write_all(head.as_bytes())?;
    s.write_all(body.as_bytes())
}

fn serve(app: &AppHandle, mut s: TcpStream) -> std::io::Result<()> {
    s.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        let n = s.read(&mut chunk)?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break p + 4;
        }
        if buf.len() > 16 * 1024 {
            return respond(&mut s, "431 Too Large", "{}");
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default().to_string();
    let header = |name: &str| {
        head.split("\r\n").skip(1).find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.trim().eq_ignore_ascii_case(name).then(|| v.trim().to_string())
        })
    };
    let host = header("host").unwrap_or_default();
    let origin = header("origin").unwrap_or_default();
    if host != format!("127.0.0.1:{PORT}") && host != format!("localhost:{PORT}") {
        return respond(&mut s, "403 Forbidden", r#"{"error":"host"}"#);
    }
    if !(origin.starts_with("chrome-extension://") || origin.starts_with("moz-extension://")) {
        return respond(&mut s, "403 Forbidden", r#"{"error":"only the Vault browser extension may ask"}"#);
    }
    if !request_line.starts_with("POST /v1 ") {
        return respond(&mut s, "404 Not Found", r#"{"error":"not found"}"#);
    }
    let len: usize = header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    if len > MAX_BODY {
        return respond(&mut s, "413 Too Large", "{}");
    }
    let mut body = buf[head_end..].to_vec();
    while body.len() < len {
        let n = s.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(len);
    let body = String::from_utf8_lossy(&body).to_string();
    let Ok(req) = serde_json::from_str::<serde_json::Value>(&body) else {
        return respond(&mut s, "400 Bad Request", r#"{"error":"bad json"}"#);
    };
    let op = req.get("op").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    if op == "show" {
        crate::show_main(app);
        return respond(&mut s, "200 OK", r#"{"ok":true}"#);
    }

    let pending = app.state::<Pending>();
    let id = pending.next.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    pending.waiting.lock().map_err(|_| std::io::Error::other("lock"))?.insert(id, tx);
    let _ = app.emit_to("main", "bridge", serde_json::json!({ "id": id, "body": body }));
    // Pairing waits for the person to click Allow; everything else is answered at once.
    let wait = if op == "pair" { Duration::from_secs(100) } else { Duration::from_secs(15) };
    let answer = rx.recv_timeout(wait);
    if let Ok(mut w) = pending.waiting.lock() {
        w.remove(&id);
    }
    match answer {
        Ok(json) => respond(&mut s, "200 OK", &json),
        Err(_) => respond(&mut s, "200 OK", r#"{"error":"Vault didn't answer"}"#),
    }
}
