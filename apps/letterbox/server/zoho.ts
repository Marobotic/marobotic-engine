// Zoho Mail REST API provider. Works on the Forever Free plan, which has no IMAP or SMTP.
// Each mailbox is one Zoho sign-in: a refresh token from Letterbox's Server-based client (Zoho API console,
// multi-DC on), scopes below. Zoho keeps every account in one data centre; its accounts server names it.

export const SCOPES = "ZohoMail.accounts.READ,ZohoMail.folders.ALL,ZohoMail.messages.ALL,ZohoMail.tags.ALL";
// accounts.zoho.com, .eu, .in, .com.au, .jp, .uk, .sa, .ae, .sg, .com.cn and accounts.zohocloud.ca. Only these may
// take a code or a token: the callback's accounts-server comes in on the URL.
const ACCOUNTS_SERVER = /^https:\/\/accounts\.(zoho.(com|eu|in|com.au|jp|uk|sa|ae|sg|com.cn)|zohocloud.ca)$/;
export const accountsServer = (s: string) => (ACCOUNTS_SERVER.test(s) ? s : null);
// The data centre's Mail API sits next to its accounts server.
export const mailServer = (accounts: string) => accounts.replace("://accounts.", "://mail.");

/** Letterbox's own Zoho client, plus where Zoho sends people back to. */
export type ZohoApp = { client_id: string; client_secret: string; redirect_uri: string };
/** What it takes to open one mailbox. */
export type ZohoLogin = { client_id: string; client_secret: string; refresh_token: string; accounts?: string; accountId?: string };

export type Folder = { id: string; name: string; type: string; path: string };
export type Summary = {
  id: string; threadId: string | null; threadCount: number; folderId: string;
  from: string; fromAddress: string; to: string; subject: string; summary: string;
  time: number; unread: boolean; attachment: boolean; flagged: boolean;
  account?: string;   // which of the person's mailboxes it is in (the server fills it in)
};
export type Attachment = { id: string; name: string; size: number };
export type Message = {
  id: string; folderId: string; from: string; fromAddress: string; to: string; cc: string;
  subject: string; time: number; html: string; attachments: Attachment[];
};
export type Upload = { storeName: string; attachmentPath: string; attachmentName: string };
export type Outgoing = { to: string; cc?: string; bcc?: string; subject: string; html: string; attachments?: Upload[]; replyTo?: string };
export type Action = "read" | "unread" | "spam" | "notspam" | "important" | "unimportant";

/** What the server needs from a mailbox; the tests stand in a fake one. */
export interface Mailbox {
  mailboxes(): Promise<{ id: string; email: string; name: string }[]>;
  accountInfo(): Promise<{ id: string; email: string; name: string }>;
  folders(): Promise<Folder[]>;
  messages(q: { folderId?: string; unread?: boolean; flagged?: boolean; start?: number; limit?: number }): Promise<Summary[]>;
  search(q: string, start?: number, limit?: number): Promise<Summary[]>;
  message(folderId: string, id: string): Promise<Message>;
  attachment(folderId: string, id: string, attachmentId: string): Promise<Response>;
  update(action: Action, ids: string[]): Promise<void>;
  remove(folderId: string, id: string, forever: boolean): Promise<void>;
  upload(name: string, body: Buffer): Promise<Upload>;
  send(m: Outgoing): Promise<void>;
}

const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
// Zoho HTML-escapes some fields (toAddress, summary); clients get plain text.
export const plain = (s: unknown) => (typeof s === "string" ? s.replace(/&(lt|gt|amp|quot|#39|nbsp);/g, (m) => ENTITIES[m]!).trim() : "");
// Zoho ids are longer than a double holds; quote any bare long number before JSON.parse rounds it.
// Strings are matched first and kept as they are: mail bodies hold links like `gids=[7681837357850529045,…]`.
export const parseLong = (text: string) =>
  JSON.parse(text.replace(/"(?:[^"\\]|\\.)*"|([:[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, (m, pre, n) => (n ? `${pre}"${n}"` : m)));
// Points every src at an inline part to `url`. Zoho serves the body with `cid:x` already rewritten to its
// own relative `/mail/ImageDisplay?...&cid=x&`, which the browser can't fetch either.
export const inlineCid = (html: string, cid: string, url: string) => {
  const esc = cid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const src = new RegExp(`(src\\s*=\\s*)(["'])(?:cid:${esc}|[^"']*[?&](?:amp;)?cid=${esc}(?:&[^"']*)?)\\2`, "gi");
  return html.replace(src, (_m, attr, q) => `${attr}${q}${url}${q}`).split(`cid:${cid}`).join(url);
};
export const imageType = (b: Buffer) =>
  b[0] === 0xff && b[1] === 0xd8 ? "image/jpeg"
  : b.subarray(0, 4).toString("latin1") === "\x89PNG" ? "image/png"
  : b.subarray(0, 3).toString("latin1") === "GIF" ? "image/gif"
  : b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" ? "image/webp"
  : /^\s*<(\?xml|svg)/.test(b.subarray(0, 100).toString("latin1")) ? "image/svg+xml"
  : "image/png";
export const ID = /^\d{1,25}$/;
const summary = (m: any): Summary => ({
  id: String(m.messageId),
  threadId: m.threadId ? String(m.threadId) : null,
  threadCount: Number(m.threadCount) || 0,
  folderId: String(m.folderId),
  from: plain(m.sender) || plain(m.fromAddress),
  fromAddress: plain(m.fromAddress),
  to: plain(m.toAddress),
  subject: plain(m.subject),
  summary: plain(m.summary),
  time: Number(m.receivedTime),
  unread: m.status === "0",
  attachment: m.hasAttachment === "1",
  flagged: Boolean(m.flagid && m.flagid !== "flag_not_set"),
});
const ids = (list: string[]) => {
  if (!list.length || !list.every((i) => ID.test(i))) throw Object.assign(new Error("bad message id"), { status: 400 });
  return `[${list.join(",")}]`; // raw numbers: Zoho wants longs, and a JS number would round them
};
const MODES: Record<"read" | "unread" | "spam" | "notspam", string> = { read: "markAsRead", unread: "markAsUnread", spam: "moveToSpam", notspam: "markNotSpam" };

/** Zoho's sign-in page for Letterbox. Zoho sends the person back to redirect_uri with a code and `state`. */
export function authorizeUrl(app: ZohoApp, state: string): string {
  const q = new URLSearchParams({ scope: SCOPES, client_id: app.client_id, response_type: "code", access_type: "offline", prompt: "consent", redirect_uri: app.redirect_uri, state });
  return `https://accounts.zoho.com/oauth/v2/auth?${q}`;
}

/** Trades the callback's code for a refresh token, at the data centre the account lives in. */
export async function exchange(app: ZohoApp, code: string, accounts: string): Promise<string> {
  const q = new URLSearchParams({ grant_type: "authorization_code", client_id: app.client_id, client_secret: app.client_secret, redirect_uri: app.redirect_uri, code });
  const r = await fetch(`${accounts}/oauth/v2/token?${q}`, { method: "POST", signal: AbortSignal.timeout(15000) });
  const j = (await r.json().catch(() => ({}))) as { refresh_token?: string; error?: string };
  if (!j.refresh_token) throw Object.assign(new Error(`Zoho didn't sign you in (${j.error ?? r.status})`), { status: 502 });
  return j.refresh_token;
}

/** Ends a refresh token, so a removed account can't be opened with it again. */
export async function revoke(accounts: string, refreshToken: string): Promise<void> {
  await fetch(`${accounts}/oauth/v2/token/revoke?${new URLSearchParams({ token: refreshToken })}`, { method: "POST", signal: AbortSignal.timeout(10000) }).catch(() => {});
}

export class Zoho implements Mailbox {
  private access: string | null = null;
  private expires = 0;
  private account: { id: string; email: string; name: string } | null = null;
  private readonly cfg: ZohoLogin;
  private readonly accounts: string;
  private readonly mail: string;

  // No parameter properties: the droplet runs this file with Node's type stripping, which can't.
  constructor(cfg: ZohoLogin) {
    if (!cfg.refresh_token) throw new Error("no refresh_token");
    this.cfg = cfg;
    this.accounts = cfg.accounts ?? "https://accounts.zoho.com";
    this.mail = mailServer(this.accounts);
  }

  private async token(): Promise<string> {
    if (this.access && Date.now() < this.expires) return this.access;
    const q = new URLSearchParams({ client_id: this.cfg.client_id, client_secret: this.cfg.client_secret, refresh_token: this.cfg.refresh_token, grant_type: "refresh_token" });
    const r = await fetch(`${this.accounts}/oauth/v2/token?${q}`, { method: "POST", signal: AbortSignal.timeout(10000) });
    const j = (await r.json()) as { access_token?: string; expires_in?: number; error?: string };
    // invalid_code: the token was revoked, or the account removed Letterbox in Zoho's own settings.
    if (!j.access_token) throw Object.assign(new Error(j.error === "invalid_code" ? "Zoho signed this account out. Remove it and add it again." : `Zoho sign-in failed: ${j.error ?? r.status}`), { status: 502 });
    this.access = j.access_token;
    this.expires = Date.now() + (j.expires_in ?? 3600) * 1000 - 60000;
    return this.access;
  }

  /** A raw call; `body` as a string goes out as JSON, a Buffer as a file. */
  async raw(method: string, path: string, body?: string | Buffer, timeout = 20000, accept = "application/json"): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Zoho-oauthtoken ${await this.token()}`, accept };
    if (typeof body === "string") headers["content-type"] = "application/json";
    else if (body) headers["content-type"] = "application/octet-stream";
    return fetch(this.mail + path, { method, headers, body: typeof body === "string" || !body ? body : new Uint8Array(body), signal: AbortSignal.timeout(timeout) });
  }

  async api<T = any>(method: string, path: string, body?: string | Buffer, timeout?: number): Promise<T> {
    const r = await this.raw(method, path, body, timeout);
    const text = await r.text();
    let j: any = {};
    try { j = parseLong(text); } catch {
      if (r.ok) throw Object.assign(new Error("Zoho sent a reply Letterbox couldn't read"), { status: 502 });
    }
    if (!r.ok || (j.status?.code && j.status.code >= 400)) {
      const why = j.data?.errorCode ?? j.data?.moreInfo ?? j.status?.description ?? "request failed";
      throw Object.assign(new Error(`Zoho said ${r.status}: ${why}`), { status: 502 });
    }
    return j.data as T;
  }

  /** Every mailbox this Zoho sign-in can open (usually one). */
  async mailboxes(): Promise<{ id: string; email: string; name: string }[]> {
    return (await this.api<any[]>("GET", "/api/accounts")).map((a) => ({
      id: String(a.accountId), email: String(a.primaryEmailAddress ?? a.mailboxAddress ?? "").toLowerCase(), name: a.displayName ?? a.accountDisplayName ?? "",
    }));
  }

  async accountInfo() {
    if (!this.account) {
      const all = await this.mailboxes();
      const a = all.find((x) => x.id === this.cfg.accountId) ?? all[0];
      if (!a) throw Object.assign(new Error("This Zoho account has no mailbox"), { status: 502 });
      this.account = a;
    }
    return this.account;
  }
  private async base() { return `/api/accounts/${(await this.accountInfo()).id}`; }

  async folders(): Promise<Folder[]> {
    return (await this.api<any[]>("GET", `${await this.base()}/folders`)).map((f) => ({ id: String(f.folderId), name: f.folderName, type: f.folderType, path: f.path }));
  }

  // start is 1-based in Zoho. With no folderId and unread set, Zoho lists unread mail in every folder
  // except Spam and Trash (its own sidebar badges disagree; the API is right).
  async messages({ folderId, unread = false, flagged = false, start = 1, limit = 50 }: { folderId?: string; unread?: boolean; flagged?: boolean; start?: number; limit?: number }): Promise<Summary[]> {
    const q = new URLSearchParams({ start: String(start), limit: String(limit), sortorder: "false" });
    if (folderId) q.set("folderId", folderId);
    if (unread) q.set("status", "unread");
    if (flagged) q.set("flaggedMails", "true");
    return (await this.api<any[]>("GET", `${await this.base()}/messages/view?${q}`)).map(summary);
  }

  // Mail from every folder, in the order Zoho returns it. Plain words search everything (Zoho rejects a bare
  // word); a query that starts with one of Zoho's own keys (from:, subject:, ...) goes through as typed.
  async search(query: string, start = 1, limit = 50): Promise<Summary[]> {
    const q = query.trim();
    const searchKey = /^(entire|from|to|cc|subject|content|has|in|tag|fileName|fileContent|sender):/i.test(q) ? q : `entire:${q}`;
    const p = new URLSearchParams({ searchKey, start: String(start), limit: String(limit) });
    return (await this.api<any[]>("GET", `${await this.base()}/messages/search?${p}`)).map(summary);
  }

  async message(folderId: string, id: string): Promise<Message> {
    if (!ID.test(folderId) || !ID.test(id)) throw Object.assign(new Error("bad message id"), { status: 400 });
    const at = `${await this.base()}/folders/${folderId}/messages/${id}`;
    const [details, content, info] = await Promise.all([
      this.api("GET", `${at}/details`),
      this.api("GET", `${at}/content?includeBlockContent=true`),
      this.api("GET", `${at}/attachmentinfo?includeInline=true`).catch(() => ({ attachments: [], inline: [] })),
    ]);
    let html: string = content?.content ?? "";
    // Inline images point at cid: parts the browser can't fetch; put them in the page itself.
    for (const im of (info?.inline ?? []) as any[]) {
      if (!im.cid || Number(im.attachmentSize) > 3_000_000) continue;
      const cid = String(im.cid).replace(/^<|>$/g, "");
      if (!html.includes(cid)) continue;
      try {
        const r = await this.raw("GET", `${at}/attachments/${im.attachmentId}`, undefined, 20000, "*/*");
        if (!r.ok) continue;
        const bytes = Buffer.from(await r.arrayBuffer());
        const sent = r.headers.get("content-type")?.split(";")[0] ?? "";
        // Zoho sends inline parts as application/octet-stream, which an <img> may refuse.
        const type = sent.startsWith("image/") ? sent : imageType(bytes);
        const url = `data:${type};base64,${bytes.toString("base64")}`;
        html = inlineCid(html, cid, url);
      } catch { /* the image just stays broken */ }
    }
    return {
      id, folderId,
      from: plain(details.sender) || plain(details.fromAddress),
      fromAddress: plain(details.fromAddress),
      to: plain(details.toAddress),
      cc: plain(details.ccAddress) === "Not Provided" ? "" : plain(details.ccAddress),
      subject: plain(details.subject),
      time: Number(details.receivedTime) || Number(details.sentDateInGMT) || 0,
      html,
      attachments: ((info?.attachments ?? []) as any[]).map((a) => ({ id: String(a.attachmentId), name: a.attachmentName, size: Number(a.attachmentSize) || 0 })),
    };
  }

  async attachment(folderId: string, id: string, attachmentId: string): Promise<Response> {
    if (![folderId, id, attachmentId].every((x) => ID.test(x))) throw Object.assign(new Error("bad id"), { status: 400 });
    return this.raw("GET", `${await this.base()}/folders/${folderId}/messages/${id}/attachments/${attachmentId}`, undefined, 120000, "*/*");
  }

  async update(action: Action, list: string[]) {
    if (action === "important" || action === "unimportant") {
      const flagid = action === "important" ? "important" : "flag_not_set";
      await this.api("PUT", `${await this.base()}/updatemessage`, `{"mode":"setFlag","messageId":${ids(list)},"flagid":${JSON.stringify(flagid)}}`);
      return;
    }
    await this.api("PUT", `${await this.base()}/updatemessage`, `{"mode":${JSON.stringify(MODES[action])},"messageId":${ids(list)}}`);
  }

  async remove(folderId: string, id: string, forever: boolean) {
    if (!ID.test(folderId) || !ID.test(id)) throw Object.assign(new Error("bad message id"), { status: 400 });
    await this.api("DELETE", `${await this.base()}/folders/${folderId}/messages/${id}${forever ? "?expunge=true" : ""}`);
  }

  async upload(name: string, body: Buffer): Promise<Upload> {
    const d = await this.api("POST", `${await this.base()}/messages/attachments?${new URLSearchParams({ fileName: name })}`, body, 120000);
    const a = Array.isArray(d) ? d[0] : d;
    return { storeName: String(a.storeName), attachmentPath: String(a.attachmentPath), attachmentName: String(a.attachmentName) };
  }

  async send(m: Outgoing) {
    const { email } = await this.accountInfo();
    const body: Record<string, unknown> = { fromAddress: email, toAddress: m.to, subject: m.subject, content: m.html, mailFormat: "html", encoding: "UTF-8" };
    if (m.cc) body.ccAddress = m.cc;
    if (m.bcc) body.bccAddress = m.bcc;
    if (m.attachments?.length) body.attachments = m.attachments;
    if (m.replyTo) {
      if (!ID.test(m.replyTo)) throw Object.assign(new Error("bad message id"), { status: 400 });
      body.action = "reply";
      return void (await this.api("POST", `${await this.base()}/messages/${m.replyTo}`, JSON.stringify(body), 60000));
    }
    await this.api("POST", `${await this.base()}/messages`, JSON.stringify(body), 60000);
  }
}
