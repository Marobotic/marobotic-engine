// One-time codes (RFC 4226 HOTP, RFC 6238 TOTP) and otpauth:// links, on WebCrypto, so the same
// code runs in every app, the browser extensions and Node.

export type Algorithm = "SHA1" | "SHA256" | "SHA512";

export type OtpEntry = {
  type: "totp" | "hotp";
  issuer: string;          // "GitHub"
  account: string;         // "mi@marobotic.dev"
  secret: string;          // base32, upper case, no padding
  algorithm: Algorithm;
  digits: number;          // 6 or 8 (Steam's 5-letter codes later)
  period: number;          // TOTP seconds
  counter: number;         // HOTP
};

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  const out: number[] = [];
  let bits = 0, value = 0;
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error(`"${ch}" is not base32`);
    value = ((value << 5) | i) & 0xffff;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

export function base32Encode(bytes: Uint8Array): string {
  let out = "", bits = 0, value = 0;
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

const HASH = { SHA1: "SHA-1", SHA256: "SHA-256", SHA512: "SHA-512" } as const;

export async function hotp(secret: Uint8Array, counter: number, digits = 6, algorithm: Algorithm = "SHA1"): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secret as BufferSource, { name: "HMAC", hash: HASH[algorithm] }, false, ["sign"]);
  const msg = new DataView(new ArrayBuffer(8));
  msg.setUint32(0, Math.floor(counter / 2 ** 32));
  msg.setUint32(4, counter >>> 0);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg.buffer));
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** The code for `now` (ms), and how many seconds it has left. */
export async function totp(e: Pick<OtpEntry, "secret" | "digits" | "period" | "algorithm">, now = Date.now()) {
  const step = Math.floor(now / 1000 / e.period);
  const code = await hotp(base32Decode(e.secret), step, e.digits, e.algorithm);
  return { code, remaining: e.period - (Math.floor(now / 1000) % e.period) };
}

export function normalizeEntry(e: Partial<OtpEntry> & { secret: string }): OtpEntry {
  const algorithm = (e.algorithm ?? "SHA1").toUpperCase().replace("-", "") as Algorithm;
  if (!(algorithm in HASH)) throw new Error(`unsupported algorithm ${e.algorithm}`);
  const secret = e.secret.toUpperCase().replace(/[\s=-]/g, "");
  if (!secret || base32Decode(secret).length === 0) throw new Error("empty secret");
  const digits = Number(e.digits ?? 6);
  if (digits < 5 || digits > 10) throw new Error(`unsupported digits ${e.digits}`);
  return {
    type: e.type === "hotp" ? "hotp" : "totp",
    issuer: (e.issuer ?? "").trim(),
    account: (e.account ?? "").trim(),
    secret,
    algorithm,
    digits,
    period: Number(e.period ?? 30) || 30,
    counter: Number(e.counter ?? 0) || 0,
  };
}

/** otpauth://totp/Issuer:account?secret=...&issuer=...&algorithm=...&digits=...&period=... */
export function parseOtpauth(uri: string): OtpEntry {
  const u = new URL(uri.trim());
  if (u.protocol !== "otpauth:") throw new Error("not an otpauth:// link");
  const type = u.hostname.toLowerCase() as "totp" | "hotp";
  if (type !== "totp" && type !== "hotp") throw new Error(`unknown otp type ${u.hostname}`);
  const label = decodeURIComponent(u.pathname.replace(/^\//, ""));
  const [labelIssuer, labelAccount] = label.includes(":") ? label.split(/:(.*)/s) : ["", label];
  const q = u.searchParams;
  const secret = q.get("secret");
  if (!secret) throw new Error("the link has no secret");
  return normalizeEntry({
    type,
    issuer: q.get("issuer") ?? labelIssuer ?? "",
    account: (labelAccount ?? "").trim(),
    secret,
    algorithm: (q.get("algorithm") ?? "SHA1") as Algorithm,
    digits: Number(q.get("digits") ?? 6),
    period: Number(q.get("period") ?? 30),
    counter: Number(q.get("counter") ?? 0),
  });
}

export function buildOtpauth(e: OtpEntry): string {
  const label = encodeURIComponent(e.issuer ? `${e.issuer}:${e.account}` : e.account);
  const q = new URLSearchParams({ secret: e.secret });
  if (e.issuer) q.set("issuer", e.issuer);
  if (e.algorithm !== "SHA1") q.set("algorithm", e.algorithm);
  if (e.digits !== 6) q.set("digits", String(e.digits));
  if (e.type === "totp" && e.period !== 30) q.set("period", String(e.period));
  if (e.type === "hotp") q.set("counter", String(e.counter));
  return `otpauth://${e.type}/${label}?${q}`;
}
