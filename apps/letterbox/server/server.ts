// Letterbox's server: the web client's pages plus a small API over the Zoho mailbox. Live at
// marobotic.dev/letterbox (nginx strips the prefix). Only the marobotic accounts in LETTERBOX_USERS may
// open the mailbox: sign-in goes to maro-cache (the shared account of Hourglass, Jukebox and Vault) and
// its session rides in an HttpOnly cookie, checked with maro-cache's GET /account.
//
//   POST /auth/login {email, password} | /auth/logout
//   GET  /api/me                                        -> { email, mailbox }
//   GET  /api/folders
//   GET  /api/messages?folder=<id>|unread&start&limit
//   GET  /api/message?folder=&id=                       -> headers, html body, attachments
//   GET  /api/attachment?folder=&id=&att=&name=         -> the file
//   POST /api/actions {action: read|unread|spam|notspam|delete, items: [{id, folder}]}
//   POST /api/upload?name=  (raw file)                  -> an attachment reference for /api/send
//   POST /api/send {to, cc, bcc, subject, text, attachments, replyTo}
//   GET  /health
// Writes need the header x-letterbox: 1, which a page on another site can't send without CORS.
//
// env LETTERBOX_ZOHO (Zoho config JSON), LETTERBOX_USERS (comma separated), LETTERBOX_PORT (8970),
//     LETTERBOX_HOST (127.0.0.1), LETTERBOX_COOKIE_PATH (/), MARO_ACCOUNT_URL (http://127.0.0.1:8900)
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Zoho, ID, type Mailbox, type Action, type Upload } from "./zoho.ts";

const MAX_JSON = 1024 * 1024;
const MAX_FILE = 20 * 1024 * 1024;
const COOKIE = "lb_session";
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", woff2: "font/woff2", svg: "image/svg+xml", png: "image/png" };
// The message iframe (srcdoc) inherits this policy, so mail may load images, styles and fonts from the web;
// scripts only ever come from here, and the mail itself runs in a script-less sandbox.
const CSP = "default-src 'self'; img-src 'self' https: http: data:; style-src 'self' 'unsafe-inline' https:; font-src 'self' https: data:; media-src https: data:; frame-ancestors 'none'; form-action 'self'";
const ACTIONS = new Set(["read", "unread", "spam", "notspam", "delete"]);
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

export function createLetterboxServer(opts: { mail: Mailbox; accountUrl: string; users: string[]; webDir: string; cookiePath?: string; secure?: boolean }) {
  const { mail, accountUrl, webDir, cookiePath = "/", secure = true } = opts;
  const users = new Set(opts.users.map((u) => u.trim().toLowerCase()).filter(Boolean));
  const sessions = new Map<string, { email: string | null; until: number }>();

  function cookieOf(req: IncomingMessage): string {
    for (const part of String(req.headers.cookie ?? "").split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === COOKIE) return decodeURIComponent(v.join("="));
    }
    return "";
  }
  const setCookie = (value: string, maxAge: number) =>
    `${COOKIE}=${encodeURIComponent(value)}; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

  /** The signed-in account's email, when it is one of the allowed users. */
  async function who(req: IncomingMessage): Promise<string> {
    const session = cookieOf(req);
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
    if (!users.has(email)) throw fail(403, "This marobotic account has no mailbox here");
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

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, obj: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
      res.end(JSON.stringify(obj));
    };
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const q = (k: string) => url.searchParams.get(k) ?? "";
    try {
      if (path === "/health") return send(200, { ok: true });
      if ((req.method === "GET" || req.method === "HEAD") && !path.startsWith("/api/") && !path.startsWith("/auth/")) {
        if (await serveStatic(path, res)) return;
        return send(404, { error: "not found" });
      }
      const writing = req.method !== "GET" && req.method !== "HEAD";
      if (writing && req.headers["x-letterbox"] !== "1") return send(403, { error: "missing x-letterbox header" });

      if (path === "/auth/login" && req.method === "POST") {
        const body = await json<{ email?: string; password?: string }>(req);
        const email = String(body.email ?? "").trim().toLowerCase(), password = body.password;
        if (!users.has(email)) return send(403, { error: "This marobotic account has no mailbox here" });
        const r = await fetch(`${accountUrl}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(15000) });
        const out = (await r.json().catch(() => ({}))) as { session?: string; account?: { email?: string }; error?: string; retryIn?: number };
        if (!r.ok || !out.session) return send(r.status >= 500 ? 503 : 401, { error: out.error || "That email and password don't match a marobotic account.", retryIn: out.retryIn });
        const got = String(out.account?.email ?? email).toLowerCase();
        if (!users.has(got)) return send(403, { error: "This marobotic account has no mailbox here" });
        sessions.set(sha(out.session), { email: got, until: Date.now() + 10 * 60_000 });
        return send(200, { ok: true }, { "set-cookie": setCookie(out.session, 30 * 86400) });
      }
      if (path === "/auth/logout" && req.method === "POST") {
        const s = cookieOf(req);
        if (s) sessions.delete(sha(s));
        return send(200, { ok: true }, { "set-cookie": setCookie("", 0) });
      }

      if (!path.startsWith("/api/")) return send(404, { error: "not found" });
      const email = await who(req);

      if (path === "/api/me" && req.method === "GET") return send(200, { email, mailbox: (await mail.accountInfo()).email });
      if (path === "/api/folders" && req.method === "GET") return send(200, await mail.folders());
      if (path === "/api/messages" && req.method === "GET") {
        const folder = q("folder");
        if (folder !== "unread" && !ID.test(folder)) return send(400, { error: "folder is required" });
        const start = Math.max(1, Number(q("start")) || 1);
        const limit = Math.min(200, Math.max(1, Number(q("limit")) || 50));
        return send(200, await mail.messages({ ...(folder === "unread" ? { unread: true } : { folderId: folder }), start, limit }));
      }
      if (path === "/api/message" && req.method === "GET") return send(200, await mail.message(q("folder"), q("id")));
      if (path === "/api/attachment" && req.method === "GET") {
        const r = await mail.attachment(q("folder"), q("id"), q("att"));
        if (!r.ok || !r.body) return send(502, { error: "Zoho didn't hand over that file" });
        const name = (q("name") || "attachment").replace(/[\r\n"\\/]/g, "_");
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        });
        for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
        return res.end();
      }

      if (path === "/api/actions" && req.method === "POST") {
        const { action, items } = await json<{ action?: string; items?: { id?: string; folder?: string }[] }>(req);
        if (!ACTIONS.has(String(action)) || !Array.isArray(items) || !items.length || items.length > 500) return send(400, { error: "bad action" });
        const list = items.map((i) => ({ id: String(i.id ?? ""), folder: String(i.folder ?? "") }));
        if (!list.every((i) => ID.test(i.id) && ID.test(i.folder))) return send(400, { error: "bad message id" });
        if (action !== "delete") {
          await mail.update(action as Action, list.map((i) => i.id));
          return send(200, { ok: true, done: list.length });
        }
        // Delete moves to Trash; deleting from Trash (or Spam) removes the mail for good.
        const folders = await mail.folders();
        const gone = new Set(folders.filter((f) => f.type === "Trash" || f.type === "Spam").map((f) => f.id));
        let done = 0;
        const failed: string[] = [];
        for (let i = 0; i < list.length; i += 6) {
          await Promise.all(list.slice(i, i + 6).map((m) => mail.remove(m.folder, m.id, gone.has(m.folder)).then(() => done++, () => failed.push(m.id))));
        }
        return send(failed.length && !done ? 502 : 200, { ok: !failed.length, done, failed });
      }

      if (path === "/api/upload" && req.method === "POST") {
        const name = q("name").replace(/[\r\n\\/]/g, "_").slice(0, 200);
        if (!name) return send(400, { error: "name is required" });
        return send(200, await mail.upload(name, await read(req, MAX_FILE)));
      }
      if (path === "/api/send" && req.method === "POST") {
        const m = await json<{ to?: string; cc?: string; bcc?: string; subject?: string; text?: string; attachments?: Upload[]; replyTo?: string }>(req);
        const to = addresses(m.to);
        if (!to) return send(400, { error: "Who is it to?" });
        const attachments = (Array.isArray(m.attachments) ? m.attachments : []).slice(0, 20).map((a) => ({
          storeName: String(a.storeName), attachmentPath: String(a.attachmentPath), attachmentName: String(a.attachmentName),
        }));
        await mail.send({
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

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!)) {
  const config = process.env.LETTERBOX_ZOHO;
  if (!config) { console.error("Set LETTERBOX_ZOHO to the Zoho config JSON path."); process.exit(1); }
  const port = Number(process.env.LETTERBOX_PORT || 8970);
  const host = process.env.LETTERBOX_HOST || "127.0.0.1";
  createLetterboxServer({
    mail: new Zoho(config),
    accountUrl: (process.env.MARO_ACCOUNT_URL || "http://127.0.0.1:8900").replace(/\/+$/, ""),
    users: (process.env.LETTERBOX_USERS || "").split(","),
    webDir: process.env.LETTERBOX_WEB || fileURLToPath(new URL("../dist/", import.meta.url)),
    cookiePath: process.env.LETTERBOX_COOKIE_PATH || "/",
    secure: process.env.LETTERBOX_INSECURE_COOKIE !== "1",
  }).listen(port, host, () => console.log(`letterbox on http://${host}:${port}`));
}
