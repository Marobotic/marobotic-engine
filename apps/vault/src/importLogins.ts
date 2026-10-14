// Logins from another password manager into the vault. Importing the same file again adds nothing twice,
// and gives logins imported before without their email (older Vault versions dropped it) their email.
import type { PasswordImportResult } from "@marobotic/importers";
import type { Item, LoginItem, TotpItem, Vault } from "./vault.ts";

type LoginRow = Item & { data: LoginItem };

export function importLogins(vault: Vault, res: PasswordImportResult) {
  const logins = () => vault.list("login") as LoginRow[];
  const lower = (x: string) => x.toLowerCase();
  const key = (name: string, who: string) => lower(`${name}|${who}`);
  const haveLogin = new Set(logins().flatMap((i) => [key(i.data.name, i.data.username), key(i.data.name, i.data.email ?? "")]));
  const haveCode = new Set([
    ...(vault.list("totp") as (Item & { data: TotpItem })[]).map((i) => i.data.otp.secret),
    ...logins().flatMap((i) => (i.data.otp ? [i.data.otp.secret] : [])),
  ]);
  let added = 0, already = 0, withCode = 0, filled = 0;
  for (const l of res.logins) {
    // The same login from an earlier import without its email: no username, the username column, or
    // the email kept as the username. It gets the email now.
    const earlier = l.email ? logins().find((i) => !i.data.email && i.data.name === l.name && i.data.password === l.password
      && (!i.data.username || i.data.username === l.username || lower(i.data.username) === lower(l.email))) : undefined;
    if (earlier) {
      const username = earlier.data.username && lower(earlier.data.username) !== lower(l.email) ? earlier.data.username : l.username;
      vault.update(earlier.id, { ...earlier.data, email: l.email, username });
      haveLogin.add(key(l.name, l.email));
      filled++;
      continue;
    }
    const known = (l.username && haveLogin.has(key(l.name, l.username))) || (l.email && haveLogin.has(key(l.name, l.email)))
      || (!l.username && !l.email && haveLogin.has(key(l.name, "")));
    if (known) { already++; continue; }
    const otp = l.totp && !haveCode.has(l.totp.secret) ? l.totp : undefined;
    if (otp) { haveCode.add(otp.secret); withCode++; }
    vault.add({ type: "login", name: l.name, urls: l.urls, username: l.username, ...(l.email ? { email: l.email } : {}), password: l.password, notes: l.notes, ...(otp ? { otp } : {}) });
    haveLogin.add(key(l.name, l.username));
    if (l.email) haveLogin.add(key(l.name, l.email));
    added++;
  }
  return { added, already, withCode, filled };
}
