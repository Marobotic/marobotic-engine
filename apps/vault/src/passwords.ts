// Passwords: the generator, and which 2FA code belongs to which login.
import type { OtpEntry } from "@marobotic/otp";

const LOWER = "abcdefghijkmnopqrstuvwxyz";   // no l: confused with 1 and I
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";    // no I, O
const DIGITS = "23456789";                   // no 0, 1
const SYMBOLS = "!@#$%^&*-_=+?";

/** A random index below n with no modulo bias (crypto.getRandomValues, rejection sampling). */
function randomBelow(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % n;
  }
}

/** A password with at least one of every chosen kind of character, in random places. */
export function generatePassword(opts: { length?: number; symbols?: boolean } = {}): string {
  const length = Math.max(8, Math.min(128, opts.length ?? 20));
  const sets = [LOWER, UPPER, DIGITS, ...(opts.symbols === false ? [] : [SYMBOLS])];
  const all = sets.join("");
  const chars = sets.map((s) => s[randomBelow(s.length)]!);
  while (chars.length < length) chars.push(all[randomBelow(all.length)]!);
  for (let i = chars.length - 1; i > 0; i--) {         // Fisher-Yates, so the guaranteed ones aren't first
    const j = randomBelow(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

/** "https://www.github.com/login" -> "github.com"; anything that isn't a URL comes back as typed. */
export function hostOf(url: string): string {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

const word = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The 2FA code that belongs to a login: same site (host or its main name) or same name, and the
 *  same account when both say one. Undefined when nothing clearly matches. */
export function matchTotp<T extends { otp: OtpEntry }>(login: { name: string; urls: string[]; username: string }, codes: T[]): T | undefined {
  const keys = new Set<string>();
  for (const u of login.urls) {
    const host = hostOf(u);
    keys.add(word(host));
    const parts = host.split(".");
    if (parts.length >= 2) keys.add(word(parts[parts.length - 2]!));   // accounts.zoho.com -> zoho
  }
  keys.add(word(login.name));
  keys.delete("");
  const hits = codes.filter((c) => keys.has(word(c.otp.issuer)) || [...keys].some((k) => k.length > 3 && word(c.otp.issuer).includes(k)));
  if (hits.length <= 1) return hits[0];
  const user = login.username.toLowerCase();
  return hits.find((c) => c.otp.account.toLowerCase() === user) ?? undefined;
}
