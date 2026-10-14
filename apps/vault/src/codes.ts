// Editing a 2FA code: its name, the service and account it's for, and (rarely) its setup key and
// settings. The same rules in the app and the browser extension. A login's own code (one entry per
// account) is edited inside its login.
import { base32Decode, normalizeEntry, type Algorithm, type OtpEntry } from "@marobotic/otp";
import type { Item, Vault } from "./vault.ts";

export type CodeEdit = {
  /** What the list shows; empty shows the service. Ignored for a login's own code (it shows the login's name). */
  name?: string;
  issuer: string;
  account: string;
  /** A new setup key; empty keeps the one it has. */
  secret?: string;
  digits?: number;
  period?: number;
  algorithm?: Algorithm;
  notes?: string;
};

/** A setup key as typed ("ghbe ahfh-..."), checked: letters A-Z and digits 2-7 only, and long enough. */
export function cleanKey(text: string): string {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  if (/[^A-Z2-7]/.test(clean)) throw new Error("Setup keys only use the letters A-Z and the digits 2-7.");
  if (base32Decode(clean).length < 10) throw new Error("That setup key is too short (they are usually 16 or 32 characters).");
  return clean;
}

/** Saves the edit to the code `id` (a 2FA entry, or a login with its own code). Throws with a message
 *  to show when the input can't be a code. */
export function editCode(vault: Vault, id: string, e: CodeEdit): Item {
  const it = vault.get(id);
  const old: OtpEntry | undefined = it?.data.type === "totp" ? it.data.otp : it?.data.type === "login" ? it.data.otp : undefined;
  if (!it || !old) throw new Error("That 2FA code is gone (deleted on another device?).");
  const otp = normalizeEntry({
    ...old,
    issuer: e.issuer, account: e.account,
    secret: e.secret?.trim() ? cleanKey(e.secret) : old.secret,
    digits: e.digits ?? old.digits, period: e.period ?? old.period, algorithm: e.algorithm ?? old.algorithm,
  });
  if (it.data.type === "login") return vault.update(id, { ...it.data, otp });
  if (it.data.type !== "totp") throw new Error("not a 2FA code");
  const { label: _l, notes: _n, ...rest } = it.data;
  const name = e.name?.trim() ?? "";
  const notes = (e.notes ?? it.data.notes ?? "").trim();
  return vault.update(id, { ...rest, otp, ...(name && name !== otp.issuer ? { label: name } : {}), ...(notes ? { notes } : {}) });
}
