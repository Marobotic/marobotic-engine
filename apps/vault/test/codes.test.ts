import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "@marobotic/crypto";
import { normalizeEntry } from "@marobotic/otp";
import { Vault } from "../src/vault.ts";
import { editCode } from "../src/codes.ts";

const FAST = { v: 1, alg: "argon2id13", ops: 1, memBytes: 8 * 1024 * 1024 } as const;
const otp = normalizeEntry({ issuer: "Discrod", account: "old@x.com", secret: "JBSWY3DPEHPK3PXP" });

test("a 2FA code's name, service, account and settings can be edited; the key stays unless replaced", async () => {
  await init();
  const { vault } = Vault.create("me@example.com", "pw", { kdf: FAST });
  const c = vault.add({ type: "totp", otp, label: "Old name", notes: "n" });
  editCode(vault, c.id, { name: "Discord main", issuer: "Discord", account: "me@x.com", digits: 8, period: 60 });
  const d = vault.get(c.id)!.data;
  assert.equal(d.type, "totp");
  if (d.type !== "totp") return;
  assert.equal(d.label, "Discord main");
  assert.equal(d.otp.issuer, "Discord");
  assert.equal(d.otp.account, "me@x.com");
  assert.equal(d.otp.secret, "JBSWY3DPEHPK3PXP");
  assert.equal(d.otp.digits, 8);
  assert.equal(d.otp.period, 60);
  assert.equal(d.notes, "n");

  editCode(vault, c.id, { name: "Discord", issuer: "Discord", account: "me@x.com", secret: "gezd gnbv gy3t qojq" });
  const e = vault.get(c.id)!.data;
  if (e.type !== "totp") return assert.fail();
  assert.equal(e.label, undefined);              // the same as the service: no separate name
  assert.equal(e.otp.secret, "GEZDGNBVGY3TQOJQ");
});

test("a bad setup key is refused with a message; a login's own code is edited in its login", async () => {
  await init();
  const { vault } = Vault.create("me@example.com", "pw", { kdf: FAST });
  const c = vault.add({ type: "totp", otp });
  assert.throws(() => editCode(vault, c.id, { issuer: "X", account: "", secret: "abc018" }), /A-Z and the digits 2-7/);
  const l = vault.add({ type: "login", name: "Discord", urls: [], username: "", password: "pw", otp });
  editCode(vault, l.id, { issuer: "Discord", account: "me@x.com" });
  const d = vault.get(l.id)!.data;
  assert.ok(d.type === "login" && d.otp?.account === "me@x.com" && d.name === "Discord" && d.password === "pw");
  assert.throws(() => editCode(vault, "nope", { issuer: "", account: "" }), /gone/);
});
