import { test } from "node:test";
import assert from "node:assert/strict";
import { AAGUID, b64url, createPasskey, passkeysFor, rpIdFor, signIn } from "../src/passkeys.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource));
/** DER ECDSA signature -> r||s, as WebCrypto verifies it. */
function rawSig(der: Uint8Array): Uint8Array {
  let i = 2;
  const part = () => { const len = der[i + 1]!; let v = der.slice(i + 2, i + 2 + len); i += 2 + len; while (v.length > 32) v = v.slice(1); const out = new Uint8Array(32); out.set(v, 32 - v.length); return out; };
  const r = part(), s = part();
  return new Uint8Array([...r, ...s]);
}

test("the relying party is the page's own site or a parent of it, over https", () => {
  assert.equal(rpIdFor("https://login.github.com/x"), "login.github.com");
  assert.equal(rpIdFor("https://login.github.com/x", "github.com"), "github.com");
  assert.throws(() => rpIdFor("https://github.com", "evil.com"), /not this site/);
  assert.throws(() => rpIdFor("https://github.com", "com"), /not this site/);
  assert.throws(() => rpIdFor("https://evil.co.uk", "co.uk"), /not this site/);
  assert.throws(() => rpIdFor("http://github.com"), /secure/);
  assert.equal(rpIdFor("http://localhost:3000"), "localhost");
});

test("a passkey made here signs in, and the site can check it with the public key it was given", async () => {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const reg = await createPasskey({
    rp: { id: "github.com", name: "GitHub" }, user: { id: enc("user-42"), name: "mi", displayName: "Mi" }, challenge,
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  }, "https://github.com", []);
  assert.equal(reg.item.rpId, "github.com");
  assert.equal(reg.item.username, "mi");
  const cd = JSON.parse(new TextDecoder().decode(reg.clientDataJSON));
  assert.deepEqual(cd, { type: "webauthn.create", challenge: b64url(challenge), origin: "https://github.com", crossOrigin: false });
  // authData: rpIdHash, flags UP|UV|BE|BS|AT, counter 0, then the AAGUID
  assert.deepEqual(reg.authenticatorData.slice(0, 32), await sha256(enc("github.com")));
  assert.equal(reg.authenticatorData[32], 0x5d);
  assert.equal([...reg.authenticatorData.slice(37, 53)].map((b) => b.toString(16).padStart(2, "0")).join(""), AAGUID.replace(/-/g, ""));

  // excludeCredentials: the same passkey can't be made twice
  await assert.rejects(createPasskey({ rp: { id: "github.com" }, user: { id: enc("u"), name: "mi" }, challenge, pubKeyCredParams: [], excludeCredentials: [{ id: reg.credentialId }] }, "https://github.com", [reg.item]), /already in Vault/);

  const ch2 = crypto.getRandomValues(new Uint8Array(32));
  assert.deepEqual(passkeysFor({}, "https://github.com/login", [reg.item]), [reg.item]);
  assert.deepEqual(passkeysFor({}, "https://gitlab.com/login", [reg.item]), []);
  const a = await signIn({ challenge: ch2 }, "https://github.com", reg.item);
  assert.equal(new TextDecoder().decode(a.userHandle), "user-42");
  const pub = await crypto.subtle.importKey("spki", reg.publicKey as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const signed = new Uint8Array([...a.authenticatorData, ...(await sha256(a.clientDataJSON))]);
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, rawSig(a.signature) as BufferSource, signed as BufferSource));
  await assert.rejects(signIn({ challenge: ch2 }, "https://gitlab.com", reg.item), /another site|not this site/);
});
