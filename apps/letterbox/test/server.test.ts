import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createLetterboxServer, addresses, textToHtml, merged, readCursor, writeCursor, type ZohoApi } from "../server/server.ts";
import { AccountStore } from "../server/accounts.ts";
import { parseLong, inlineCid, imageType, accountsServer, mailServer, type Mailbox, type Outgoing, type Summary } from "../server/zoho.ts";

// A stand-in for maro-cache: two marobotic accounts, both with password "pw".
const sessions: Record<string, string> = { "s-mi": "mi@marobotic.dev", "s-friend": "friend@example.com" };
const calls: string[] = [];
const sent: { box: string; m: Outgoing }[] = [];
const revoked: string[] = [];

// Two Zoho sign-ins: code-a opens a@zoho.com (Inbox 10, Trash 14), code-b opens b@zoho.eu (Inbox 20).
// Each inbox holds mail a minute apart, a's on the even minutes and b's on the odd ones.
const mailOf = (box: string, n: number, offset: number): Summary[] => Array.from({ length: n }, (_, i) => ({
  id: `${box === "a" ? 1 : 2}${String(i).padStart(3, "0")}`, threadId: null, threadCount: 0, folderId: box === "a" ? "10" : "20",
  from: box, fromAddress: `${box}@x.com`, to: "", subject: `${box}${i}`, summary: "", time: 1e9 - (2 * i + offset) * 60_000,
  unread: true, attachment: false, flagged: false,
}));
function fakeBox(box: "a" | "b"): Mailbox {
  const all = mailOf(box, box === "a" ? 5 : 3, box === "a" ? 0 : 1);
  return {
    mailboxes: async () => [box === "a" ? { id: "900", email: "a@zoho.com", name: "A" } : { id: "901", email: "b@zoho.eu", name: "B" }],
    accountInfo: async () => ({ id: "900", email: `${box}@zoho`, name: box }),
    folders: async () => box === "a"
      ? [{ id: "10", name: "Inbox", type: "Inbox", path: "/Inbox" }, { id: "14", name: "Trash", type: "Trash", path: "/Trash" }]
      : [{ id: "20", name: "Inbox", type: "Inbox", path: "/Inbox" }],
    messages: async (q) => (calls.push(`${box} list ${q.folderId ?? (q.flagged ? "important" : "unread")} ${q.start}`), all.slice((q.start ?? 1) - 1, (q.start ?? 1) - 1 + (q.limit ?? 50))),
    search: async (q, start) => (calls.push(`${box} search ${q} ${start}`), []),
    message: async (folderId, id) => ({ id, folderId, from: box, fromAddress: "a@x.com", to: "", cc: "", subject: "Hi", time: 1, html: `<p>${box}</p>`, attachments: [] }),
    attachment: async () => new Response(`FILE-${box}`),
    update: async (action, ids) => void calls.push(`${box} ${action} ${ids.join(",")}`),
    remove: async (folder, id, forever) => void calls.push(`${box} delete ${folder}/${id}${forever ? " forever" : ""}`),
    upload: async (name, body) => (calls.push(`${box} upload ${name} ${body.length}`), { storeName: box, attachmentPath: "/p", attachmentName: name }),
    send: async (m) => void sent.push({ box, m }),
  };
}
const zohoApi: ZohoApi = {
  exchange: async (code, accounts) => {
    calls.push(`exchange ${code} ${accounts}`);
    if (code === "code-a") return "rt-a";
    if (code === "code-b") return "rt-b";
    throw Object.assign(new Error("Zoho didn't sign you in (invalid_code)"), { status: 502 });
  },
  revoke: async (_accounts, token) => void revoked.push(token),
  open: (login) => fakeBox(login.refresh_token === "rt-b" ? "b" : "a"),
};

let account: Server, app: Server, base = "", web = "", data = "";
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
    if (req.url === "/auth/forgot") return res.writeHead(200).end(JSON.stringify({ ok: true }));
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => account.listen(0, "127.0.0.1", ok));
  web = mkdtempSync(join(tmpdir(), "letterbox-web-"));
  data = mkdtempSync(join(tmpdir(), "letterbox-data-"));
  writeFileSync(join(web, "index.html"), "<!doctype html>LETTERBOX");
  app = createLetterboxServer({
    store: new AccountStore(join(data, "accounts.json"), join(data, "key")),
    zoho: { client_id: "cid", client_secret: "secret", redirect_uri: "https://marobotic.dev/letterbox/oauth/zoho" },
    zohoApi,
    accountUrl: `http://127.0.0.1:${(account.address() as AddressInfo).port}`, webDir: web, secure: false,
  });
  await new Promise<void>((ok) => app.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
after(() => {
  app.closeAllConnections(); account.closeAllConnections(); app.close(); account.close();
  rmSync(web, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true });
});

const W = { "x-letterbox": "1", "content-type": "application/json" };
const me = { cookie: "lb_session=s-mi" };
const friend = { cookie: "lb_session=s-friend" };
const post = (path: string, body: unknown, headers: Record<string, string> = { ...W, ...me }) =>
  fetch(base + path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
const get = async (path: string, headers: Record<string, string> = me) => (await fetch(base + path, { headers })).json();

/** Signs in to Zoho through Letterbox: connect, then Zoho's redirect back with the code. */
async function addZoho(code: string, who = me, extra = "", app = false) {
  const { url } = await (await post("/api/accounts/connect", { app }, { ...W, ...who })).json();
  const state = new URL(url).searchParams.get("state")!;
  return fetch(`${base}/oauth/zoho?code=${code}&state=${state}${extra}`, { redirect: "manual" });
}
let A = "", B = "";

test("the page is served, nothing outside it is", async () => {
  assert.match(await (await fetch(base + "/")).text(), /LETTERBOX/);
  assert.equal((await fetch(base + "/..%2f..%2fetc/passwd")).status, 404);
  assert.equal((await fetch(base + "/server.ts")).status, 404);
});

test("any marobotic account signs in, and the session lands in both JSON and an HttpOnly cookie", async () => {
  assert.equal((await post("/auth/login", { email: "mi@marobotic.dev", password: "nope" }, W)).status, 401);
  assert.equal((await post("/auth/login", { email: "mi@marobotic.dev", password: "pw" }, { "content-type": "application/json" })).status, 403, "no x-letterbox header");
  const r = await post("/auth/login", { email: "MI@marobotic.dev", password: "pw" }, W);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, session: "s-mi", email: "mi@marobotic.dev" });
  const cookie = r.headers.get("set-cookie") ?? "";
  assert.match(cookie, /^lb_session=s-mi;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal((await post("/auth/login", { email: "friend@example.com", password: "pw" }, W)).status, 200);
  assert.equal((await post("/auth/forgot", { email: "mi@marobotic.dev" }, W)).status, 200);
});

test("the API wants a session (cookie or Bearer token, with Tauri CORS); a new account has no mailboxes", async () => {
  assert.equal((await fetch(base + "/api/folders")).status, 401);
  assert.equal((await fetch(base + "/api/folders", { headers: { cookie: "lb_session=bogus" } })).status, 401);
  assert.deepEqual(await get("/api/me"), { email: "mi@marobotic.dev", accounts: [], canAdd: true });
  const b = await fetch(base + "/api/me", { headers: { authorization: "Bearer s-mi", origin: "http://tauri.localhost" } });
  assert.equal(b.headers.get("access-control-allow-origin"), "http://tauri.localhost");
  assert.deepEqual(await get("/api/folders"), []);
});

test("adding Zoho accounts: Zoho's sign-in, the way back, each state good once", async () => {
  const { url } = await (await post("/api/accounts/connect", {})).json();
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://accounts.zoho.com/oauth/v2/auth");
  assert.equal(u.searchParams.get("redirect_uri"), "https://marobotic.dev/letterbox/oauth/zoho");
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.match(u.searchParams.get("scope")!, /ZohoMail\.messages\.ALL/);

  const r = await addZoho("code-a");
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "../?added=a%40zoho.com");
  assert.ok(calls.includes("exchange code-a https://accounts.zoho.com"));
  // From the Windows app the browser isn't Letterbox: it gets a page saying so. b lives in the EU data centre.
  const rb = await addZoho("code-b", me, "&accounts-server=https%3A%2F%2Faccounts.zoho.eu", true);
  assert.equal(rb.status, 200);
  assert.match(await rb.text(), /b@zoho\.eu is in Letterbox now/);
  assert.ok(calls.includes("exchange code-b https://accounts.zoho.eu"));

  const accounts = (await get("/api/me")).accounts;
  assert.deepEqual(accounts.map((a: any) => [a.email, a.color]), [["a@zoho.com", 0], ["b@zoho.eu", 1]]);
  [A, B] = accounts.map((a: any) => a.id);

  // Used, unknown or forged: nothing is added, and a foreign accounts server never gets the code.
  const { url: again } = await (await post("/api/accounts/connect", {})).json();
  const state = new URL(again).searchParams.get("state");
  assert.equal((await fetch(`${base}/oauth/zoho?code=code-a&state=${state}&accounts-server=https%3A%2F%2Fevil.example`)).status, 400);
  assert.equal((await fetch(`${base}/oauth/zoho?code=code-a&state=${state}`)).status, 400, "the state went with the first try");
  assert.equal((await fetch(`${base}/oauth/zoho?code=code-a&state=nope`)).status, 400);
  assert.equal((await addZoho("code-x")).status, 502);
  assert.equal((await addZoho("code-a", me, "&error=access_denied")).status, 400);
  assert.ok(!calls.some((c) => c.includes("evil")));
  assert.equal((await get("/api/me")).accounts.length, 2);

  // Adding the same account again replaces its token and ends the old one; it stays one account.
  revoked.length = 0;
  await addZoho("code-a");
  assert.equal((await get("/api/me")).accounts.length, 2);
  assert.deepEqual(revoked, [], "the new token is the same here, so nothing is ended");
  // The tokens on disk are sealed.
  assert.ok(!readFileSync(join(data, "accounts.json"), "utf8").includes("rt-a"));
});

test("one inbox over every mailbox: newest first, and the cursor carries on in each", async () => {
  calls.length = 0;
  const p1 = await get(`/api/messages?account=all&folder=inbox&limit=4`);
  assert.deepEqual(p1.messages.map((m: Summary) => m.subject), ["a0", "b0", "a1", "b1"]);
  assert.deepEqual(p1.messages.map((m: Summary) => m.account), [A, B, A, B]);
  assert.deepEqual(readCursor(p1.next), { [A]: 3, [B]: 3 });
  const p2 = await get(`/api/messages?account=all&folder=inbox&limit=4&cursor=${p1.next}`);
  assert.deepEqual(p2.messages.map((m: Summary) => m.subject), ["a2", "b2", "a3", "a4"]);
  assert.equal(p2.next, null);
  assert.ok(calls.includes("a list 10 3") && calls.includes("b list 20 3"));
  // One mailbox at a time, by its own folder.
  const one = await get(`/api/messages?account=${B}&folder=20`);
  assert.deepEqual(one.messages.map((m: Summary) => m.subject), ["b0", "b1", "b2"]);
  assert.equal(one.next, null);
  assert.equal((await fetch(`${base}/api/messages?account=all&folder=20`, { headers: me })).status, 400, "a folder id belongs to one mailbox");
  assert.equal((await fetch(`${base}/api/messages?account=${A}&folder=x`, { headers: me })).status, 400);
  await get(`/api/messages?account=all&folder=unread`);
  assert.ok(calls.includes("a list unread 1") && calls.includes("b list unread 1"));
  await get(`/api/search?q=%20english%20course&account=all`);
  assert.ok(calls.includes("a search english course 1") && calls.includes("b search english course 1"));
  assert.equal((await fetch(base + "/api/search?q=%20&account=all", { headers: me })).status, 400);
  const folders = await get("/api/folders");
  assert.deepEqual(folders.map((f: any) => [f.account, f.folders.length]), [[A, 2], [B, 1]]);
});

test("someone else's mailbox stays theirs", async () => {
  assert.deepEqual((await get("/api/me", friend)).accounts, []);
  assert.equal((await fetch(`${base}/api/messages?account=${A}&folder=10`, { headers: friend })).status, 404);
  assert.equal((await fetch(`${base}/api/message?account=${A}&folder=10&id=5`, { headers: friend })).status, 404);
  assert.equal((await post("/api/actions", { action: "delete", items: [{ account: A, id: "5", folder: "10" }] }, { ...W, ...friend })).status, 404);
  assert.equal((await post("/api/send", { account: A, to: "x@y.com", text: "hi" }, { ...W, ...friend })).status, 404);
  assert.equal((await post("/api/accounts/remove", { id: A }, { ...W, ...friend })).status, 404);
  assert.deepEqual(await get("/api/messages?account=all&folder=inbox", friend), { messages: [], next: null, errors: [] });
});

test("opens and downloads from the right mailbox", async () => {
  assert.equal((await get(`/api/message?account=${B}&folder=20&id=5`)).html, "<p>b</p>");
  const f = await fetch(`${base}/api/attachment?account=${A}&folder=10&id=5&att=7&name=r%C3%A9sum%C3%A9.pdf`, { headers: me });
  assert.equal(await f.text(), "FILE-a");
  assert.match(f.headers.get("content-disposition") ?? "", /^attachment; .*filename\*=UTF-8''r%C3%A9sum%C3%A9\.pdf/);
});

test("actions go to each message's own mailbox; delete only empties Trash for good", async () => {
  calls.length = 0;
  assert.equal((await post("/api/actions", { action: "read", items: [{ account: A, id: "1791642828411153400", folder: "10" }, { account: B, id: "2", folder: "20" }] })).status, 200);
  assert.equal((await post("/api/actions", { action: "important", items: [{ account: A, id: "3", folder: "10" }] })).status, 200);
  assert.equal((await post("/api/actions", { action: "delete", items: [{ account: A, id: "4", folder: "10" }, { account: A, id: "5", folder: "14" }, { account: B, id: "6", folder: "20" }] })).status, 200);
  assert.deepEqual(calls, ["a read 1791642828411153400", "b read 2", "a important 3", "a delete 10/4", "a delete 14/5 forever", "b delete 20/6"]);
  assert.equal((await post("/api/actions", { action: "explode", items: [{ account: A, id: "4", folder: "10" }] })).status, 400);
  assert.equal((await post("/api/actions", { action: "read", items: [{ account: A, id: "4 OR 1", folder: "10" }] })).status, 400);
  assert.equal((await fetch(base + "/api/actions", { method: "POST", headers: { ...me, "content-type": "application/json" }, body: "{}" })).status, 403, "no x-letterbox header");
});

test("upload and send from the chosen mailbox", async () => {
  const up = await fetch(`${base}/api/upload?account=${B}&name=a.txt`, { method: "POST", headers: { ...me, "x-letterbox": "1" }, body: "hello" });
  assert.deepEqual(await up.json(), { storeName: "b", attachmentPath: "/p", attachmentName: "a.txt" });
  // Refused before it is read: the client sees the 413, or the connection closing under its upload.
  const big = await fetch(`${base}/api/upload?account=${B}&name=b.bin`, { method: "POST", headers: { ...me, "x-letterbox": "1" }, body: Buffer.alloc(21 * 1024 * 1024) }).catch(() => null);
  assert.ok(!big || big.status === 413);
  assert.ok(!calls.some((c) => c.includes("upload b.bin")));
  assert.equal((await post("/api/send", { account: B, to: "not an address", text: "x" })).status, 400);
  assert.equal((await post("/api/send", { to: "b@y.org", text: "x" })).status, 404, "no mailbox named");
  const r = await post("/api/send", { account: B, to: "Bee <b@y.org>; c@z.net", subject: "Hello", text: "a <b>\nline", attachments: [{ storeName: "b", attachmentPath: "/p", attachmentName: "a.txt" }], replyTo: "99" });
  assert.equal(r.status, 200);
  const last = sent.at(-1)!;
  assert.equal(last.box, "b");
  assert.equal(last.m.to, "b@y.org,c@z.net");
  assert.equal(last.m.replyTo, "99");
  assert.match(last.m.html, /a &lt;b&gt;<br>line/);
  assert.equal(last.m.attachments!.length, 1);
});

test("removing a mailbox ends its token and takes it out of every list", async () => {
  revoked.length = 0;
  assert.equal((await post("/api/accounts/remove", { id: B })).status, 200);
  assert.deepEqual(revoked, ["rt-b"]);
  assert.deepEqual((await get("/api/me")).accounts.map((a: any) => a.email), ["a@zoho.com"]);
  assert.equal((await fetch(`${base}/api/messages?account=${B}&folder=20`, { headers: me })).status, 404);
  assert.deepEqual((await get("/api/messages?account=all&folder=inbox")).messages.map((m: Summary) => m.subject), ["a0", "a1", "a2", "a3", "a4"]);
  assert.equal((await post("/api/accounts/remove", { id: B })).status, 404);
});

test("the account store: sealed tokens, colours, carried-over mailboxes keep their own client", () => {
  const dir = mkdtempSync(join(tmpdir(), "letterbox-store-"));
  try {
    const s = new AccountStore(join(dir, "a.json"), join(dir, "key"));
    const old = s.put("mi", { email: "mi@x", name: "", zohoId: "1", accounts: "https://accounts.zoho.com", refreshToken: "self", client: { id: "self-id", secret: "self-secret" } });
    assert.equal(s.open(old.account.client!.secret), "self-secret");
    // Signing the same mailbox in properly later: the Self Client's token isn't Letterbox's to end.
    const now = s.put("mi", { email: "mi@x", name: "", zohoId: "1", accounts: "https://accounts.zoho.com", refreshToken: "new" });
    assert.equal(now.replaced, null);
    assert.equal(now.account.client, undefined);
    assert.equal(s.of("mi").length, 1);
    assert.equal(s.put("mi", { email: "two@x", name: "", zohoId: "2", accounts: "https://accounts.zoho.com", refreshToken: "t2" }).account.color, 1);
    s.markCarried("mi 1");
    const again = new AccountStore(join(dir, "a.json"), join(dir, "key"));
    assert.equal(again.of("mi").length, 2);
    assert.equal(again.open(again.of("mi")[0]!.token), "new");
    assert.ok(again.carried("mi 1"));
    assert.ok(again.usesToken("t2"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("helpers", async () => {
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
  assert.equal(accountsServer("https://accounts.zoho.eu"), "https://accounts.zoho.eu");
  assert.equal(accountsServer("https://accounts.zohocloud.ca"), "https://accounts.zohocloud.ca");
  assert.equal(accountsServer("https://accounts.zoho.ae"), "https://accounts.zoho.ae");
  assert.equal(accountsServer("https://accounts.zoho.eu.evil.com"), null);
  assert.equal(accountsServer("https://accounts.zohoXeu"), null);
  assert.equal(mailServer("https://accounts.zoho.com.au"), "https://mail.zoho.com.au");
  assert.deepEqual(readCursor(writeCursor({ "0123456789ab": 51, "ba9876543210": -1 })), { "0123456789ab": 51, "ba9876543210": -1 });
  assert.deepEqual(readCursor(writeCursor({ "../x": 1, "0123456789ab": 0 } as any)), {});
  assert.deepEqual(readCursor("not a cursor"), {});
  // A mailbox that fails shows its error once and drops out; the others carry on.
  const r = await merged(["0123456789ab", "ba9876543210"], {}, 2, async (a) => {
    if (a === "ba9876543210") throw new Error("Zoho signed this account out");
    return mailOf("a", 2, 0);
  });
  assert.deepEqual(r.errors, [{ account: "ba9876543210", error: "Zoho signed this account out" }]);
  assert.deepEqual(readCursor(r.next!), { "0123456789ab": 3, "ba9876543210": -1 });
});
