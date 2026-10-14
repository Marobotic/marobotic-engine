import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "@marobotic/crypto";
import { normalizeEntry } from "@marobotic/otp";
import { Vault } from "../src/vault.ts";

// The bridge keeps paired browsers in localStorage (the app's window has it; Node doesn't).
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k),
};
const { handle } = await import("../ui/bridge.ts");

await init();
const vault = Vault.create("t@marobotic.dev", "pw", { kdf: { v: 1, alg: "argon2id13", ops: 1, memBytes: 8 * 1024 * 1024 } }).vault;
const gh = vault.add({ type: "login", name: "GitHub", urls: ["https://github.com"], username: "mi", password: "gh-pw", notes: "" });
vault.add({ type: "totp", otp: normalizeEntry({ issuer: "GitHub", account: "mi", secret: "JBSWY3DPEHPK3PXP" }) });
let approve = true, saved = 0;
const ctx = { vault: () => vault as Vault | null, save: async () => void saved++, approvePair: async () => approve, notify: () => {} };

test("nothing is answered before this browser is allowed in Vault", async () => {
  assert.deepEqual(await handle(ctx, { op: "match", url: "https://github.com/login" }), { error: "unpaired" });
  assert.deepEqual(await handle(ctx, { op: "match", url: "https://github.com/login", token: "made-up" }), { error: "unpaired" });
  approve = false;
  assert.deepEqual(await handle(ctx, { op: "pair", code: "1234", browser: "Chrome" }), { error: "denied" });
});

test("a paired browser gets a page's own logins and codes, and nothing for a look-alike", async () => {
  approve = true;
  const { token } = (await handle(ctx, { op: "pair", code: "1234", browser: "Chrome" })) as { token: string };
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.deepEqual(await handle(ctx, { op: "hello", token }), { app: "vault", paired: true, locked: false });

  const m = (await handle(ctx, { op: "match", url: "https://github.com/login", token })) as { logins: { id: string }[]; codes: { code: string }[] };
  assert.equal(m.logins[0]!.id, gh.id);
  assert.match(m.codes[0]!.code, /^\d{6}$/);
  const f = (await handle(ctx, { op: "fill", url: "https://github.com/login", id: gh.id, token })) as { password: string; code: string };
  assert.equal(f.password, "gh-pw");
  assert.match(f.code, /^\d{6}$/);

  assert.deepEqual(await handle(ctx, { op: "match", url: "https://github.com.evil.io/login", token }), { logins: [], codes: [] });
  assert.deepEqual(await handle(ctx, { op: "fill", url: "https://github.com.evil.io/login", id: gh.id, token }), { error: "not for this site" });
  assert.deepEqual(await handle(ctx, { op: "fill", url: "http://github.com/login", id: gh.id, token }), { error: "not for this site" });
});

test("saving: a new login is added, a changed password updates the login, the same one is left alone", async () => {
  const { token } = (await handle(ctx, { op: "pair", code: "5678", browser: "Brave" })) as { token: string };
  const url = "https://github.com/session";
  assert.deepEqual(await handle(ctx, { op: "check", url, username: "mi", password: "gh-pw", token }), { state: "same", name: "GitHub" });
  assert.deepEqual(await handle(ctx, { op: "check", url, username: "MI", password: "new-pw", token }), { state: "changed", name: "GitHub" });
  assert.deepEqual(await handle(ctx, { op: "save", url, username: "mi", password: "new-pw", token }), { saved: "updated", name: "GitHub" });
  assert.equal((vault.get(gh.id)!.data as { password: string }).password, "new-pw");
  assert.deepEqual(await handle(ctx, { op: "check", url: "https://app.example.com/login", username: "x", password: "y", token }), { state: "new", name: undefined });
  assert.deepEqual(await handle(ctx, { op: "save", url: "https://app.example.com/login", username: "x", password: "y", token }), { saved: "added", name: "Example" });
  assert.equal(saved, 2);
});
