// Zoho Mail REST API provider. Works on the Forever Free plan, which has no IMAP or SMTP.
// Config file: {client_id, client_secret, refresh_token} from a Zoho Self Client (US data center), scopes
// ZohoMail.accounts.READ, ZohoMail.folders.ALL, ZohoMail.messages.ALL, ZohoMail.tags.ALL.
import { readFileSync } from "node:fs";

const ACCOUNTS = "https://accounts.zoho.com";
const MAIL = "https://mail.zoho.com";

export type Folder = { id: string; name: string; type: string; path: string };
export type Summary = {
  id: string; threadId: string | null; threadCount: number; folderId: string;
  from: string; fromAddress: string; to: string; subject: string; summary: string;
  time: number; unread: boolean; attachment: boolean; flagged: boolean;
};
export type Attachment = { id: string; name: string; size: number };
export type Message = {
  id: string; folderId: string; from: string; fromAddress: string; to: string; cc: string;
  subject: string; time: number; html: string; attachments: Attachment[];
};
export type Upload = { storeName: string; attachmentPath: string; attachmentName: string };
export type Outgoing = { to: string; cc?: string; bcc?: string; subject: string; html: string; attachments?: Upload[]; replyTo?: string };
export type Action = "read" | "unread" | "spam" | "notspam";

/** What the server needs from a mailbox; the tests stand in a fake one. */
export interface Mailbox {
  accountInfo(): Promise<{ id: string; email: string; name: string }>;
  folders(): Promise<Folder[]>;
  messages(q: { folderId?: string; unread?: boolean; start?: number; limit?: number }): Promise<Summary[]>;
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
export const parseLong = (text: string) => JSON.parse(text.replace(/([:[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"$2"'));
export const ID = /^\d{1,25}$/;
const ids = (list: string[]) => {
  if (!list.length || !list.every((i) => ID.test(i))) throw Object.assign(new Error("bad message id"), { status: 400 });
  return `[${list.join(",")}]`; // raw numbers: Zoho wants longs, and a JS number would round them
};
const MODES: Record<Action, string> = { read: "markAsRead", unread: "markAsUnread", spam: "moveToSpam", notspam: "markNotSpam" };

export class Zoho implements Mailbox {
  private cfg: { client_id: string; client_secret: string; refresh_token: string };
  private access: string | null = null;
  private expires = 0;
  private account: { id: string; email: string; name: string } | null = null;

  constructor(configPath: string) {
    this.cfg = JSON.parse(readFileSync(configPath, "utf8"));
    if (!this.cfg.refresh_token) throw new Error(`${configPath} has no refresh_token`);
  }

  private async token(): Promise<string> {
    if (this.access && Date.now() < this.expires) return this.access;
    const q = new URLSearchParams({ client_id: this.cfg.client_id, client_secret: this.cfg.client_secret, refresh_token: this.cfg.refresh_token, grant_type: "refresh_token" });
    const r = await fetch(`${ACCOUNTS}/oauth/v2/token?${q}`, { method: "POST", signal: AbortSignal.timeout(10000) });
    const j = (await r.json()) as { access_token?: string; expires_in?: number; error?: string };
    if (!j.access_token) throw new Error(`zoho token refresh failed: ${j.error ?? r.status}`);
    this.access = j.access_token;
    this.expires = Date.now() + (j.expires_in ?? 3600) * 1000 - 60000;
    return this.access;
  }

  /** A raw call; `body` as a string goes out as JSON, a Buffer as a file. */
  async raw(method: string, path: string, body?: string | Buffer, timeout = 20000, accept = "application/json"): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Zoho-oauthtoken ${await this.token()}`, accept };
    if (typeof body === "string") headers["content-type"] = "application/json";
    else if (body) headers["content-type"] = "application/octet-stream";
    return fetch(MAIL + path, { method, headers, body: typeof body === "string" || !body ? body : new Uint8Array(body), signal: AbortSignal.timeout(timeout) });
  }

  async api<T = any>(method: string, path: string, body?: string | Buffer, timeout?: number): Promise<T> {
    const r = await this.raw(method, path, body, timeout);
    const text = await r.text();
    let j: any = {};
    try { j = parseLong(text); } catch { /* not JSON */ }
    if (!r.ok || (j.status?.code && j.status.code >= 400)) {
      const why = j.data?.errorCode ?? j.data?.moreInfo ?? j.status?.description ?? "request failed";
      throw Object.assign(new Error(`Zoho said ${r.status}: ${why}`), { status: 502 });
    }
    return j.data as T;
  }

  async accountInfo() {
    if (!this.account) {
      const a = (await this.api("GET", "/api/accounts"))[0];
      this.account = { id: String(a.accountId), email: a.primaryEmailAddress ?? a.mailboxAddress, name: a.displayName ?? a.accountDisplayName ?? "" };
    }
    return this.account;
  }
  private async base() { return `/api/accounts/${(await this.accountInfo()).id}`; }

  async folders(): Promise<Folder[]> {
    return (await this.api<any[]>("GET", `${await this.base()}/folders`)).map((f) => ({ id: String(f.folderId), name: f.folderName, type: f.folderType, path: f.path }));
  }

  // start is 1-based in Zoho. With no folderId and unread set, Zoho lists unread mail in every folder
  // except Spam and Trash (its own sidebar badges disagree; the API is right).
  async messages({ folderId, unread = false, start = 1, limit = 50 }: { folderId?: string; unread?: boolean; start?: number; limit?: number }): Promise<Summary[]> {
    const q = new URLSearchParams({ start: String(start), limit: String(limit), sortorder: "false" });
    if (folderId) q.set("folderId", folderId);
    if (unread) q.set("status", "unread");
    return (await this.api<any[]>("GET", `${await this.base()}/messages/view?${q}`)).map((m) => ({
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
    }));
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
        const type = r.headers.get("content-type")?.split(";")[0] || "image/png";
        const url = `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}`;
        html = html.split(`cid:${cid}`).join(url);
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
