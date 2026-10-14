// One entry per account: a login keeps its own one-time code (username, password and 2FA together).
// Codes saved on their own before, or imported separately, move into the one login they clearly belong
// to; a code with no login (or that two logins could both claim) stays a 2FA entry of its own.
import { matchTotp } from "./passwords.ts";
import type { Item, LoginItem, TotpItem, Vault } from "./vault.ts";

type LoginRow = Item & { data: LoginItem };
type TotpRow = Item & { data: TotpItem };

const sameAccount = (code: string, user: string) => {
  const c = code.trim().toLowerCase(), u = user.trim().toLowerCase();
  return !c || !u || c === u || c === u.split("@")[0] || u === c.split("@")[0];
};

/** Moves codes into their logins. Returns code id -> login id for each code that moved. */
export function mergeCodesIntoLogins(vault: Vault): Map<string, string> {
  const logins = vault.list("login") as LoginRow[];
  const codes = vault.list("totp") as TotpRow[];
  const claims = new Map<string, LoginRow[]>();
  for (const l of logins) {
    if (l.data.otp) continue;
    const linked = l.data.totpId ? codes.find((c) => c.id === l.data.totpId) : undefined;
    const matched = linked ?? matchTotp(l.data, codes.map((c) => ({ otp: c.data.otp, c })))?.c;
    if (matched && (linked || sameAccount(matched.data.otp.account, l.data.username) || (!!l.data.email && sameAccount(matched.data.otp.account, l.data.email)))) claims.set(matched.id, [...(claims.get(matched.id) ?? []), l]);
  }
  const moved = new Map<string, string>();
  for (const [codeId, ls] of claims) {
    if (ls.length !== 1) continue;
    const code = codes.find((c) => c.id === codeId)!;
    const { totpId: _old, ...login } = ls[0]!.data;
    vault.update(ls[0]!.id, { ...login, otp: code.data.otp, ...(login.favorite || code.data.favorite ? { favorite: true } : {}) });
    vault.remove(codeId);
    moved.set(codeId, ls[0]!.id);
  }
  return moved;
}

/** Every one-time code: the 2FA entries, and each login's own code as a row with the login's id. */
export function allCodes(vault: Vault): TotpRow[] {
  const own = vault.list("totp") as TotpRow[];
  const inLogins = (vault.list("login") as LoginRow[]).filter((l) => l.data.otp).map((l) => ({
    id: l.id, updated: l.updated,
    data: { type: "totp", otp: l.data.otp!, label: l.data.name, favorite: l.data.favorite, inLogin: true } as TotpItem,
  }));
  return [...own, ...inLogins];
}
