import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createLetterboxServer, addresses, textToHtml } from "../server/server.ts";
import { parseLong, inlineCid, imageType, type Mailbox, type Outgoing } from "../server/zoho.ts";

// A stand-in for maro-cache: the mailbox owner and someone else, both with password "pw".
const sessions: Record<string, string> = { "s-mi": "mi@marobotic.dev", "s-friend": "friend@example.com" };
const calls: string[] = [];
let sent: Outgoing | null = null;
const fake: Mailbox = {
  accountInfo: async () => ({ id: "1", email: "mi@marobotic.dev", name: "Maro" }),
  folders: async () => [
    { id: "10", name: "Inbox", type: "Inbox", path: "/Inbox" },
    { id: "14", name: "Trash", type: "Trash", path: "/Trash" },
  ],
  messages: async (q) => (calls.push(`list ${q.folderId ?? (q.flagged ? "important" : "unread")} ${q.start}`), []),
  search: async (q, start) => (calls.push(`search ${q} ${start}`), []),
  message: async (folderId, id) => ({ id, folderId, from: "A", fromAddress: "a@x.com", to: "", cc: "", subject: "Hi", time: 1, html: "<p>hi</p>", attachments: [] }),
  attachment: async () => new Response("FILE"),
  update: async (action, ids) => void calls.push(`${action} ${ids.join(",")}`),
  remove: async (folder, id, forever) => void calls.push(`delete ${folder}/${id}${forever ? " forever" : ""}`),
  upload: async (name, body) => (calls.push(`upload ${name} ${body.length}`), { storeName: "s", attachmentPath: "/p", attachmentName: name }),
  send: async (m) => void (sent = m),
};

let account: Server, app: Server, base = "", web = "";
before(async () => {
  account = createServer((req, res) => {
    if (req.url === "/account") {
      const s = (req.headers.authorization ?? "").replace("Bearer ", "");
      return sessions[s] ? res.writeHead(200).end(JSON.stringify({ account: { email: sessions[s] } })) : res.writeHead(401).end("{}");
    }
    if (req.url === "/auth/login" || req.url === "/auth/register") {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        const { email, password } = JSON.parse(b);
        const s = Object.keys(sessions).find((k) => sessions[k] === email);
        if (s && password === "pw") res.writeHead(200).end(JSON.stringify({ session: s, account: { email } }));
        else res.writeHead(401).end(JSON.stringify({ error: "Wrong email or password." }));
      });
      return;
    }
    if (req.url === "/auth/forgot") {
      return res.writeHead(200).end(JSON.stringify({ ok: true }));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => account.listen(0, "127.0.0.1", ok));
  web = mkdtempSync(join(tmpdir(), "letterbox-web-"));
  writeFileSync(join(web, "index.html"), "<!doctype html>LETTERBOX");
  app = createLetterboxServer({ mail: fake, accountUrl: `http://127.0.0.1:${(account.address() as AddressInfo).port}`, users: ["mi@marobotic.dev"], webDir: web, secure: false });
  await new Promise<void>((ok) => app.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
after(() => { app.closeAllConnections(); account.closeAllConnections(); app.close(); account.close(); rmSync(web, { recursive: true, force: true }); });

const W = { "x-letterbox": "1", "content-type": "application/json" };
const me = { cookie: "lb_session=s-mi" };
const post = (path: string, body: unknown, headers: Record<string, string> = { ...W, ...me }) =>
  fetch(base + path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

test("the page is served, nothing outside it is", async () => {
  assert.match(await (await fetch(base + "/")).text(), /LETTERBOX/);
  assert.equal((await fetch(base + "/..%2f..%2fetc/passwd")).status, 404);
  assert.equal((await fetch(base + "/server.ts")).status, 404);
});

test("only the mailbox owner signs in, and the session lands in both JSON and an HttpOnly cookie", async () => {
  assert.equal((await post("/auth/login", { email: "friend@example.com", password: "pw" }, W)).status, 403);
  assert.equal((await post("/auth/login", { email: "mi@marobotic.dev", password: "nope" }, W)).status, 401);
  assert.equal((await post("/auth/login", { email: "mi@marobotic.dev", password: "pw" }, { "content-type": "application/json" })).status, 403, "no x-letterbox header");
  const r = await post("/auth/login", { email: "MI@marobotic.dev", password: "pw" }, W);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, session: "s-mi", email: "mi@marobotic.dev" });
  const cookie = r.headers.get("set-cookie") ?? "";
  assert.match(cookie, /^lb_session=s-mi;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal((await post("/auth/forgot", { email: "mi@marobotic.dev" }, W)).status, 200);
});

test("the API wants a session of an allowed account (cookie or Bearer token, with Tauri CORS)", async () => {
  assert.equal((await fetch(base + "/api/folders")).status, 401);
  assert.equal((await fetch(base + "/api/folders", { headers: { cookie: "lb_session=bogus" } })).status, 401);
  assert.equal((await fetch(base + "/api/folders", { headers: { cookie: "lb_session=s-friend" } })).status, 403);
  const r = await fetch(base + "/api/me", { headers: me });
  assert.deepEqual(await r.json(), { email: "mi@marobotic.dev", mailbox: "mi@marobotic.dev" });
  const b = await fetch(base + "/api/me", { headers: { authorization: "Bearer s-mi", origin: "http://tauri.localhost" } });
  assert.equal(b.headers.get("access-control-allow-origin"), "http://tauri.localhost");
  assert.deepEqual(await b.json(), { email: "mi@marobotic.dev", mailbox: "mi@marobotic.dev" });
});

test("lists, opens and downloads", async () => {
  assert.equal((await fetch(base + "/api/messages?folder=10&start=51", { headers: me })).status, 200);
  assert.equal((await fetch(base + "/api/messages?folder=important&start=1", { headers: me })).status, 200);
  assert.equal((await fetch(base + "/api/messages?folder=x", { headers: me })).status, 400);
  assert.ok(calls.includes("list 10 51"));
  assert.ok(calls.includes("list important 1"));
  assert.equal((await fetch(base + "/api/search?q=%20english%20course&start=51", { headers: me })).status, 200);
  assert.equal((await fetch(base + "/api/search?q=%20", { headers: me })).status, 400);
  assert.ok(calls.includes("search english course 51"));
  assert.equal((await (await fetch(base + "/api/message?folder=10&id=5", { headers: me })).json()).html, "<p>hi</p>");
  const f = await fetch(base + "/api/attachment?folder=10&id=5&att=7&name=r%C3%A9sum%C3%A9.pdf", { headers: me });
  assert.equal(await f.text(), "FILE");
  assert.match(f.headers.get("content-disposition") ?? "", /^attachment; .*filename\*=UTF-8''r%C3%A9sum%C3%A9\.pdf/);
});

test("actions: read, important, spam, and delete that only empties Trash for good", async () => {
  calls.length = 0;
  assert.equal((await post("/api/actions", { action: "read", items: [{ id: "1791642828411153400", folder: "10" }] })).status, 200);
  assert.equal((await post("/api/actions", { action: "important", items: [{ id: "1791642828411153400", folder: "10" }] })).status, 200);
  assert.equal((await post("/api/actions", { action: "unimportant", items: [{ id: "1791642828411153400", folder: "10" }] })).status, 200);
  assert.equal((await post("/api/actions", { action: "spam", items: [{ id: "2", folder: "10" }, { id: "3", folder: "10" }] })).status, 200);
  assert.equal((await post("/api/actions", { action: "delete", items: [{ id: "4", folder: "10" }, { id: "5", folder: "14" }] })).status, 200);
  assert.deepEqual(calls, ["read 1791642828411153400", "important 1791642828411153400", "unimportant 1791642828411153400", "spam 2,3", "delete 10/4", "delete 14/5 forever"]);
  assert.equal((await post("/api/actions", { action: "explode", items: [{ id: "4", folder: "10" }] })).status, 400);
  assert.equal((await post("/api/actions", { action: "read", items: [{ id: "4 OR 1", folder: "10" }] })).status, 400);
  assert.equal((await fetch(base + "/api/actions", { method: "POST", headers: { ...me, "content-type": "application/json" }, body: "{}" })).status, 403, "no x-letterbox header");
});

test("upload and send", async () => {
  const up = await fetch(base + "/api/upload?name=a.txt", { method: "POST", headers: { ...me, "x-letterbox": "1" }, body: "hello" });
  assert.deepEqual(await up.json(), { storeName: "s", attachmentPath: "/p", attachmentName: "a.txt" });
  // Refused before it is read: the client sees the 413, or the connection closing under its upload.
  const big = await fetch(base + "/api/upload?name=b.bin", { method: "POST", headers: { ...me, "x-letterbox": "1" }, body: Buffer.alloc(21 * 1024 * 1024) }).catch(() => null);
  assert.ok(!big || big.status === 413);
  assert.ok(!calls.some((c) => c.startsWith("upload b.bin")));
  assert.equal((await post("/api/send", { to: "not an address", text: "x" })).status, 400);
  const r = await post("/api/send", { to: "Bee <b@y.org>; c@z.net", subject: "Hello", text: "a <b>\nline", attachments: [{ storeName: "s", attachmentPath: "/p", attachmentName: "a.txt" }], replyTo: "99" });
  assert.equal(r.status, 200);
  assert.equal(sent!.to, "b@y.org,c@z.net");
  assert.equal(sent!.replyTo, "99");
  assert.match(sent!.html, /a &lt;b&gt;<br>line/);
  assert.equal(sent!.attachments!.length, 1);
});

test("helpers", () => {
  assert.equal(addresses(" a@x.com ,, \"Bee\" <b@y.org>\n"), "a@x.com,b@y.org");
  assert.equal(addresses(""), "");
  assert.throws(() => addresses("a@x.com, nope"));
  assert.equal(textToHtml("<script>"), '<div style="font-family: sans-serif; white-space: pre-wrap">&lt;script&gt;</div>');
  const zimg = '<img src="/mail/ImageDisplay?na=1&amp;nmsgId=2&amp;f=1.jpg&amp;mode=inline&amp;cid=ii_ab&amp;" alt="x"><img src="cid:ii_ab"><img src="/x?cid=ii_abc">';
  assert.equal(inlineCid(zimg, "ii_ab", "data:image/jpeg;base64,AA"), '<img src="data:image/jpeg;base64,AA" alt="x"><img src="data:image/jpeg;base64,AA"><img src="/x?cid=ii_abc">');
  assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.deepEqual(parseLong('{"data":[{"messageId":1791642828411153413,"n":5}]}'), { data: [{ messageId: "1791642828411153413", n: 5 }] });
  const body = 'a href=\\"https://t.co/?gids=[7681837357850529045,7694718800414903558]\\"';
  assert.deepEqual(parseLong(`{"data":{"messageId":1791831933908153400,"content":"${body}"}}`), { data: { messageId: "1791831933908153400", content: JSON.parse(`"${body}"`) } });
});
