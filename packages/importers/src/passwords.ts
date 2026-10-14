// Passwords from other managers' CSV exports. Every app names its columns differently, so columns are
// matched by meaning; one reader covers Chrome/Brave/Edge, Firefox, Bitwarden, Apple Passwords,
// 1Password, LastPass, Proton Pass, Dashlane and most others that export CSV.
import { parseOtpauth, normalizeEntry, type OtpEntry } from "@marobotic/otp";

/** A login from another app. `email` and `username` are kept apart when the file has both (Proton Pass does). */
export type LoginImport = { name: string; urls: string[]; username: string; email: string; password: string; notes: string; totp?: OtpEntry };
export type PasswordImportResult = { logins: LoginImport[]; skipped: string[]; source: string };

/** RFC 4180 CSV: quoted fields may hold commas, quotes ("") and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  const t = text.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (quoted) {
      if (c === '"') {
        if (t[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

// Column names by meaning, lower case. First match wins.
const COLUMNS = {
  name: ["name", "title", "login_name", "item name"],
  url: ["url", "login_uri", "website", "web site", "uri", "urls", "login url", "hostname", "origin_url"],
  username: ["username", "login_username", "login", "user", "user name", "login name"],
  email: ["email", "login_email", "e-mail", "email address"],
  password: ["password", "login_password", "pass"],
  notes: ["notes", "note", "extra", "comments", "comment"],
  totp: ["totp", "login_totp", "otpauth", "otp", "one-time password", "2fa", "otp secret"],
  type: ["type"],
} as const;

function sourceOf(header: string[]): string {
  const h = header.join(",");
  if (h.includes("login_uri") && h.includes("login_password")) return "Bitwarden";
  if (h.includes("httprealm") || h.includes("formactionorigin")) return "Firefox";
  if (h.includes("otpauth") && h.includes("title")) return "Apple Passwords";
  if (h.includes("grouping") && h.includes("extra")) return "LastPass";
  if (h === "name,url,username,password,note" || h === "name,url,username,password") return "Chrome, Brave or Edge";
  return "CSV";
}

const hostName = (u: string) => { try { return new URL(/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, ""); } catch { return u; } };

function totpFrom(raw: string, name: string, username: string): OtpEntry | undefined {
  const v = raw.trim();
  if (!v) return undefined;
  if (v.startsWith("otpauth://")) return parseOtpauth(v);
  // Bitwarden and others may hold just the base32 secret
  return normalizeEntry({ secret: v, issuer: name, account: username });
}

export function importPasswordCsv(text: string): PasswordImportResult {
  const rows = parseCsv(text);
  const out: PasswordImportResult = { logins: [], skipped: [], source: "CSV" };
  if (rows.length < 2) { out.skipped.push("the file has no rows under its header"); return out; }
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  out.source = sourceOf(header);
  const col = (k: keyof typeof COLUMNS) => { for (const n of COLUMNS[k]) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
  const at = { name: col("name"), url: col("url"), username: col("username"), email: col("email"), password: col("password"), notes: col("notes"), totp: col("totp"), type: col("type") };
  if (at.password < 0) { out.skipped.push(`no password column (columns: ${header.join(", ")})`); return out; }
  rows.slice(1).forEach((r, n) => {
    const get = (i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
    const line = n + 2;
    if (at.type >= 0 && get(at.type) && !/^login$/i.test(get(at.type))) { out.skipped.push(`row ${line}: a ${get(at.type)}, not a login (only logins come in for now)`); return; }
    const password = at.password >= 0 ? (r[at.password] ?? "") : "";
    const url = get(at.url);
    let username = get(at.username), email = get(at.email);
    // One column holding an email (a "username" that is one, or only an email): it's the email.
    if (!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)) { email = username; username = ""; }
    if (!password && !username && !email) { out.skipped.push(`row ${line}: no username, email or password`); return; }
    const urls = url ? url.split(/[\s,]+/).filter(Boolean) : [];
    const name = get(at.name) || (urls[0] ? hostName(urls[0]) : "") || email || username || "Untitled";
    let totp: OtpEntry | undefined;
    try { totp = totpFrom(get(at.totp), name, email || username); } catch (e) { out.skipped.push(`row ${line} (${name}): its 2FA key was not readable - ${(e as Error).message}`); }
    out.logins.push({ name, urls, username, email, password, notes: get(at.notes), totp });
  });
  return out;
}
