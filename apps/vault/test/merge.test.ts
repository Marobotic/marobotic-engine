import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "@marobotic/crypto";
import { normalizeEntry } from "@marobotic/otp";
import { Vault, type LoginItem } from "../src/vault.ts";
import { allCodes, mergeCodesIntoLogins } from "../src/merge.ts";
import { codesFor } from "../src/domains.ts";

await init();
const fresh = () => Vault.create("t@marobotic.dev", "pw", { kdf: { v: 1, alg: "argon2id13", ops: 1, memBytes: 8 * 1024 * 1024 } }).vault;
const otp = (issuer: string, account: string) => normalizeEntry({ issuer, account, secret: "JBSWY3DPEHPK3PXP" });
const login = (name: string, url: string, username: string, extra: Partial<LoginItem> = {}): LoginItem => ({ type: "login", name, urls: [url], username, password: "pw", notes: "", ...extra });

test("a code moves into the one login it belongs to; the rest stay 2FA entries", () => {
  const v = fresh();
  const linked = v.add({ type: "totp", otp: otp("Square Enix", "alt") });
  const gh = v.add({ type: "totp", otp: otp("GitHub", "mi@marobotic.dev"), favorite: true });
  const other = v.add({ type: "totp", otp: otp("GitHub", "someone-else") });      // GitHub, another account
  const lonely = v.add({ type: "totp", otp: otp("DigitalOcean", "x") });           // no login
  const se = v.add(login("Square Enix", "square-enix.com", "maro-alt-id", { totpId: linked.id }));   // linked: account names may differ
  const ghLogin = v.add(login("GitHub", "github.com", "mi@marobotic.dev"));
  const moved = mergeCodesIntoLogins(v);

  // linked (account names may differ), and GitHub: of its two codes, the one for the login's own account
  assert.deepEqual(new Map(moved), new Map([[linked.id, se.id], [gh.id, ghLogin.id]]));
  assert.equal((v.get(se.id)!.data as LoginItem).otp?.account, "alt");
  assert.equal((v.get(se.id)!.data as LoginItem).totpId, undefined);
  assert.equal(v.get(linked.id), undefined);
  assert.equal((v.get(ghLogin.id)!.data as LoginItem).favorite, true);   // a pinned code keeps the login pinned
  assert.ok(v.get(other.id) && v.get(lonely.id));                       // another account's code, and one with no login
  assert.equal(mergeCodesIntoLogins(v).size, 0);        // nothing left to move
});

test("a code for another account on the same site isn't merged", () => {
  const v = fresh();
  v.add({ type: "totp", otp: otp("GitHub", "work-account") });
  v.add(login("GitHub", "github.com", "mi"));
  assert.equal(mergeCodesIntoLogins(v).size, 0);
});

test("a login's own code is offered on its site like any other", () => {
  const v = fresh();
  const l = v.add(login("GitHub", "github.com", "mi", { otp: otp("GitHub", "mi") }));
  const codes = allCodes(v);
  assert.equal(codes.length, 1);
  assert.equal(codes[0]!.id, l.id);
  assert.ok(codes[0]!.data.inLogin);
  assert.deepEqual(codesFor("https://github.com/sessions/two-factor", codes, v.list("login") as never).map((c) => c.id), [l.id]);
});
