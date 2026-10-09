// Encryption for every marobotic app, on every platform: libsodium compiled to WebAssembly, so a
// phone, the desktop and a browser extension run the exact same code.
//
// One password for the whole account, and the server never sees it:
//
//   email + password --Argon2id--> master key --+--> auth key   (sent to the server at sign-in;
//                                               |                the server keeps only its hash)
//                                               +--> wrap key   (never leaves the device)
//
//   vault key (random) --sealed with the wrap key-----> stored on the server
//                      --sealed with the recovery key-> the same, for the printed recovery kit
//
// Changing the password re-seals the vault key; the vault itself is never re-encrypted. A password
// reset without the recovery kit cannot open the old vault: nobody, the server included, holds a key.
import sodium from "libsodium-wrappers-sumo";

export const KDF_V1 = { v: 1, alg: "argon2id13", ops: 3, memBytes: 64 * 1024 * 1024 } as const;
export type KdfParams = { v: number; alg: "argon2id13"; ops: number; memBytes: number };

let ready: Promise<void> | null = null;
/** libsodium's WebAssembly has to load once before anything else here. */
export function init(): Promise<void> {
  return (ready ??= sodium.ready);
}
function s(): typeof sodium {
  if (!ready) throw new Error("call init() first");
  return sodium;
}

export const toBase64 = (b: Uint8Array) => s().to_base64(b, s().base64_variants.URLSAFE_NO_PADDING);
export const fromBase64 = (t: string) => s().from_base64(t, s().base64_variants.URLSAFE_NO_PADDING);
const utf8 = (t: string) => new TextEncoder().encode(t);

/** The salt is the account itself, so any device can derive the same keys from email + password. */
function salt(email: string): Uint8Array {
  return s().crypto_generichash(s().crypto_pwhash_SALTBYTES, utf8(`marobotic:${email.trim().toLowerCase()}`), null);
}

export type AccountKeys = { authKey: Uint8Array; wrapKey: Uint8Array };

/** email + password -> the two keys. Slow on purpose (Argon2id, 64 MB). */
export function deriveKeys(email: string, password: string, p: KdfParams = KDF_V1): AccountKeys {
  if (p.alg !== "argon2id13") throw new Error(`unknown key derivation ${p.alg}`);
  const so = s();
  const master = so.crypto_pwhash(32, utf8(password.normalize("NFKC")), salt(email), p.ops, p.memBytes, so.crypto_pwhash_ALG_ARGON2ID13);
  const out = {
    authKey: so.crypto_kdf_derive_from_key(32, 1, "mb_auth_", master),
    wrapKey: so.crypto_kdf_derive_from_key(32, 2, "mb_vault", master),
  };
  so.memzero(master);
  return out;
}

/** What the server stores for an auth key: its own Argon2id hash, so a stolen database is not a login. */
export function hashAuthKey(authKey: Uint8Array): string {
  return s().crypto_pwhash_str(toBase64(authKey), s().crypto_pwhash_OPSLIMIT_INTERACTIVE, s().crypto_pwhash_MEMLIMIT_INTERACTIVE);
}
export function verifyAuthKey(stored: string, authKey: Uint8Array): boolean {
  return s().crypto_pwhash_str_verify(stored, toBase64(authKey));
}

/** A sealed box: version, nonce and ciphertext in one URL-safe string. */
export type Sealed = string;

/** XChaCha20-Poly1305. `context` is authenticated but not secret: it ties the ciphertext to its
 *  place (an item id, "vault-key"), so a box can't be swapped for another one. */
export function seal(key: Uint8Array, plain: Uint8Array | string, context = ""): Sealed {
  const so = s();
  const nonce = so.randombytes_buf(so.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const data = typeof plain === "string" ? utf8(plain) : plain;
  const box = so.crypto_aead_xchacha20poly1305_ietf_encrypt(data, utf8(context), null, nonce, key);
  return `v1.${toBase64(nonce)}.${toBase64(box)}`;
}

export function open(key: Uint8Array, sealed: Sealed, context = ""): Uint8Array {
  const [v, n, b] = sealed.split(".");
  if (v !== "v1" || !n || !b) throw new Error("not a sealed box");
  try {
    return s().crypto_aead_xchacha20poly1305_ietf_decrypt(null, fromBase64(b), utf8(context), fromBase64(n), key);
  } catch {
    throw new Error("wrong key, or the data was changed");
  }
}
export const openText = (key: Uint8Array, sealed: Sealed, context = "") => new TextDecoder().decode(open(key, sealed, context));

export const randomKey = () => s().randombytes_buf(32);

// ---- recovery kit: 32 random bytes written as 13 groups of 4 base32 letters, easy to type back ----
const B32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1: nothing to misread on paper

export function newRecoveryCode(): { code: string; key: Uint8Array } {
  const key = randomKey();
  return { code: recoveryCodeOf(key), key };
}
export function recoveryCodeOf(key: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const byte of key) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join("-");
}
export function recoveryKeyFrom(code: string): Uint8Array {
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const bytes: number[] = [];
  let bits = 0, value = 0;
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error(`"${ch}" is not in a recovery code`);
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  if (bytes.length !== 32) throw new Error("a recovery code has 52 letters");
  return new Uint8Array(bytes);
}

/** A new vault: its key, sealed for the password and for the recovery kit. */
export function newVaultKey(wrapKey: Uint8Array, recoveryKey: Uint8Array) {
  const vaultKey = randomKey();
  return { vaultKey, byPassword: seal(wrapKey, vaultKey, "vault-key"), byRecovery: seal(recoveryKey, vaultKey, "vault-key") };
}
export const unwrapVaultKey = (key: Uint8Array, sealed: Sealed) => open(key, sealed, "vault-key");
