import { test, before } from "node:test";
import assert from "node:assert/strict";
import { init } from "@marobotic/crypto";
import { parseOtpauth } from "@marobotic/otp";
import { Vault, type VaultFile } from "../src/vault.ts";

const FAST = { v: 1, alg: "argon2id13", ops: 1, memBytes: 8 * 1024 * 1024 } as const;
const github = parseOtpauth("otpauth://totp/GitHub:mi%40marobotic.dev?secret=JBSWY3DPEHPK3PXP&issuer=GitHub");
before(() => init());

test("create, add, save, unlock: the saved file shows no secrets, only ids and times", () => {
  const { vault, recoveryCode } = Vault.create("Mi@Marobotic.dev", "hunter2", { kdf: FAST });
  assert.match(recoveryCode, /^([A-Z2-9]{4}-){12}[A-Z2-9]{4}$/);
  const item = vault.add({ type: "totp", otp: github, label: "GitHub" });
  vault.add({ type: "login", name: "Square Enix", urls: ["https://secure.square-enix.com"], username: "maro", password: "pa55word!" });
  const file = vault.toFile();
  const text = JSON.stringify(file);
  for (const secret of ["JBSWY3DPEHPK3PXP", "GitHub", "pa55word!", "Square Enix", "totp", "login", "hunter2"]) assert.ok(!text.includes(secret), secret);
  assert.equal(file.email, "mi@marobotic.dev");
  const again = Vault.unlock(JSON.parse(text) as VaultFile, "hunter2");
  assert.deepEqual(again.get(item.id)!.data, { type: "totp", otp: github, label: "GitHub" });
  assert.equal(again.list("login").length, 1);
  assert.throws(() => Vault.unlock(file, "hunter3"), /wrong password/);
});

test("a changed or swapped item is refused, not silently read", () => {
  const { vault } = Vault.create("a@b.c", "pw", { kdf: FAST });
  vault.add({ type: "note", title: "one", body: "1" });
  vault.add({ type: "note", title: "two", body: "2" });
  const file = vault.toFile();
  const [a, b] = file.items;
  const swapped = { ...file, items: [{ ...a!, box: b!.box }, b!] };
  assert.throws(() => Vault.unlock(swapped, "pw"), /wrong key|changed/);
});

test("password reset: recovery kit opens the vault, setPassword seals it for the new password", () => {
  const { vault, recoveryCode } = Vault.create("a@b.c", "old", { kdf: FAST });
  vault.add({ type: "totp", otp: github });
  const file = vault.toFile();
  assert.throws(() => Vault.unlock(file, "new"), /wrong password/);
  assert.throws(() => Vault.unlockWithRecovery(file, recoveryCode.replace(/^.{4}/, "AAAA")), /does not open/);
  const recovered = Vault.unlockWithRecovery(file, recoveryCode.toLowerCase());
  recovered.setPassword("new");
  const after = Vault.unlock(recovered.toFile(), "new");
  assert.equal(after.list("totp").length, 1);
});

test("a new recovery kit replaces the old one; the password and the items are untouched", () => {
  const { vault, recoveryCode: oldCode } = Vault.create("a@b.c", "pw", { kdf: FAST });
  vault.add({ type: "totp", otp: github });
  const newCode = vault.newRecoveryKit();
  assert.notEqual(newCode, oldCode);
  const file = vault.toFile();
  assert.throws(() => Vault.unlockWithRecovery(file, oldCode), /does not open/);
  assert.equal(Vault.unlockWithRecovery(file, newCode).list("totp").length, 1);
  assert.equal(Vault.unlock(file, "pw").list("totp").length, 1);
});

test("two devices: newer edits win, deletions travel too", () => {
  let t = 1000;
  const clock = () => t++;
  const { vault: phone } = Vault.create("a@b.c", "pw", { kdf: FAST, clock });
  const it = phone.add({ type: "note", title: "wifi", body: "v1" });
  const gone = phone.add({ type: "note", title: "old", body: "x" });
  const pc = Vault.unlock(phone.toFile(), "pw", clock);
  pc.update(it.id, { type: "note", title: "wifi", body: "v2 from pc" });
  phone.remove(gone.id);
  assert.equal(phone.merge(pc.toFile().items), 1);            // pc's newer edit lands on the phone
  assert.equal(pc.merge(phone.toFile().items), 1);            // the phone's deletion lands on the pc
  assert.deepEqual(phone.get(it.id)!.data, { type: "note", title: "wifi", body: "v2 from pc" });
  assert.equal(pc.get(gone.id), undefined);
  assert.equal(pc.merge(phone.toFile().items), 0);            // nothing new: nothing changes
});

test("saving seals only the items that changed, and the file still opens with every item", () => {
  const { vault } = Vault.create("a@b.c", "pw", { kdf: FAST });
  const a = vault.add({ type: "note", title: "a", body: "1" });
  const b = vault.add({ type: "note", title: "b", body: "2" });
  const first = vault.toFile();
  vault.update(b.id, { type: "note", title: "b", body: "3" });
  const second = vault.toFile();
  const box = (f: VaultFile, id: string) => f.items.find((i) => i.id === id)!.box;
  assert.equal(box(second, a.id), box(first, a.id));       // untouched: the same box again
  assert.notEqual(box(second, b.id), box(first, b.id));    // changed: sealed anew
  const again = Vault.unlock(second, "pw");
  assert.equal((again.get(b.id)!.data as { body: string }).body, "3");
  assert.equal((again.get(a.id)!.data as { body: string }).body, "1");
  // Opened from a file, its boxes are reused as they are.
  assert.equal(box(again.toFile(), a.id), box(second, a.id));
  vault.remove(a.id);
  assert.ok(vault.toFile().items.find((i) => i.id === a.id)!.deleted);
});
