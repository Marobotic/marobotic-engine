import { test, before } from "node:test";
import assert from "node:assert/strict";
import {
  init, deriveKeys, hashAuthKey, verifyAuthKey, seal, open, openText, randomKey,
  newRecoveryCode, recoveryKeyFrom, newVaultKey, unwrapVaultKey, toBase64,
} from "../src/index.ts";

// Small Argon2 settings keep the tests quick; the format is the same as KDF_V1.
const FAST = { v: 1, alg: "argon2id13", ops: 1, memBytes: 8 * 1024 * 1024 } as const;
before(() => init());

test("the same email + password gives the same keys on any device; auth and wrap keys differ", () => {
  const a = deriveKeys("Mi@Marobotic.dev ", "correct horse", FAST);
  const b = deriveKeys("mi@marobotic.dev", "correct horse", FAST);
  assert.equal(toBase64(a.authKey), toBase64(b.authKey));
  assert.equal(toBase64(a.wrapKey), toBase64(b.wrapKey));
  assert.notEqual(toBase64(a.authKey), toBase64(a.wrapKey));
  const other = deriveKeys("mi@marobotic.dev", "correct horsE", FAST);
  assert.notEqual(toBase64(other.authKey), toBase64(a.authKey));
  const otherUser = deriveKeys("someone@else.dev", "correct horse", FAST);
  assert.notEqual(toBase64(otherUser.wrapKey), toBase64(a.wrapKey));
});

test("the server checks the auth key against its hash; the hash is not the key", () => {
  const { authKey } = deriveKeys("mi@marobotic.dev", "pw", FAST);
  const stored = hashAuthKey(authKey);
  assert.ok(stored.startsWith("$argon2id$"));
  assert.ok(verifyAuthKey(stored, authKey));
  assert.ok(!verifyAuthKey(stored, randomKey()));
});

test("seal/open round-trip; wrong key, wrong context or a changed byte all fail", () => {
  const key = randomKey();
  const box = seal(key, "JBSWY3DPEHPK3PXP", "item:abc");
  assert.equal(openText(key, box, "item:abc"), "JBSWY3DPEHPK3PXP");
  assert.notEqual(seal(key, "same", "x"), seal(key, "same", "x"));          // fresh nonce every time
  assert.throws(() => open(randomKey(), box, "item:abc"), /wrong key/);
  assert.throws(() => open(key, box, "item:other"), /wrong key/);            // can't move a box to another item
  const parts = box.split(".");
  const tampered = `${parts[0]}.${parts[1]}.${parts[2]!.slice(0, -2)}AA`;
  assert.throws(() => open(key, tampered, "item:abc"), /wrong key|changed/);
});

test("recovery code: 13 groups of 4, round-trips, forgiving about case and spacing", () => {
  const { code, key } = newRecoveryCode();
  assert.match(code, /^([A-HJ-NP-Z2-9]{4}-){12}[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(toBase64(recoveryKeyFrom(code)), toBase64(key));
  assert.equal(toBase64(recoveryKeyFrom(code.toLowerCase().replaceAll("-", " "))), toBase64(key));
  assert.throws(() => recoveryKeyFrom(code.slice(0, -5)), /52 letters/);
  assert.throws(() => recoveryKeyFrom(code.replace(/^./, "0")), /not in a recovery code/);
});

test("the vault key opens with the password's wrap key or with the recovery kit, and nothing else", () => {
  const { wrapKey } = deriveKeys("mi@marobotic.dev", "pw", FAST);
  const recovery = newRecoveryCode();
  const v = newVaultKey(wrapKey, recovery.key);
  assert.equal(toBase64(unwrapVaultKey(wrapKey, v.byPassword)), toBase64(v.vaultKey));
  assert.equal(toBase64(unwrapVaultKey(recoveryKeyFrom(recovery.code), v.byRecovery)), toBase64(v.vaultKey));
  // a password reset gives new keys: the old vault stays shut without the recovery kit
  const afterReset = deriveKeys("mi@marobotic.dev", "new pw", FAST);
  assert.throws(() => unwrapVaultKey(afterReset.wrapKey, v.byPassword), /wrong key/);
});
