// What Letterbox needs from the device. Inside the Windows app (Tauri) it talks to
// marobotic.dev/letterbox with a saved session; in a browser it uses relative URLs and cookies.
type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
const T = (globalThis as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__;
const tauri = T?.core?.invoke;

export const inApp = Boolean(tauri);

let sessionToken = "";

export function serverBase(): string {
  if (!inApp) return "";
  const custom = localStorage.getItem("letterbox.server");
  return (custom || "https://marobotic.dev/letterbox").replace(/\/+$/, "") + "/";
}

export function apiUrl(path: string): string {
  return serverBase() + path.replace(/^\/+/, "");
}

export function getSession(): string {
  return sessionToken;
}

export async function initSession(): Promise<string> {
  if (!tauri) return "";
  try {
    sessionToken = (await tauri<string | null>("load_session")) || "";
  } catch {
    sessionToken = "";
  }
  return sessionToken;
}

export async function setSession(token: string): Promise<void> {
  sessionToken = token;
  if (!tauri) return;
  try {
    await tauri<void>("save_session", { session: token });
  } catch { /* ignore */ }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** In the Windows app, save an attachment to the user's Downloads folder and return its filename. */
export async function saveAttachment(url: string, name: string): Promise<string> {
  const headers = new Headers();
  if (sessionToken) headers.set("authorization", `Bearer ${sessionToken}`);
  const r = await fetch(url, { headers, credentials: inApp ? "omit" : "same-origin" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (!tauri) return name;
  return tauri<string>("save_attachment", { name, dataB64: bytesToBase64(bytes) });
}

/** Open an http/https link in the user's default browser. */
export async function openUrl(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  if (tauri) {
    try {
      await tauri<void>("open_url", { url });
      return;
    } catch { /* fall through */ }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Ask the browser for notification permission once the user is signed in (no-op in the Windows app). */
export function requestNotifications(): void {
  if (tauri) return;
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    void Notification.requestPermission().catch(() => {});
  }
}

/** Show a device notification for newly arrived mail. */
export async function notify(title: string, body: string): Promise<void> {
  if (tauri) {
    try {
      await tauri<void>("notify", { title, body });
    } catch { /* ignore */ }
    return;
  }
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    try {
      const n = new Notification(title, { body, tag: `letterbox-${Date.now()}` });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* ignore */ }
  }
}

