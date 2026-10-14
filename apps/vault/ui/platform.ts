// What Vault needs from the device. Inside the app (Tauri) it goes through the native side; in a plain
// browser (for development) it falls back to localStorage, and XIVLauncher can't be reached.
type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type Listen = (event: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>;
const T = (globalThis as { __TAURI__?: { core?: { invoke?: Invoke }; event?: { listen?: Listen } } }).__TAURI__;
const tauri = T?.core?.invoke;

export const inApp = Boolean(tauri);
export const isAndroid = /Android/i.test(navigator.userAgent);
export const isMobile = isAndroid || /iPhone|iPad/i.test(navigator.userAgent);
/** The Windows app: the screen can be scanned, the browser extension can connect. */
export const isDesktopApp = inApp && !isMobile;

/** The sealed vault file (JSON text), or null before the first setup. */
export async function loadVault(): Promise<string | null> {
  if (tauri) return (await tauri<string | null>("load_vault")) ?? null;
  return localStorage.getItem("vault.dev.file");
}

/** Written whole after every change. It is already sealed: nothing readable reaches the disk. */
export async function saveVault(json: string): Promise<void> {
  if (tauri) return tauri<void>("save_vault", { json });
  localStorage.setItem("vault.dev.file", json);
}

/** One attempt at XIVLauncher's OTP endpoint. */
export async function xlSend(code: string, host: string): Promise<boolean> {
  if (tauri) return tauri<boolean>("xl_send", { code, host });
  return false;
}

/** Where the vault file lives, to show in settings. */
export async function vaultPath(): Promise<string> {
  if (tauri) return tauri<string>("vault_path");
  return "this browser's storage (development only)";
}

/** Windows: Vault steps aside, every screen is captured, and the text of each QR code on them comes back. */
export async function scanScreen(): Promise<string[]> {
  if (!isDesktopApp) return [];
  return tauri!<string[]>("scan_screen");
}

/** Windows: open otpauth:// links (an "add to authenticator" link on a web page) with Vault. */
export async function setLinkHandler(on: boolean): Promise<void> {
  if (isDesktopApp) await tauri!<void>("set_link_handler", { on });
}

/** Something from the native side: "link" (an otpauth:// link Vault was opened with) and "bridge"
 *  (a request from the browser extension). */
export function on(event: string, cb: (payload: unknown) => void) {
  void T?.event?.listen?.(event, (e) => cb(e.payload));
}

/** The otpauth:// link Vault was started with, once. */
export async function takeLaunchLink(): Promise<string | null> {
  if (android) return android.takeLink() || null;
  if (isDesktopApp) return tauri!<string | null>("take_launch_link");
  return null;
}

/** The answer to one browser-extension request. */
export async function bridgeReply(id: number, body: unknown): Promise<void> {
  if (isDesktopApp) await tauri!<void>("bridge_reply", { id, json: JSON.stringify(body) });
}

/** Bring the window to the front (an extension asking to pair, an otpauth link). */
export async function showWindow(): Promise<void> {
  if (isDesktopApp) await tauri!<void>("show_window");
}

// ------------------------------------------------------------------ Android: autofill and links
// MainActivity adds `VaultAndroid` to the page: the autofill service reads what Vault hands it here,
// and only while Vault is unlocked (it lives in memory, never on disk).
type AndroidBridge = {
  setAutofill(json: string): void;
  clearAutofill(): void;
  takeSaves(): string;
  takeLink(): string;
  autofillState(): string;           // "on" | "off" | "unsupported"
  openAutofillSettings(): void;
};
const android = (globalThis as { VaultAndroid?: AndroidBridge }).VaultAndroid;
export const hasAutofill = Boolean(android);

export function setAutofill(index: unknown | null) {
  if (!android) return;
  if (index) android.setAutofill(JSON.stringify(index)); else android.clearAutofill();
}
export type SaveRequest = { url: string; app: string; username: string; password: string };
export function takeSaves(): SaveRequest[] {
  if (!android) return [];
  try { return JSON.parse(android.takeSaves() || "[]") as SaveRequest[]; } catch { return []; }
}
export const autofillState = () => (android ? android.autofillState() : "unsupported");
export const openAutofillSettings = () => android?.openAutofillSettings();
