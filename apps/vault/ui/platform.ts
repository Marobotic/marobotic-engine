// What Vault needs from the device. Inside the app (Tauri) it goes through the native side; in a plain
// browser (for development) it falls back to localStorage, and XIVLauncher can't be reached.
type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type Listen = (event: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>;
const T = (globalThis as { __TAURI__?: { core?: { invoke?: Invoke }; event?: { listen?: Listen } } }).__TAURI__;
const tauri = T?.core?.invoke;

export const inApp = Boolean(tauri);
export const isAndroid = /Android/i.test(navigator.userAgent);
export const isIos = /iPhone|iPad/i.test(navigator.userAgent);
export const isMobile = isAndroid || isIos;
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

/** Windows: Vault steps aside and you drag a box around the QR code on screen; the text of the code(s)
 *  in it comes back, or null when you cancel (Esc). */
export async function scanScreen(): Promise<string[] | null> {
  if (!isDesktopApp) return [];
  return tauri!<string[] | null>("scan_screen");
}

/** Windows: open otpauth:// links (an "add to authenticator" link on a web page) with Vault. */
export async function setLinkHandler(on: boolean): Promise<void> {
  if (isDesktopApp) await tauri!<void>("set_link_handler", { on });
}

/** Something from the native side: "link" is an otpauth:// link Vault was opened with. */
export function on(event: string, cb: (payload: unknown) => void) {
  void T?.event?.listen?.(event, (e) => cb(e.payload));
}

/** The otpauth:// link Vault was started with, once. */
export async function takeLaunchLink(): Promise<string | null> {
  if (android) return android.takeLink() || null;
  if (isDesktopApp) return tauri!<string | null>("take_launch_link");
  return null;
}

/** Windows: the browsers' own password managers (and address/card autofill) off or back on. Asks
 *  for administrator approval once (browser policies are machine-wide). */
export async function setBrowserLockdown(on: boolean): Promise<string[]> {
  if (!isDesktopApp) return [];
  return tauri!<string[]>("set_browser_lockdown", { on });
}
/** Each installed browser, and whether its own password manager is off. */
export async function browserLockdownState(): Promise<[string, boolean][]> {
  if (!isDesktopApp) return [];
  return tauri!<[string, boolean][]>("browser_lockdown_state");
}

export type ExtensionBrowser = { id: string; name: string; folder: string; installed: boolean };
export const extensionBrowsers = (): Promise<ExtensionBrowser[]> => isDesktopApp ? tauri!<ExtensionBrowser[]>("extension_browsers") : Promise.resolve([]);
export const openExtensions = (id: string): Promise<void> => tauri!<void>("open_extensions", { id });
export const openExtensionFolder = (): Promise<void> => tauri!<void>("open_extension_folder");

/** Bring the window to the front (an otpauth link). */
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
  takePasskeys(): string;
  takeLink(): string;
  takeUses(): string;                // JSON [loginId, ...]: logins picked in Android autofill since last asked
  autofillState(): string;           // "on" | "off" | "unsupported"
  autofillProvider(): string;        // the app filling passwords now ("Vault", "Proton Pass", "")
  passkeyProviderIsVault(): boolean;
  keptReady(): boolean;
  keepReady(): void;
  openAutofillSettings(): void;
  overlayOn(): boolean;              // Vault's own list in apps like Discord (an accessibility service)
  openOverlaySettings(): void;
  browsers(): string;                // JSON [{ name, pkg, how }] of installed browsers that need a setting of their own
  openApp(pkg: string): void;
  unlockState(): string;             // "unavailable" | "ready" | "saved"
  unlockClear(): void;
  unlockSave(id: number, email: string, password: string): void;
  unlockOpen(id: number): void;
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
/** Passkeys Android's credential manager made in Vault (items ready for the vault). */
export function takePasskeys(): Record<string, unknown>[] {
  if (!android) return [];
  try { return JSON.parse(android.takePasskeys() || "[]") as Record<string, unknown>[]; } catch { return []; }
}
/** Logins picked in Android autofill (one id per pick), for the usage counts (src/usage.ts). */
export function takeUses(): string[] {
  if (!android) return [];
  try { return JSON.parse(android.takeUses() || "[]") as string[]; } catch { return []; }
}
export const autofillState = () => (android ? android.autofillState() : "unsupported");
/** Android may pause Vault in the background (Samsung freezes it): autofill then answers late or not at all. */
export const keptReady = () => { try { return android ? android.keptReady() : true; } catch { return true; } };
export const keepReady = () => android?.keepReady();
export const autofillProvider = () => (android ? android.autofillProvider() : "");
export const passkeysOnVault = () => (android ? android.passkeyProviderIsVault() : false);
export const openAutofillSettings = () => android?.openAutofillSettings();
export const overlayOn = () => { try { return android ? android.overlayOn() : true; } catch { return true; } };
export const openOverlaySettings = () => android?.openOverlaySettings();
export type Browser = { name: string; pkg: string; how: string };
export const browsers = (): Browser[] => { try { return android ? (JSON.parse(android.browsers() || "[]") as Browser[]) : []; } catch { return []; } };
export const openApp = (pkg: string) => android?.openApp(pkg);

// ------------------------------------------------------------------ Android: unlock with fingerprint / screen lock
// The account password, sealed by the phone's keystore behind a fingerprint, face or the phone's PIN.
let asked = 0;
function nativeAnswer<T>(start: (id: number) => void): Promise<T> {
  const id = ++asked;
  return new Promise((done) => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail as T & { id: number };
      if (d.id !== id) return;
      removeEventListener("vault-native", on);
      done(d);
    };
    addEventListener("vault-native", on);
    start(id);
  });
}
// iPhone: the same, behind Face ID in the Keychain (quick_unlock.rs). Whether it's on is remembered
// here so the sign-in screen knows straight away; the Keychain item is what really unlocks.
const ios = tauri && isIos;
const IOS_ON = "vault.quickUnlock";
const iosOn = (on?: boolean) => {
  try {
    if (on === true) localStorage.setItem(IOS_ON, "1");
    else if (on === false) localStorage.removeItem(IOS_ON);
    return localStorage.getItem(IOS_ON) === "1";
  } catch { return false; }
};
export const quickUnlock = {
  /** What the phone unlocks with, for buttons and settings. */
  label: ios ? "Face ID" : "fingerprint or screen lock",
  /** "unavailable" (no fingerprint/screen lock, or not a phone), "ready", or "saved". */
  state: (): string => (android ? android.unlockState() : ios ? (iosOn() ? "saved" : "ready") : "unavailable"),
  clear: () => {
    if (android) return android.unlockClear();
    if (ios) { iosOn(false); void tauri("unlock_clear"); }
  },
  save: (email: string, password: string): Promise<{ ok: boolean; error: string }> => {
    if (android) return nativeAnswer((id) => android!.unlockSave(id, email, password));
    return tauri!<void>("unlock_save", { email, password }).then(
      () => (iosOn(true), { ok: true, error: "" }),
      (e) => ({ ok: false, error: String(e) }),
    );
  },
  open: (): Promise<{ email?: string; password?: string; error?: string }> => {
    if (android) return nativeAnswer((id) => android!.unlockOpen(id));
    return tauri!<{ email: string; password: string }>("unlock_open").catch((e) => {
      const error = String(e);
      if (error !== "gone") return { error };
      iosOn(false);
      return { error: "Face ID unlock was turned off on this iPhone. Sign in with your password to turn it on again." };
    });
  },
};
