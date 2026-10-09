// What Vault needs from the device. Inside the app (Tauri) it goes through the native side; in a plain
// browser (for development) it falls back to localStorage, and XIVLauncher can't be reached.
type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
const tauri = (globalThis as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__?.core?.invoke;

export const inApp = Boolean(tauri);

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
