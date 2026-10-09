import { test } from "node:test";
import assert from "node:assert/strict";
import { importGoogleMigration, importText } from "../src/index.ts";
import { base32Decode } from "@marobotic/otp";

// A tiny protobuf writer, so the tests build exports the way Google Authenticator does.
const varint = (n: number | bigint) => { const out: number[] = []; let v = BigInt.asUintN(64, BigInt(n)); do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v); return out; };
const field = (no: number, v: number | Uint8Array | string): number[] =>
  typeof v === "number" ? [...varint((no << 3) | 0), ...varint(v)]
    : ((b: Uint8Array) => [...varint((no << 3) | 2), ...varint(b.length), ...b])(typeof v === "string" ? new TextEncoder().encode(v) : v);
function migration(accounts: { secret: Uint8Array; name: string; issuer?: string; alg?: number; digits?: number; type?: number }[], batch?: [number, number, number]) {
  const bytes: number[] = [];
  for (const a of accounts) {
    const p = [...field(1, a.secret), ...field(2, a.name), ...(a.issuer ? field(3, a.issuer) : []), ...field(4, a.alg ?? 1), ...field(5, a.digits ?? 1), ...field(6, a.type ?? 2)];
    bytes.push(...field(1, new Uint8Array(p)));
  }
  bytes.push(...field(2, 1));
  if (batch) bytes.push(...field(3, batch[0]), ...field(4, batch[1]), ...field(5, batch[2]));
  const b64 = btoa(String.fromCharCode(...bytes));
  return `otpauth-migration://offline?data=${encodeURIComponent(b64)}`;
}

const hello = new Uint8Array([72, 101, 108, 108, 111, 33, 0xde, 0xad, 0xbe, 0xef]); // JBSWY3DPEHPK3PXP

test("Google Authenticator export: accounts, issuers, algorithms, digits, batches", () => {
  const uri = migration([
    { secret: hello, name: "GitHub:mi@marobotic.dev", issuer: "GitHub" },
    { secret: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), name: "Square Enix:maro", issuer: "Square Enix", alg: 2, digits: 2 },
    { secret: hello, name: "no-issuer-account" },
    { secret: hello, name: "Old:md5", issuer: "Old", alg: 4 },
  ], [2, 0, -123456]);
  const r = importGoogleMigration(uri);
  assert.equal(r.entries.length, 3);
  assert.deepEqual(r.entries[0], { type: "totp", issuer: "GitHub", account: "mi@marobotic.dev", secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30, counter: 0 });
  assert.equal(r.entries[1]!.issuer, "Square Enix");
  assert.equal(r.entries[1]!.algorithm, "SHA256");
  assert.equal(r.entries[1]!.digits, 8);
  assert.deepEqual(base32Decode(r.entries[1]!.secret), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
  assert.equal(r.entries[2]!.account, "no-issuer-account");
  assert.match(r.skipped[0]!, /Old \(md5\): uses MD5/);
  assert.deepEqual(r.batch, { index: 0, size: 2, id: -123456 });
});

test("a real export link from the wild decodes (data with + and / escaped)", () => {
  // The example from the extract_otp_secrets project's documentation.
  const r = importGoogleMigration("otpauth-migration://offline?data=CjEKCkhlbGxvId6tvu8SGEV4YW1wbGU6YWxpY2VAZ29vZ2xlLmNvbRoHRXhhbXBsZSABKAEwAhABGAEgACjr4JKk%2B%2F%2F%2F%2F%2F8B");
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0]!.secret, "JBSWY3DPEHPK3PXP");
  assert.equal(r.entries[0]!.issuer, "Example");
  assert.equal(r.entries[0]!.account, "alice@google.com");
});

test("text import: mixed otpauth and migration links, duplicates kept once, bad links explained", () => {
  const g = migration([{ secret: hello, name: "GitHub:mi@marobotic.dev", issuer: "GitHub" }]);
  const r = importText(`backup:\notpauth://totp/GitHub:mi%40marobotic.dev?secret=JBSWY3DPEHPK3PXP&issuer=GitHub\n${g}\notpauth://totp/Broken?issuer=x\n`);
  assert.equal(r.entries.length, 1);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0]!, /no secret/);
  assert.deepEqual(importText("nothing here").skipped, ["no otpauth:// links found"]);
  assert.throws(() => importGoogleMigration("https://x"), /not a Google Authenticator export/);
});
