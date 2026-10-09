// Vault's server: one sealed vault per marobotic account. It never sees anything readable: the vault
// arrives sealed with a key made on the device, and only the account check runs here.
//
// Accounts are the shared marobotic ones (maro-cache, the same as Hourglass and Jukebox): sign-in is
// passed through to it, and a session is checked with its GET /account.
//
//   POST /auth/login|register|forgot|reset   -> maro-cache
//   GET  /api/vault                          -> { rev, file } | 404 { none: true }
//   PUT  /api/vault { base, file }           -> { rev } | 409 { rev, file } when another device saved first
//   GET  /health
//
// env VAULT_PORT (8950), VAULT_HOST (127.0.0.1), VAULT_DATA (/var/lib/marobotic-vault),
//     MARO_ACCOUNT_URL (http://127.0.0.1:8900)
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

const MAX_BODY = 5 * 1024 * 1024;
const KEEP_VERSIONS = 10;
// The app's own pages, as each platform's webview calls them.
const ORIGINS = new Set(["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost", "http://127.0.0.1:8960"]);

type Stored = { rev: number; updated: number; file: unknown };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function createVaultServer(opts: { dataDir: string; accountUrl: string }) {
  const { dataDir, accountUrl } = opts;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const sessions = new Map<string, { email: string | null; until: number }>();

  const pathOf = (email: string) => join(dataDir, `${sha(email)}.json`);
  function load(email: string): Stored | null {
    try { return JSON.parse(readFileSync(pathOf(email), "utf8")) as Stored; } catch { return null; }
  }
  function store(email: string, s: Stored) {
    const p = pathOf(email);
    if (existsSync(p)) {
      renameSync(p, `${p}.v${s.rev - 1}`);
      const old = readdirSync(dataDir).filter((f) => f.startsWith(`${sha(email)}.json.v`)).sort((a, b) => Number(b.split(".v").pop()) - Number(a.split(".v").pop()));
      for (const f of old.slice(KEEP_VERSIONS)) unlinkSync(join(dataDir, f));
    }
    writeFileSync(`${p}.tmp`, JSON.stringify(s), { mode: 0o600 });
    renameSync(`${p}.tmp`, p);
  }

  async function emailOf(req: IncomingMessage): Promise<string | null> {
    const auth = req.headers.authorization ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!bearer) return null;
    const k = sha(bearer);
    const hit = sessions.get(k);
    if (hit && hit.until > Date.now()) return hit.email;
    let email: string | null = null;
    try {
      const r = await fetch(`${accountUrl}/account`, { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const o = (await r.json()) as { account?: { email?: string }; email?: string };
        email = String(o.account?.email || o.email || "").toLowerCase() || null;
      } else if (r.status !== 401 && r.status !== 403) throw new Error("account server");
    } catch {
      if (hit?.email) return hit.email;
      throw Object.assign(new Error("The account server is not answering. Try again in a moment."), { status: 503 });
    }
    sessions.set(k, { email, until: Date.now() + (email ? 10 * 60_000 : 30_000) });
    return email;
  }

  async function body(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req as AsyncIterable<Buffer>) {
      n += c.length;
      if (n > MAX_BODY) throw Object.assign(new Error("too big"), { status: 413 });
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const origin = String(req.headers.origin ?? "");
    const cors: Record<string, string> = ORIGINS.has(origin)
      ? { "access-control-allow-origin": origin, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, PUT, POST", vary: "origin" }
      : {};
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...cors });
      res.end(JSON.stringify(obj));
    };
    const path = new URL(req.url ?? "/", "http://x").pathname;
    try {
      if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
      if (path === "/health") return send(200, { ok: true });

      const auth = /^\/auth\/(login|register|forgot|reset)$/.exec(path);
      if (auth && req.method === "POST") {
        const r = await fetch(`${accountUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: await body(req), signal: AbortSignal.timeout(15000) });
        const out = (await r.json().catch(() => ({}))) as { session?: string; account?: { email?: string }; error?: string; retryIn?: number };
        if (!r.ok) return send(r.status, { ok: false, error: out.error || "sign-in failed", retryIn: out.retryIn });
        return send(200, { ok: true, session: out.session, email: out.account?.email?.toLowerCase() });
      }

      if (path === "/api/vault") {
        const email = await emailOf(req);
        if (!email) return send(401, { error: "Sign in again." });
        const cur = load(email);
        if (req.method === "GET") return cur ? send(200, { rev: cur.rev, file: cur.file }) : send(404, { none: true });
        if (req.method === "PUT") {
          let msg: { base?: number; file?: { format?: string; email?: string; items?: unknown } };
          try { msg = JSON.parse(await body(req)); } catch { return send(400, { error: "not JSON" }); }
          const f = msg.file;
          if (!f || f.format !== "marobotic-vault" || !Array.isArray(f.items)) return send(400, { error: "that is not a vault" });
          if (String(f.email).toLowerCase() !== email) return send(403, { error: "that vault belongs to another account" });
          if ((cur?.rev ?? 0) !== (msg.base ?? 0)) return send(409, { rev: cur?.rev ?? 0, file: cur?.file ?? null });
          const next: Stored = { rev: (cur?.rev ?? 0) + 1, updated: Date.now(), file: f };
          store(email, next);
          return send(200, { rev: next.rev });
        }
      }
      send(404, { error: "not found" });
    } catch (e) {
      const err = e as Error & { status?: number };
      send(err.status ?? 500, { error: err.status ? err.message : "something went wrong" });
      if (!err.status) console.error(err);
    }
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!)) {
  const port = Number(process.env.VAULT_PORT || 8950);
  const host = process.env.VAULT_HOST || "127.0.0.1";
  createVaultServer({ dataDir: process.env.VAULT_DATA || "/var/lib/marobotic-vault", accountUrl: (process.env.MARO_ACCOUNT_URL || "http://127.0.0.1:8900").replace(/\/+$/, "") })
    .listen(port, host, () => console.log(`vault server on http://${host}:${port}`));
}
