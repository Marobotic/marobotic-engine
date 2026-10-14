// What the pages, the popup and the background say to each other.
export type LoginHit = { id: string; name: string; username: string; email: string; site: string };
export type CodeHit = { id: string; issuer: string; account: string; code: string; remaining: number; period: number };
export type PasskeyHit = { id: string; rpId: string; username: string; displayName: string };
export type Matches = { logins?: LoginHit[]; codes?: CodeHit[]; passkeys?: PasskeyHit[]; locked?: boolean; error?: string; site?: string };
export type Offer = { id: string; site: string; username: string; state: "new" | "changed"; name?: string };

export type Settings = {
  suggest: boolean;        // logins under sign-in fields
  suggestCodes: boolean;   // 2FA codes under code fields
  suggestPasswords: boolean; // a strong password under new-password fields
  offerSave: boolean;      // "Save this login?" after signing in
  passkeys: boolean;       // make and use passkeys in Vault
  takeover: boolean;       // the browser's own password saving is off
  lockAfter: number;       // minutes without use; 0 = when the browser closes
};
export const DEFAULTS: Settings = { suggest: true, suggestCodes: true, suggestPasswords: true, offerSave: true, passkeys: true, takeover: true, lockAfter: 0 };

/** One entry in the popup's lists. */
export type Summary = {
  id: string; kind: "login" | "totp" | "passkey"; title: string; sub: string; site: string; favorite?: boolean;
  code?: string; remaining?: number; period?: number;
};
export type Detail =
  | { kind: "login"; id: string; name: string; username: string; email: string; password: string; urls: string[]; notes: string; site: string; code?: CodeHit; favorite?: boolean }
  | { kind: "totp"; id: string; issuer: string; account: string; site: string; code: CodeHit; favorite?: boolean;
      name: string; service: string; digits: number; period: number; algorithm: string; notes: string }
  | { kind: "passkey"; id: string; rpId: string; rpName: string; username: string; displayName: string; created?: number; site: string };
/** An edited 2FA code (vault/src/codes.ts); an empty `secret` keeps the key. */
export type CodeInput = { id: string; name: string; issuer: string; account: string; secret: string; digits: number; period: number; algorithm: "SHA1" | "SHA256" | "SHA512"; notes: string };
export type LoginInput = { id?: string; name: string; username: string; email: string; password: string; urls: string[]; notes: string; otpKey?: string; removeOtp?: boolean };
export type State = { state: "signedOut" | "locked" | "open"; email?: string; synced?: "synced" | "offline" | "signedOut"; settings: Settings };

/** A WebAuthn call from a page, with every binary field as base64url. */
export type PkCreate = {
  rp: { id?: string; name?: string }; user: { id: string; name: string; displayName?: string }; challenge: string;
  pubKeyCredParams: { type: string; alg: number }[]; excludeCredentials?: { id: string }[];
};
export type PkGet = { rpId?: string; challenge: string; allowCredentials?: { id: string }[] };

export type Msg =
  // pages
  | { t: "match" } | { t: "fill"; id: string } | { t: "code"; id: string }
  | { t: "submitted"; username: string; password: string } | { t: "lastUser"; username: string }
  | { t: "pending" } | { t: "save"; id: string; decision: "save" | "never" } | { t: "openPopup" } | { t: "settings" }
  | { t: "pkCheck"; kind: "create" | "get"; options: PkCreate | PkGet }
  | { t: "pkCreate"; options: PkCreate } | { t: "pkGet"; options: PkGet; id: string }
  // the popup
  | { t: "state" } | { t: "signIn"; email: string; password: string } | { t: "lock" } | { t: "signOut" } | { t: "sync" }
  | { t: "list"; q: string; site: boolean } | { t: "item"; id: string } | { t: "saveLogin"; login: LoginInput } | { t: "saveCode"; code: CodeInput } | { t: "delete"; id: string }
  | { t: "pin"; id: string } | { t: "fillTab"; id: string } | { t: "setSettings"; settings: Partial<Settings> }
  | { t: "never" } | { t: "unnever"; site: string } | { t: "generate" };

export const send = <T = unknown>(m: Msg): Promise<T> => chrome.runtime.sendMessage(m) as Promise<T>;
