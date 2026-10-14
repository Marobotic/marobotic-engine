import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "@marobotic/crypto";
import { Vault } from "../src/vault.ts";
import { loginsFor } from "../src/domains.ts";
import { byUse, recordUse, useCounts } from "../src/usage.ts";

const FAST = { v: 1, alg: "argon2id13", ops: 1, memBytes: 8 * 1024 * 1024 } as const;
const login = (email: string) => ({ type: "login" as const, name: "Discord", urls: ["https://discord.com"], username: "", email, password: "pw" });

test("the login picked most comes first, and devices add up instead of overwriting each other", async () => {
  await init();
  const { vault: phone } = Vault.create("me@example.com", "pw", { kdf: FAST });
  const a = phone.add(login("a@x.com")), b = phone.add(login("b@x.com")), c = phone.add(login("c@x.com"));
  const site = () => loginsFor("https://discord.com/login", phone.list("login") as never[], useCounts(phone)).map((l: { id: string }) => l.id);
  assert.deepEqual(site(), [a.id, b.id, c.id]);   // nothing picked yet: as before

  let mine = recordUse(phone, "", [c.id]);
  mine = recordUse(phone, mine, [c.id]);
  mine = recordUse(phone, mine, [b.id]);
  assert.deepEqual(site(), [c.id, b.id, a.id]);
  assert.equal(phone.list("usage").length, 1);    // one hidden item per device
  assert.equal(phone.list("login").length, 3);    // and it's never a login

  // The PC picks b three times, in its own item; after a sync both devices see the sum.
  const pc = Vault.withKey(phone.toFile(), phone.keyBytes());
  let pcMine = "";
  for (let i = 0; i < 3; i++) pcMine = recordUse(pc, pcMine, [b.id]);
  phone.merge(pc.toFile().items);
  pc.merge(phone.toFile().items);
  assert.equal(useCounts(phone).get(b.id), 4);
  assert.equal(useCounts(phone).get(c.id), 2);
  assert.deepEqual(site(), [b.id, c.id, a.id]);
  assert.deepEqual(useCounts(pc), useCounts(phone));
});

test("byUse keeps the old order among equals, and a deleted login's count goes", async () => {
  await init();
  const { vault } = Vault.create("me@example.com", "pw", { kdf: FAST });
  const a = vault.add(login("a@x.com")), b = vault.add(login("b@x.com"));
  const mine = recordUse(vault, "", [b.id]);
  assert.deepEqual(byUse([a, b], useCounts(vault)).map((x) => x.id), [b.id, a.id]);
  assert.deepEqual(byUse([a, b], new Map()).map((x) => x.id), [a.id, b.id]);
  vault.remove(b.id);
  recordUse(vault, mine, [a.id]);
  assert.equal(useCounts(vault).has(b.id), false);
  assert.equal(recordUse(vault, mine, ["nope"]), mine);
});
