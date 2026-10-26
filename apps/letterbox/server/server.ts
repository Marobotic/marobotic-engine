// Letterbox's server: the web client's pages plus a small API over each person's Zoho mailboxes. Live at
// marobotic.dev/letterbox (nginx strips the prefix). Sign-in is the marobotic account (maro-cache, shared
// with Hourglass, Jukebox and Vault); its session rides in an HttpOnly cookie, or a Bearer token in the app.
// Each account then adds its own Zoho mailboxes in Settings, through Zoho's sign-in page.
//
//   POST /auth/login {email, password} | /auth/register | /auth/forgot | /auth/logout
//   GET  /api/me                                         -> { email, accounts: [{id, email, name, color}], canAdd }
//   POST /api/accounts/connect {app}                     -> { url }: Zoho's sign-in page
//   GET  /oauth/zoho?code&state&accounts-server          <- Zoho sends the person back here
//   POST /api/accounts/remove {id}
//   GET  /api/folders                                    -> [{ account, folders } | { account, error }]
//   GET  /api/messages?account=<id>|all&folder=<id>|inbox|unread|important&cursor&limit
//   GET  /api/search?q=&account=<id>|all&cursor&limit    -> both: { messages, next, errors }
//   GET  /api/message?account=&folder=&id=               -> headers, html body, attachments
//   GET  /api/attachment?account=&folder=&id=&att=&name= -> the file
//   POST /api/actions {action, items: [{account, id, folder}]}
//   POST /api/upload?account=&name=  (raw file)          -> an attachment reference for /api/send
//   POST /api/send {account, to, cc, bcc, subject, text, attachments, replyTo}
//   GET  /health
// Writes need the header x-letterbox: 1, which a page on another site can't send without CORS.
// A list over several mailboxes takes the newest mail of each and hands back a cursor: where each mailbox
// is up to, so the next page carries on in every one of them.
//
// env LETTERBOX_ZOHO_APP (Zoho client JSON: client_id, client_secret, redirect_uri), LETTERBOX_DATA
//     (accounts.json's folder, /var/lib/marobotic-letterbox), LETTERBOX_KEY (/etc/marobotic/letterbox.key),
//     LETTERBOX_USERS (comma separated; empty lets every marobotic account in), LETTERBOX_PORT (8970),
//     LETTERBOX_HOST (127.0.0.1), LETTERBOX_COOKIE_PATH (/), MARO_ACCOUNT_URL (http://127.0.0.1:8900),
//     LETTERBOX_ZOHO + LETTERBOX_CARRY_OVER: the old Self Client mailbox and the account it is carried over to.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Zoho, ID, accountsServer, exchange, revoke, authorizeUrl, type Mailbox, type Action, type Upload, type Summary, type ZohoApp, type ZohoLogin } from "./zoho.ts";
import { AccountStore, publicAccount, type Account } from "./accounts.ts";

const MAX_JSON = 1024 * 1024;
const MAX_FILE = 20 * 1024 * 1024;
const COOKIE = "lb_session";
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", woff2: "font/woff2", svg: "image/svg+xml", png: "image/png" };
// The message iframe (srcdoc) inherits this policy, so mail may load images, styles and fonts from the web;
// scripts only ever come from here, and the mail itself runs in a script-less sandbox.
const CSP = "default-src 'self'; img-src 'self' https: http: data:; style-src 'self' 'unsafe-inline' https:; font-src 'self' https: data:; media-src https: data:; frame-ancestors 'none'; form-action 'self'";
const ACTIONS = new Set(["read", "unread", "spam", "notspam", "important", "unimportant", "delete"]);
const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
// The rest of an over-size body is never read, so the connection has to go with the answer.
const tooBig = (max: number) => Object.assign(fail(413, `That's over ${Math.round(max / 1048576)} MB`), { close: true });

/** "a@x.com, Bee <b@y.org>; c@z.net" -> "a@x.com,b@y.org,c@z.net"; throws on anything that isn't an address. */
export function addresses(s: unknown): string {
  const out: string[] = [];
  for (const part of String(s ?? "").split(/[,;\n]/)) {
    const t = part.trim();
    if (!t) continue;
    const a = (/<([^>]+)>\s*$/.exec(t)?.[1] ?? t).trim();
    if (!ADDRESS.test(a)) throw fail(400, `"${t}" isn't an email address`);
    out.push(a);
  }
  return out.join(",");
}

/** The plain text someone typed, as the HTML body Zoho sends. */
export function textToHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<div style="font-family: sans-serif; white-space: pre-wrap">${esc.replace(/\r?\n/g, "<br>")}</div>`;
}

const ORIGINS = new Set(["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost", "http://127.0.0.1:8970"]);
const ACCOUNT_ID = /^[0-9a-f]{12}$/;
const VIEWS = new Set(["inbox", "unread", "important"]);   // lists that also work over every mailbox at once

/** Where each mailbox of a list is up to: its next 1-based start, or -1 once it has nothing more. */
type Cursor = Record<string, number>;
export const writeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString("base64url");
export function readCursor(s: string): Cursor {
  if (!s) return {};
  try {
    const o = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    const out: Cursor = {};
    for (const [k, v] of Object.entries(o ?? {})) if (ACCOUNT_ID.test(k) && Number.isInteger(v) && ((v as number) >= 1 || v === -1)) out[k] = v as number;
    return out;
  } catch { return {}; }
}

/** One page over several mailboxes, newest first, and the cursor for the next (null when all are done). */
export async function merged(accounts: string[], cursor: Cursor, limit: number, page: (account: string, start: number) => Promise<Summary[]>) {
  const live = accounts.filter((a) => cursor[a] !== -1);
  const got = await Promise.allSettled(live.map((a) => page(a, cursor[a] ?? 1)));
  const errors: { account: string; error: string }[] = [];
  const pool: Summary[] = [];
  live.forEach((a, i) => {
    const g = got[i]!;
    if (g.status === "fulfilled") pool.push(...g.value.map((m) => ({ ...m, account: a })));
    else errors.push({ account: a, error: (g.reason as Error).message });
  });
  pool.sort((x, y) => y.time - x.time);
  const messages = pool.slice(0, limit);
  const next: Cursor = { ...cursor };
  live.forEach((a, i) => {
    const g = got[i]!;
    if (g.status !== "fulfilled") return void (next[a] = -1);   // its error shows once; the rest of the list goes on
    const taken = messages.filter((m) => m.account === a).length;
    next[a] = taken === g.value.length && g.value.length < limit ? -1 : (cursor[a] ?? 1) + taken;
  });
  const done = accounts.every((a) => next[a] === -1);
  return { messages, next: done ? null : writeCursor(next), errors };
}

/** Zoho's side of adding an account; the tests stand in a fake. */
export type ZohoApi = {
  exchange(code: string, accounts: string): Promise<string>;
  revoke(accounts: string, refreshToken: string): Promise<void>;
  open(login: ZohoLogin): Mailbox;
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
// What the browser shows after Zoho's sign-in, when it doesn't go straight back to Letterbox.
const donePage = (title: string, text: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Letterbox</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#121212;color:#f5f5f5;font:15px/1.5 system-ui,sans-serif}main{max-width:420px;padding:24px;text-align:center}h1{font:700 20px ui-monospace,monospace;margin:0 0 8px}p{color:#969696;margin:0 0 18px}a{color:#B14242;font-weight:700}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(text)}</p><a href="../">Open Letterbox</a></main></body></html>`;

export function createLetterboxServer(opts: {
  store: AccountStore; zoho: ZohoApp | null; zohoApi?: ZohoApi;
  accountUrl: string; users?: string[]; webDir: string; cookiePath?: string; secure?: boolean;
}) {
  const { store, zoho, accountUrl, webDir, cookiePath = "/", secure = true } = opts;
  const zohoApi: ZohoApi = opts.zohoApi ?? {
    exchange: (code, accounts) => exchange(zoho!, code, accounts),
    revoke,
    open: (login) => new Zoho(login),
  };
  const users = new Set((opts.users ?? []).map((u) => u.trim().toLowerCase()).filter(Boolean));
  const allowed = (email: string) => !users.size || users.has(email);
  const sessions = new Map<string, { email: string | null; until: number }>();
  // Zoho sign-ins under way: the state Zoho hands back, and whose it is. Each is good once, for 15 minutes.
  const pending = new Map<string, { owner: string; app: boolean; until: number }>();
  // An open mailbox keeps its access token for the hour Zoho gives it.
  const boxes = new Map<string, Mailbox>();
  function box(a: Account): Mailbox {
    let b = boxes.get(a.id);
    if (!b) {
      const client = a.client
        ? { client_id: a.client.id, client_secret: store.open(a.client.secret) }
        : { client_id: zoho?.client_id ?? "", client_secret: zoho?.client_secret ?? "" };
      b = zohoApi.open({ ...client, refresh_token: store.open(a.token), accounts: a.accounts, accountId: a.zohoId });
      boxes.set(a.id, b);
    }
    return b;
  }
  const folderCache = new Map<string, { at: number; list: Awaited<ReturnType<Mailbox["folders"]>> }>();
  async function folders(a: Account) {
    const hit = folderCache.get(a.id);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.list;
    const list = await box(a).folders();
    folderCache.set(a.id, { at: Date.now(), list });
    return list;
  }
  const forget = (id: string) => { boxes.delete(id); folderCache.delete(id); };

  function cookieOf(req: IncomingMessage): string {
    for (const part of String(req.headers.cookie ?? "").split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === COOKIE) return decodeURIComponent(v.join("="));
    }
    return "";
  }
  function sessionOf(req: IncomingMessage): string {
    const auth = req.headers.authorization ?? "";
    if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
    return cookieOf(req);
  }
  const setCookie = (value: string, maxAge: number) =>
    `${COOKIE}=${encodeURIComponent(value)}; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

  /** The signed-in account's email, when it is one of the allowed users. */
  async function who(req: IncomingMessage): Promise<string> {
    const session = sessionOf(req);
    if (!session) throw fail(401, "Sign in");
    const k = sha(session);
    const hit = sessions.get(k);
    let email: string | null;
    if (hit && hit.until > Date.now()) email = hit.email;
    else {
      try {
        const r = await fetch(`${accountUrl}/account`, { headers: { authorization: `Bearer ${session}` }, signal: AbortSignal.timeout(8000) });
        if (r.ok) {
          const o = (await r.json()) as { account?: { email?: string }; email?: string };
          email = String(o.account?.email || o.email || "").toLowerCase() || null;
        } else if (r.status === 401 || r.status === 403) email = null;
        else throw new Error("account server");
      } catch {
        if (!hit?.email) throw fail(503, "The account server is not answering. Try again in a moment.");
        email = hit.email;
      }
      sessions.set(k, { email, until: Date.now() + (email ? 10 * 60_000 : 30_000) });
    }
    if (!email) throw fail(401, "Sign in again");
    if (!allowed(email)) throw fail(403, "This marobotic account can't use Letterbox yet");
    return email;
  }

  async function read(req: IncomingMessage, max: number): Promise<Buffer> {
    if (Number(req.headers["content-length"]) > max) throw tooBig(max);
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req as AsyncIterable<Buffer>) {
      n += c.length;
      if (n > max) throw tooBig(max);
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }
  async function json<T>(req: IncomingMessage): Promise<T> {
    try { return JSON.parse((await read(req, MAX_JSON)).toString("utf8")) as T; } catch (e) { throw (e as { status?: number }).status ? e : fail(400, "not JSON"); }
  }

  async function serveStatic(path: string, res: ServerResponse): Promise<boolean> {
    const rel = path === "/" ? "index.html" : normalize(decodeURIComponent(path)).replace(/^[\\/]+/, "");
    if (rel.startsWith("..") || rel.includes(":")) return false;
    const type = TYPES[rel.split(".").pop() ?? ""];
    if (!type) return false;
    try {
      const body = await readFile(join(webDir, rel));
      // nginx adds the site's X-Frame-Options and Referrer-Policy; frame-ancestors covers framing here.
      const page = rel.endsWith(".html") ? { "content-security-policy": CSP } : {};
      res.writeHead(200, { "content-type": type, "cache-control": rel.endsWith(".html") ? "no-cache" : "public, max-age=300", "x-content-type-options": "nosniff", ...page });
      res.end(res.req.method === "HEAD" ? undefined : body);
      return true;
    } catch { return false; }
  }

  /** Zoho's sign-in comes back here: the code becomes a refresh token, and each mailbox it opens is added. */
  async function zohoCallback(url: URL, res: ServerResponse) {
    const html = (status: number, title: string, text: string) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
      res.end(donePage(title, text));
    };
    const state = url.searchParams.get("state") ?? "";
    const p = pending.get(state);
    pending.delete(state);
    if (!p || p.until < Date.now()) return html(400, "That sign-in ran out", "Start again in Letterbox: Settings, Add Zoho account.");
    if (url.searchParams.get("error")) return html(400, "No account added", "Zoho's sign-in was cancelled.");
    const code = url.searchParams.get("code") ?? "";
    const accounts = accountsServer(url.searchParams.get("accounts-server") || "https://accounts.zoho.com");
    if (!code || !accounts || !zoho) return html(400, "No account added", "Zoho sent back something Letterbox can't use. Try again.");
    const added: string[] = [];
    try {
      const refresh = await zohoApi.exchange(code, accounts);
      const found = await zohoApi.open({ client_id: zoho.client_id, client_secret: zoho.client_secret, refresh_token: refresh, accounts }).mailboxes();
      if (!found.length) {
        await zohoApi.revoke(accounts, refresh);
        return html(400, "No account added", "That Zoho account has no mailbox.");
      }
      const old = new Set<string>();
      for (const m of found) {
        const { account, replaced } = store.put(p.owner, { email: m.email, name: m.name, zohoId: m.id, accounts, refreshToken: refresh });
        forget(account.id);
        if (replaced) old.add(replaced);
        added.push(m.email);
      }
      // Adding an account again gives it a new token; the old one is ended (Zoho caps how many one client holds).
      for (const t of old) if (t !== refresh) await zohoApi.revoke(accounts, t).catch(() => {});
    } catch (e) {
      console.error("zoho sign-in:", (e as Error).message);
      return html(502, "No account added", (e as Error).message);
    }
    if (!p.app) {
      res.writeHead(302, { location: `../?added=${encodeURIComponent(added.join(", "))}`, "cache-control": "no-store" });
      return res.end();
    }
    return html(200, "Account added", `${added.join(", ")} is in Letterbox now. Go back to the app; this tab can close.`);
  }

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const origin = String(req.headers.origin ?? "");
    const cors: Record<string, string> = ORIGINS.has(origin)
      ? { "access-control-allow-origin": origin, "access-control-allow-headers": "authorization, content-type, x-letterbox", "access-control-allow-methods": "GET, POST, OPTIONS", vary: "origin" }
      : {};
    const send = (status: number, obj: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors, ...headers });
      res.end(JSON.stringify(obj));
    };
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const q = (k: string) => url.searchParams.get(k) ?? "";
    try {
      if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
      if (path === "/health") return send(200, { ok: true });
      if (path === "/oauth/zoho" && req.method === "GET") return await zohoCallback(url, res);
      if ((req.method === "GET" || req.method === "HEAD") && !path.startsWith("/api/") && !path.startsWith("/auth/")) {
        if (await serveStatic(path, res)) return;
        return send(404, { error: "not found" });
      }
      const writing = req.method !== "GET" && req.method !== "HEAD";
      if (writing && req.headers["x-letterbox"] !== "1") return send(403, { error: "missing x-letterbox header" });

      if ((path === "/auth/login" || path === "/auth/register") && req.method === "POST") {
        const body = await json<{ email?: string; password?: string }>(req);
        const email = String(body.email ?? "").trim().toLowerCase(), password = body.password;
        if (!allowed(email)) return send(403, { error: "This marobotic account can't use Letterbox yet" });
        const r = await fetch(`${accountUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(15000) });
        const out = (await r.json().catch(() => ({}))) as { session?: string; account?: { email?: string }; error?: string; retryIn?: number };
        if (!r.ok || !out.session) return send(r.status >= 500 ? 503 : 401, { error: out.error || "That email and password don't match a marobotic account.", retryIn: out.retryIn });
        const got = String(out.account?.email ?? email).toLowerCase();
        if (!allowed(got)) return send(403, { error: "This marobotic account can't use Letterbox yet" });
        sessions.set(sha(out.session), { email: got, until: Date.now() + 10 * 60_000 });
        return send(200, { ok: true, session: out.session, email: got }, { "set-cookie": setCookie(out.session, 30 * 86400) });
      }
      if (path === "/auth/forgot" && req.method === "POST") {
        const body = await json<{ email?: string; app?: string }>(req);
        const email = String(body.email ?? "").trim().toLowerCase();
        const r = await fetch(`${accountUrl}/auth/forgot`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, app: body.app || "music" }), signal: AbortSignal.timeout(15000) });
        const out = (await r.json().catch(() => ({}))) as { error?: string };
        if (!r.ok) return send(r.status >= 500 ? 503 : r.status, { error: out.error || "That didn't work. Try again in a minute." });
        return send(200, { ok: true });
      }
      if (path === "/auth/logout" && req.method === "POST") {
        const s = sessionOf(req);
        if (s) sessions.delete(sha(s));
        return send(200, { ok: true }, { "set-cookie": setCookie("", 0) });
      }

      if (!path.startsWith("/api/")) return send(404, { error: "not found" });
      const email = await who(req);
      const mine = () => store.of(email);
      /** One of the signed-in person's mailboxes; nobody else's. */
      const pick = (id: string) => {
        const a = store.get(email, id);
        if (!a) throw fail(404, "That mailbox isn't in your Letterbox");
        return a;
      };
      const listArgs = () => ({
        cursor: readCursor(q("cursor")),
        limit: Math.min(200, Math.max(1, Number(q("limit")) || 50)),
        targets: q("account") === "all" ? mine() : [pick(q("account"))],
      });

      if (path === "/api/me" && req.method === "GET") return send(200, { email, accounts: mine().map(publicAccount), canAdd: Boolean(zoho) });
      if (path === "/api/accounts/connect" && req.method === "POST") {
        if (!zoho) return send(503, { error: "Adding Zoho accounts isn't set up on this server yet" });
        const body = await json<{ app?: boolean }>(req);
        const now = Date.now();
        for (const [k, v] of pending) if (v.until < now) pending.delete(k);
        const state = randomBytes(24).toString("hex");
        pending.set(state, { owner: email, app: Boolean(body.app), until: now + 15 * 60_000 });
        return send(200, { url: authorizeUrl(zoho, state) });
      }
      if (path === "/api/accounts/remove" && req.method === "POST") {
        const { id } = await json<{ id?: string }>(req);
        const a = store.remove(email, String(id ?? ""));
        if (!a) return send(404, { error: "That mailbox isn't in your Letterbox" });
        forget(a.id);
        // A carried-over mailbox's token belongs to the old Self Client, so it is left alone.
        if (!a.client && !store.usesToken(store.open(a.token))) await zohoApi.revoke(a.accounts, store.open(a.token)).catch(() => {});
        return send(200, { ok: true });
      }

      if (path === "/api/folders" && req.method === "GET") {
        return send(200, await Promise.all(mine().map((a) => folders(a).then(
          (list) => ({ account: a.id, folders: list }),
          (e: Error) => ({ account: a.id, error: e.message }),
        ))));
      }
      if (path === "/api/messages" && req.method === "GET") {
        const folder = q("folder");
        const { cursor, limit, targets } = listArgs();
        if (!VIEWS.has(folder) && (!ID.test(folder) || targets.length !== 1)) return send(400, { error: "folder is required" });
        return send(200, await merged(targets.map((a) => a.id), cursor, limit, async (id, start) => {
          const a = pick(id);
          if (folder === "unread") return box(a).messages({ unread: true, start, limit });
          if (folder === "important") return box(a).messages({ flagged: true, start, limit });
          const folderId = folder === "inbox" ? (await folders(a)).find((f) => f.type === "Inbox")?.id : folder;
          return folderId ? box(a).messages({ folderId, start, limit }) : [];
        }));
      }
      if (path === "/api/search" && req.method === "GET") {
        const text = q("q").trim().slice(0, 300);
        if (!text) return send(400, { error: "What should I search for?" });
        const { cursor, limit, targets } = listArgs();
        return send(200, await merged(targets.map((a) => a.id), cursor, limit, (id, start) => box(pick(id)).search(text, start, limit)));
      }
      if (path === "/api/message" && req.method === "GET") return send(200, await box(pick(q("account"))).message(q("folder"), q("id")));
      if (path === "/api/attachment" && req.method === "GET") {
        const r = await box(pick(q("account"))).attachment(q("folder"), q("id"), q("att"));
        if (!r.ok || !r.body) return send(502, { error: "Zoho didn't hand over that file" });
        const name = (q("name") || "attachment").replace(/[\r\n"\\/]/g, "_");
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          ...cors,
        });
        for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
        return res.end();
      }

      if (path === "/api/actions" && req.method === "POST") {
        const { action, items } = await json<{ action?: string; items?: { account?: string; id?: string; folder?: string }[] }>(req);
        if (!ACTIONS.has(String(action)) || !Array.isArray(items) || !items.length || items.length > 500) return send(400, { error: "bad action" });
        const list = items.map((i) => ({ account: String(i.account ?? ""), id: String(i.id ?? ""), folder: String(i.folder ?? "") }));
        if (!list.every((i) => ID.test(i.id) && ID.test(i.folder))) return send(400, { error: "bad message id" });
        const groups = new Map<Account, typeof list>();
        for (const i of list) {
          const a = pick(i.account);
          groups.set(a, [...(groups.get(a) ?? []), i]);
        }
        let done = 0, why = "";
        const failed: string[] = [];
        const miss = (ids: string[]) => (e: Error) => { failed.push(...ids); why ||= e.message; };
        for (const [a, group] of groups) {
          const mail = box(a);
          if (action !== "delete") {
            await mail.update(action as Action, group.map((i) => i.id)).then(() => void (done += group.length), miss(group.map((i) => i.id)));
            continue;
          }
          // Delete moves to Trash; deleting from Trash (or Spam) removes the mail for good.
          const gone = new Set((await folders(a)).filter((f) => f.type === "Trash" || f.type === "Spam").map((f) => f.id));
          for (let i = 0; i < group.length; i += 6) {
            await Promise.all(group.slice(i, i + 6).map((m) => mail.remove(m.folder, m.id, gone.has(m.folder)).then(() => void done++, miss([m.id]))));
          }
        }
        if (failed.length && !done) return send(502, { error: why || "Zoho didn't do that", done, failed });
        return send(200, { ok: !failed.length, done, failed });
      }

      if (path === "/api/upload" && req.method === "POST") {
        const name = q("name").replace(/[\r\n\\/]/g, "_").slice(0, 200);
        if (!name) return send(400, { error: "name is required" });
        const a = pick(q("account"));
        return send(200, await box(a).upload(name, await read(req, MAX_FILE)));
      }
      if (path === "/api/send" && req.method === "POST") {
        const m = await json<{ account?: string; to?: string; cc?: string; bcc?: string; subject?: string; text?: string; attachments?: Upload[]; replyTo?: string }>(req);
        const a = pick(String(m.account ?? ""));
        const to = addresses(m.to);
        if (!to) return send(400, { error: "Who is it to?" });
        const attachments = (Array.isArray(m.attachments) ? m.attachments : []).slice(0, 20).map((x) => ({
          storeName: String(x.storeName), attachmentPath: String(x.attachmentPath), attachmentName: String(x.attachmentName),
        }));
        await box(a).send({
          to, cc: addresses(m.cc), bcc: addresses(m.bcc), subject: String(m.subject ?? "").slice(0, 500),
          html: textToHtml(String(m.text ?? "")), attachments, ...(m.replyTo ? { replyTo: String(m.replyTo) } : {}),
        });
        return send(200, { ok: true });
      }
      send(404, { error: "not found" });
    } catch (e) {
      const err = e as Error & { status?: number; close?: boolean };
      if (!err.status || err.status >= 500) console.error(req.method, path, err.message);
      if (!res.headersSent) send(err.status ?? 500, { error: err.status ? err.message : "something went wrong" }, err.close ? { connection: "close" } : {});
      else res.end();
    }
  });
}

/** The mailbox Letterbox opened before accounts existed (a Self Client token): added once to `owner`, with
 *  the client it was made with. Removing it afterwards keeps it removed. */
export async function carryOver(store: AccountStore, file: string, owner: string): Promise<void> {
  const cfg = JSON.parse(readFileSync(file, "utf8")) as { client_id: string; client_secret: string; refresh_token: string; accounts?: string };
  const accounts = cfg.accounts ?? "https://accounts.zoho.com";
  const found = await new Zoho({ ...cfg, accounts }).mailboxes();
  for (const m of found) {
    const key = `${owner} ${accounts} ${m.id}`;
    if (store.carried(key)) continue;
    store.put(owner, { email: m.email, name: m.name, zohoId: m.id, accounts, refreshToken: cfg.refresh_token, client: { id: cfg.client_id, secret: cfg.client_secret } });
    store.markCarried(key);
    console.log(`carried ${m.email} over to ${owner}`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!)) {
  const env = process.env;
  const store = new AccountStore(join(env.LETTERBOX_DATA || "/var/lib/marobotic-letterbox", "accounts.json"), env.LETTERBOX_KEY || "/etc/marobotic/letterbox.key");
  const appFile = env.LETTERBOX_ZOHO_APP;
  const zoho: ZohoApp | null = appFile && existsSync(appFile) ? JSON.parse(readFileSync(appFile, "utf8")) : null;
  if (!zoho) console.warn("No LETTERBOX_ZOHO_APP: nobody can add a Zoho account yet");
  const old = env.LETTERBOX_ZOHO, owner = env.LETTERBOX_CARRY_OVER?.trim().toLowerCase();
  if (old && owner && existsSync(old)) carryOver(store, old, owner).catch((e) => console.error("carry over:", (e as Error).message));
  const port = Number(env.LETTERBOX_PORT || 8970);
  const host = env.LETTERBOX_HOST || "127.0.0.1";
  createLetterboxServer({
    store, zoho,
    accountUrl: (env.MARO_ACCOUNT_URL || "http://127.0.0.1:8900").replace(/\/+$/, ""),
    users: (env.LETTERBOX_USERS || "").split(","),
    webDir: env.LETTERBOX_WEB || fileURLToPath(new URL("../dist/", import.meta.url)),
    cookiePath: env.LETTERBOX_COOKIE_PATH || "/",
    secure: env.LETTERBOX_INSECURE_COOKIE !== "1",
  }).listen(port, host, () => console.log(`letterbox on http://${host}:${port}`));
}
