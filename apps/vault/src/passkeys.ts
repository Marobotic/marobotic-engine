// Passkeys (WebAuthn) made and used by Vault itself, on WebCrypto, so the browser extension can sign
// in with them and they sync to every device like any other item. A passkey is an ES256 (P-256) key
// pair: the private half stays sealed in the vault, the site keeps the public half.
//
// Vault passkeys are "synced" credentials (backup-eligible and backed-up flags set) with a signature
// counter of 0, which is what sites expect from a passkey that lives on more than one device.
import { registrableDomain } from "./domains.ts";
import type { PasskeyItem } from "./vault.ts";

/** Vault's authenticator model id, shown by sites that list where a passkey lives. */
export const AAGUID = "dca3e0bd-a9b2-429e-807c-b6af9e3b9b4a";
const ES256 = -7;

// ------------------------------------------------------------------ bytes
export const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const utf8 = (s: string) => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource));
export const bytesOf = (b: BufferSource): Uint8Array => (b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength));

// ------------------------------------------------------------------ the CBOR WebAuthn needs (ints, text, bytes, maps)
type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;
function cborHead(major: number, n: number): Uint8Array {
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 0x100) return Uint8Array.of((major << 5) | 24, n);
  if (n < 0x10000) return Uint8Array.of((major << 5) | 25, n >> 8, n & 255);
  return Uint8Array.of((major << 5) | 26, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255);
}
export function cbor(v: Cbor): Uint8Array {
  if (typeof v === "number") return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === "string") { const b = utf8(v); return concat(cborHead(3, b.length), b); }
  if (v instanceof Uint8Array) return concat(cborHead(2, v.length), v);
  return concat(cborHead(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)]));
}

/** WebCrypto signs ECDSA as r||s; WebAuthn wants DER. */
function derSignature(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let x = b.slice(i);
    if (x[0]! & 0x80) x = concat(Uint8Array.of(0), x);
    return concat(Uint8Array.of(0x02, x.length), x);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

// ------------------------------------------------------------------ which site may use which passkey
/** The relying party a page may name: its own host or a parent of it, never a public suffix. */
export function rpIdFor(pageUrl: string, asked?: string): string {
  const u = new URL(pageUrl);
  const local = u.hostname === "localhost";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new DOMException("Passkeys need a secure (https) page", "SecurityError");
  const host = u.hostname.toLowerCase();
  const rp = (asked ?? host).toLowerCase();
  const ok = rp === host || (host.endsWith(`.${rp}`) && rp.endsWith(registrableDomain(host)));
  if (!ok) throw new DOMException(`${rp} is not this site`, "SecurityError");
  return rp;
}

const AUTH_FLAGS = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40 };

async function authData(rpId: string, extra?: Uint8Array): Promise<Uint8Array> {
  const flags = AUTH_FLAGS.UP | AUTH_FLAGS.UV | AUTH_FLAGS.BE | AUTH_FLAGS.BS | (extra ? AUTH_FLAGS.AT : 0);
  return concat(await sha256(utf8(rpId)), Uint8Array.of(flags, 0, 0, 0, 0), extra ?? new Uint8Array());
}

const clientData = (type: "webauthn.create" | "webauthn.get", challenge: Uint8Array, origin: string) =>
  utf8(JSON.stringify({ type, challenge: b64url(challenge), origin, crossOrigin: false }));

// ------------------------------------------------------------------ making one
export type CreateOptions = {
  rp: { id?: string; name?: string };
  user: { id: Uint8Array; name: string; displayName?: string };
  challenge: Uint8Array;
  pubKeyCredParams: { type: string; alg: number }[];
  excludeCredentials?: { id: Uint8Array }[];
};

export type Registration = {
  item: PasskeyItem;
  credentialId: Uint8Array;
  clientDataJSON: Uint8Array;
  attestationObject: Uint8Array;
  authenticatorData: Uint8Array;
  publicKey: Uint8Array;            // SubjectPublicKeyInfo DER, for getPublicKey()
  publicKeyAlgorithm: number;
};

/** A new passkey for `origin`. `existing` are the vault's passkeys, to honour excludeCredentials. */
export async function createPasskey(o: CreateOptions, origin: string, existing: PasskeyItem[]): Promise<Registration> {
  const rpId = rpIdFor(origin, o.rp.id);
  if (o.pubKeyCredParams.length && !o.pubKeyCredParams.some((p) => p.alg === ES256)) throw new DOMException("No supported algorithm", "NotSupportedError");
  const excluded = new Set((o.excludeCredentials ?? []).map((c) => b64url(c.id)));
  if (existing.some((p) => p.rpId === rpId && excluded.has(p.credentialId))) throw new DOMException("This passkey is already in Vault", "InvalidStateError");

  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const cose = cbor(new Map<number, Cbor>([[1, 2], [3, ES256], [-1, 1], [-2, fromB64url(jwk.x!)], [-3, fromB64url(jwk.y!)]]));
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  const aaguid = Uint8Array.from(AAGUID.replace(/-/g, "").match(/../g)!.map((h) => parseInt(h, 16)));
  const ad = await authData(rpId, concat(aaguid, Uint8Array.of(credentialId.length >> 8, credentialId.length & 255), credentialId, cose));
  const attestationObject = cbor(new Map<string, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", ad]]));
  return {
    item: {
      type: "passkey", rpId, credentialId: b64url(credentialId), userHandle: b64url(o.user.id), username: o.user.name,
      displayName: o.user.displayName ?? "", rpName: o.rp.name ?? rpId, created: Date.now(), counter: 0,
      privateKeyPkcs8: b64url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
    },
    credentialId,
    clientDataJSON: clientData("webauthn.create", o.challenge, origin),
    attestationObject,
    authenticatorData: ad,
    publicKey: new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)),
    publicKeyAlgorithm: ES256,
  };
}

// ------------------------------------------------------------------ signing in with one
export type GetOptions = { rpId?: string; challenge: Uint8Array; allowCredentials?: { id: Uint8Array }[] };

/** The vault's passkeys a page may use (all of the site's, or only those it asked for). */
export function passkeysFor(o: Pick<GetOptions, "rpId" | "allowCredentials">, origin: string, all: PasskeyItem[]): PasskeyItem[] {
  const rpId = rpIdFor(origin, o.rpId);
  const allow = new Set((o.allowCredentials ?? []).map((c) => b64url(c.id)));
  return all.filter((p) => p.rpId === rpId && (!allow.size || allow.has(p.credentialId)));
}

export type Assertion = { credentialId: Uint8Array; clientDataJSON: Uint8Array; authenticatorData: Uint8Array; signature: Uint8Array; userHandle: Uint8Array };

export async function signIn(o: GetOptions, origin: string, p: PasskeyItem): Promise<Assertion> {
  const rpId = rpIdFor(origin, o.rpId);
  if (p.rpId !== rpId) throw new DOMException("That passkey is for another site", "SecurityError");
  const cd = clientData("webauthn.get", o.challenge, origin);
  const ad = await authData(rpId);
  const key = await crypto.subtle.importKey("pkcs8", fromB64url(p.privateKeyPkcs8) as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, concat(ad, await sha256(cd)) as BufferSource));
  return { credentialId: fromB64url(p.credentialId), clientDataJSON: cd, authenticatorData: ad, signature: derSignature(raw), userHandle: fromB64url(p.userHandle) };
}
