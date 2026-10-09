import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createVaultServer } from "../server/server.ts";

// A stand-in for maro-cache: two accounts, sessions "s-mi" and "s-other".
const accounts: Record<string, string> = { "s-mi": "mi@marobotic.dev", "s-other": "friend@example.com" };
let account: Server, vault: Server, base = "", dir = "";

before(async () => {
  account = createServer((req, res) => {
    if (req.url === "/account") {
      const s = (req.headers.authorization ?? "").replace("Bearer ", "");
      return accounts[s] ? res.writeHead(200).end(JSON.stringify({ account: { email: accounts[s] } })) : res.writeHead(401).end("{}");
    }
    if (req.url === "/auth/login") {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        const { email, password } = JSON.parse(b);
        if (email === "mi@marobotic.dev" && password === "pw") res.writeHead(200).end(JSON.stringify({ session: "s-mi", account: { email } }));
        else res.writeHead(401).end(JSON.stringify({ error: "Wrong email or password." }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => account.listen(0, "127.0.0.1", ok));
  dir = mkdtempSync(join(tmpdir(), "vault-server-"));
  vault = createVaultServer({ dataDir: dir, accountUrl: `http://127.0.0.1:${(account.address() as AddressInfo).port}` });
  await new Promise<void>((ok) => vault.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(vault.address() as AddressInfo).port}`;
});
after(() => { vault.close(); account.close(); rmSync(dir, { recursive: true, force: true }); });

const call = async (method: string, path: string, session?: string, body?: unknown, origin?: string) => {
  const r = await fetch(base + path, { method, headers: { ...(session ? { authorization: `Bearer ${session}` } : {}), ...(origin ? { origin } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null, headers: r.headers };
};
const vaultOf = (email: string, n: number) => ({ format: "marobotic-vault", v: 1, email, items: Array.from({ length: n }, (_, i) => ({ id: `i${i}`, updated: i, box: "v1.x.y" })) });

test("sign-in goes through the shared account; a wrong password is the account's answer", async () => {
  const ok = await call("POST", "/auth/login", undefined, { email: "mi@marobotic.dev", password: "pw" });
  assert.deepEqual(ok.json, { ok: true, session: "s-mi", email: "mi@marobotic.dev" });
  const bad = await call("POST", "/auth/login", undefined, { email: "mi@marobotic.dev", password: "nope" });
  assert.equal(bad.status, 401);
  assert.equal(bad.json!.error, "Wrong email or password.");
});

test("each account has its own vault; nobody else's can be read or written", async () => {
  assert.equal((await call("GET", "/api/vault")).status, 401);
  assert.equal((await call("GET", "/api/vault", "s-mi")).status, 404);                // no vault yet
  const put = await call("PUT", "/api/vault", "s-mi", { base: 0, file: vaultOf("mi@marobotic.dev", 1) });
  assert.deepEqual(put.json, { rev: 1 });
  assert.equal((await call("GET", "/api/vault", "s-other")).status, 404);             // a friend sees only their own
  const steal = await call("PUT", "/api/vault", "s-other", { base: 0, file: vaultOf("mi@marobotic.dev", 1) });
  assert.equal(steal.status, 403);
  assert.equal((await call("PUT", "/api/vault", "s-mi", { base: 1, file: { hello: 1 } })).status, 400);
  const got = await call("GET", "/api/vault", "s-mi");
  assert.equal(got.json!.rev, 1);
});

test("two devices: the second save on an old version gets 409 and the newer vault", async () => {
  const a = await call("PUT", "/api/vault", "s-mi", { base: 1, file: vaultOf("mi@marobotic.dev", 2) });
  assert.deepEqual(a.json, { rev: 2 });
  const b = await call("PUT", "/api/vault", "s-mi", { base: 1, file: vaultOf("mi@marobotic.dev", 3) });
  assert.equal(b.status, 409);
  assert.equal(b.json!.rev, 2);
  assert.equal(((b.json!.file as { items: unknown[] }).items).length, 2);
  for (let i = 3; i <= 14; i++) await call("PUT", "/api/vault", "s-mi", { base: i - 1, file: vaultOf("mi@marobotic.dev", i) });
  const versions = readdirSync(dir).filter((f) => f.includes(".json.v"));
  assert.equal(versions.length, 10);                                                 // the last ten stay as a safety net
});

test("the app's own window may call it; other web pages may not", async () => {
  const app = await call("GET", "/health", undefined, undefined, "http://tauri.localhost");
  assert.equal(app.headers.get("access-control-allow-origin"), "http://tauri.localhost");
  const page = await call("GET", "/health", undefined, undefined, "https://evil.example");
  assert.equal(page.headers.get("access-control-allow-origin"), null);
});
