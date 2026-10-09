// Bringing 2FA accounts in from other apps. Every importer returns plain OtpEntry values and a list
// of what it had to skip, in words a person can act on; nothing here touches storage.
import { base32Encode, normalizeEntry, parseOtpauth, type Algorithm, type OtpEntry } from "@marobotic/otp";

export type ImportResult = { entries: OtpEntry[]; skipped: string[]; batch?: { index: number; size: number; id: number } };

// ---------------------------------------------------------------- Google Authenticator
// "Transfer accounts" shows one or more QR codes holding otpauth-migration://offline?data=<base64>,
// a protobuf MigrationPayload:
//   1 repeated OtpParameters { 1 bytes secret, 2 string name, 3 string issuer, 4 Algorithm,
//                              5 DigitCount, 6 OtpType, 7 int64 counter }
//   2 version  3 batch_size  4 batch_index  5 batch_id
type Field = { no: number; wire: number; value: bigint | Uint8Array };

function* fields(buf: Uint8Array): Generator<Field> {
  let i = 0;
  const varint = (): bigint => {
    let shift = 0n, out = 0n;
    for (;;) {
      if (i >= buf.length) throw new Error("the export is cut off");
      const b = buf[i++]!;
      out |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return out;
      shift += 7n;
      if (shift > 63n) throw new Error("the export is not a Google Authenticator export");
    }
  };
  while (i < buf.length) {
    const key = Number(varint());
    const no = key >>> 3, wire = key & 7;
    if (wire === 0) yield { no, wire, value: varint() };
    else if (wire === 2) {
      const len = Number(varint());
      if (i + len > buf.length) throw new Error("the export is cut off");
      yield { no, wire, value: buf.subarray(i, i + len) };
      i += len;
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else throw new Error("the export is not a Google Authenticator export");
  }
}

const text = (v: bigint | Uint8Array) => (v instanceof Uint8Array ? new TextDecoder().decode(v) : "");
const ALGS: Record<number, Algorithm | undefined> = { 0: "SHA1", 1: "SHA1", 2: "SHA256", 3: "SHA512" };

function fromBase64Loose(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function importGoogleMigration(uri: string): ImportResult {
  const u = new URL(uri.trim());
  if (u.protocol !== "otpauth-migration:") throw new Error("not a Google Authenticator export (otpauth-migration://)");
  const data = u.searchParams.get("data");
  if (!data) throw new Error("the export link has no data");
  const out: ImportResult = { entries: [], skipped: [] };
  const batch = { index: 0, size: 1, id: 0 };
  for (const f of fields(fromBase64Loose(data))) {
    if (f.no === 3 && typeof f.value === "bigint") batch.size = Number(f.value);
    if (f.no === 4 && typeof f.value === "bigint") batch.index = Number(f.value);
    if (f.no === 5 && typeof f.value === "bigint") batch.id = Number(BigInt.asIntN(32, f.value));
    if (f.no !== 1 || !(f.value instanceof Uint8Array)) continue;
    let secret: Uint8Array = new Uint8Array(), name = "", issuer = "", alg = 1, digits = 1, type = 2, counter = 0;
    for (const p of fields(f.value)) {
      if (p.no === 1 && p.value instanceof Uint8Array) secret = p.value;
      else if (p.no === 2) name = text(p.value);
      else if (p.no === 3) issuer = text(p.value);
      else if (p.no === 4 && typeof p.value === "bigint") alg = Number(p.value);
      else if (p.no === 5 && typeof p.value === "bigint") digits = Number(p.value);
      else if (p.no === 6 && typeof p.value === "bigint") type = Number(p.value);
      else if (p.no === 7 && typeof p.value === "bigint") counter = Number(p.value);
    }
    // Google writes the label as "Issuer:account" (or just the account).
    const account = issuer && name.startsWith(`${issuer}:`) ? name.slice(issuer.length + 1) : name.includes(":") && !issuer ? name.split(/:(.*)/s)[1]! : name;
    const who = `${issuer || "?"} (${account.trim() || "no name"})`;
    const algorithm = ALGS[alg];
    if (!algorithm) { out.skipped.push(`${who}: uses MD5, which no app should still use - set up 2FA for it again`); continue; }
    if (!secret.length) { out.skipped.push(`${who}: no secret in the export`); continue; }
    out.entries.push(normalizeEntry({
      type: type === 1 ? "hotp" : "totp",
      issuer: issuer || (name.includes(":") ? name.split(":")[0]! : ""),
      account,
      secret: base32Encode(secret),
      algorithm,
      digits: digits === 2 ? 8 : 6,
      counter,
    }));
  }
  if (batch.size > 1) out.batch = batch;
  return out;
}

// ---------------------------------------------------------------- anything with otpauth:// links
/** Text holding otpauth:// and otpauth-migration:// links: a backup file, a list, QR contents. */
export function importText(textIn: string): ImportResult {
  const out: ImportResult = { entries: [], skipped: [] };
  const links = textIn.match(/otpauth(?:-migration)?:\/\/[^\s"'<>]+/g) ?? [];
  if (!links.length) out.skipped.push("no otpauth:// links found");
  for (const link of links) {
    try {
      if (link.startsWith("otpauth-migration:")) {
        const r = importGoogleMigration(link);
        out.entries.push(...r.entries);
        out.skipped.push(...r.skipped);
        if (r.batch) out.batch = r.batch;
      } else out.entries.push(parseOtpauth(link));
    } catch (e) {
      out.skipped.push(`${link.slice(0, 40)}...: ${(e as Error).message}`);
    }
  }
  return dedupe(out);
}

/** The same account imported twice (two QR batches, a re-scan) is kept once. */
export function dedupe(r: ImportResult): ImportResult {
  const seen = new Set<string>();
  return { ...r, entries: r.entries.filter((e) => { const k = `${e.secret}|${e.issuer}|${e.account}`; if (seen.has(k)) return false; seen.add(k); return true; }) };
}

export * from "./passwords.ts";
