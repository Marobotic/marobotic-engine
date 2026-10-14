// Which saved logins and 2FA codes belong to a web page or an app. This is the phishing guard for the
// browser extension and Android autofill: a login is only offered on its own site (the same registrable
// domain, or one on the short list of sites that share one sign-in), never on a look-alike.
import type { OtpEntry } from "@marobotic/otp";
import { hostOf, matchTotp } from "./passwords.ts";
import { siteOf } from "./icons.ts";

// Second-level suffixes where the registrable domain is three labels ("bbc.co.uk"), not two. Not the
// whole Public Suffix List, but every one a person here is likely to sign in under.
export const MULTI = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "co.nz", "org.nz", "net.nz",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "co.kr", "or.kr", "com.br", "com.mx", "com.ar", "com.tr", "com.cn",
  "com.hk", "com.sg", "com.my", "com.ph", "com.tw", "co.in", "net.in", "org.in", "co.za", "co.il",
  "com.pl", "com.es", "com.pt", "com.ua", "com.ru", "co.id", "or.id", "github.io", "gitlab.io", "pages.dev",
  "vercel.app", "netlify.app", "herokuapp.com", "azurewebsites.net", "cloudfront.net", "blogspot.com",
]);

// Sites that sign in with one account under several domains.
export const SAME_SIGN_IN: string[][] = [
  ["square-enix.com", "square-enix-games.com", "finalfantasyxiv.com"],
  ["google.com", "youtube.com", "gmail.com"],
  ["microsoft.com", "live.com", "microsoftonline.com", "outlook.com", "xbox.com", "office.com", "skype.com"],
  ["apple.com", "icloud.com"],
  ["amazon.com", "amazon.co.uk", "amazon.de", "aws.amazon.com"],
  ["steampowered.com", "steamcommunity.com"],
  ["battle.net", "blizzard.com"],
  ["epicgames.com", "unrealengine.com"],
  ["proton.me", "protonmail.com"],
  ["github.com", "githubusercontent.com"],
  ["discord.com", "discordapp.com"],
  ["x.com", "twitter.com"],
  ["facebook.com", "messenger.com", "instagram.com"],
  ["ea.com", "origin.com"],
];
const GROUP = new Map<string, string>();
for (const g of SAME_SIGN_IN) for (const d of g) GROUP.set(d, g[0]!);

/** "accounts.secure.example.co.uk" -> "example.co.uk". IP addresses and "localhost" come back whole. */
export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  if (!h.includes(".") || /^\d+(\.\d+){3}$/.test(h) || h.startsWith("[")) return h;
  const parts = h.split(".");
  const last2 = parts.slice(-2).join(".");
  return parts.length > 2 && MULTI.has(last2) ? parts.slice(-3).join(".") : last2;
}

/** The sign-in identity of a site: its registrable domain, or the first of its group. */
export function siteKey(hostOrUrl: string): string {
  const reg = registrableDomain(hostOf(hostOrUrl));
  return GROUP.get(reg) ?? reg;
}

/** True when a login saved for `saved` (a URL or bare host) may be offered on `pageUrl`. */
export function sameSite(saved: string, pageUrl: string): boolean {
  const a = hostOf(saved), b = hostOf(pageUrl);
  if (!a || !b || a.includes(" ")) return false;
  return siteKey(a) === siteKey(b);
}

/** The web pages a password may be filled on: http(s) only, and never http on a site saved as https. */
export function fillableUrl(pageUrl: string): boolean {
  try { const u = new URL(pageUrl); return u.protocol === "https:" || (u.protocol === "http:" && /^(localhost|127\.0\.0\.1|192\.168\.|10\.)/.test(u.hostname)); }
  catch { return false; }
}

type LoginLike = { name: string; urls: string[]; username: string; totpId?: string };

/** The saved logins for a page, best first (an exact host before the rest of the site). */
export function loginsFor<T extends { data: LoginLike }>(pageUrl: string, logins: T[]): T[] {
  const host = hostOf(pageUrl);
  const exact = (l: T) => l.data.urls.some((u) => hostOf(u) === host);
  return logins.filter((l) => l.data.urls.some((u) => sameSite(u, pageUrl)) || (!l.data.urls.length && namedFor(l.data.name, pageUrl)))
    .sort((a, b) => Number(exact(b)) - Number(exact(a)));
}

/** A login saved with no address (some exports leave it out) belongs to the site its name names, exactly:
 *  "Discord - Talk, Play" is discord.com, never discord.xyz or a look-alike. */
export function namedSite(name: string): string {
  const site = siteOf({ name });
  return site ? siteKey(site) : "";
}
const namedFor = (name: string, pageUrl: string) => { const s = namedSite(name); return !!s && s === siteKey(pageUrl); };

const word = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The 2FA codes for a page: those linked to (or matching) its logins first, then any whose service
 *  name is the site's name ("GitHub" on github.com). */
export function codesFor<C extends { id: string; data: { otp: OtpEntry } }, L extends { id?: string; data: LoginLike }>(pageUrl: string, codes: C[], logins: L[]): C[] {
  const out: C[] = [];
  const add = (c: C | undefined) => { if (c && !out.includes(c)) out.push(c); };
  for (const l of loginsFor(pageUrl, logins)) {
    if (l.id) add(codes.find((c) => c.id === l.id));   // the login's own code (see allCodes)
    add(l.data.totpId ? codes.find((c) => c.id === l.data.totpId) : undefined);
    add(matchTotp(l.data, codes.map((c) => ({ otp: c.data.otp, c })))?.c);
  }
  const key = siteKey(pageUrl);
  const name = word(key.split(".")[0] ?? "");
  for (const c of codes) {
    const iss = word(c.data.otp.issuer);
    if (!iss) continue;
    if (iss === name || iss === word(key) || (name.length > 3 && iss.includes(name))) add(c);
    else if (siteKey(c.data.otp.issuer) === key && c.data.otp.issuer.includes(".")) add(c);
  }
  return out;
}

/** Words an Android app's package name gives for matching ("com.github.android" -> ["github"]). */
export function packageWords(pkg: string): string[] {
  const skip = new Set(["com", "org", "net", "io", "app", "apps", "android", "mobile", "client", "www", "co", "uk", "de", "dev", "main", "release", "prod", "lite"]);
  return pkg.toLowerCase().split(".").map(word).filter((w) => w.length > 2 && !skip.has(w));
}
