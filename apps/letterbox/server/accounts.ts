// The Zoho mailboxes each marobotic account has added to Letterbox, in one JSON file on the server. Refresh
// tokens are sealed with AES-256-GCM under a key file of their own, so the list alone opens nothing.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Account = {
  id: string;          // Letterbox's own id for it, the same in every URL
  owner: string;       // the marobotic account that added it
  email: string;
  name: string;
  zohoId: string;      // Zoho's accountId
  accounts: string;    // the data centre's accounts server
  token: string;       // the sealed refresh token
  client?: { id: string; secret: string };   // a mailbox carried over from the old Self Client (secret sealed)
  color: number;
  added: number;
};
/** What the client sees of an account. */
export type PublicAccount = { id: string; email: string; name: string; color: number };
export const COLORS = 6;

export class AccountStore {
  private list: Account[] = [];
  private carriedOver: string[] = [];
  private readonly key: Buffer;
  private readonly file: string;

  constructor(file: string, keyFile: string) {
    this.file = file;
    if (!existsSync(keyFile)) {
      mkdirSync(dirname(keyFile), { recursive: true });
      writeFileSync(keyFile, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
    }
    this.key = Buffer.from(readFileSync(keyFile, "utf8").trim(), "hex");
    if (this.key.length !== 32) throw new Error(`${keyFile} is not a 32-byte hex key`);
    if (existsSync(file)) {
      const o = JSON.parse(readFileSync(file, "utf8"));
      this.list = o.accounts ?? [];
      this.carriedOver = o.carriedOver ?? [];
    }
  }

  seal(text: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
  }
  open(sealed: string): string {
    const b = Buffer.from(sealed, "base64");
    const d = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + ".tmp", JSON.stringify({ accounts: this.list, carriedOver: this.carriedOver }, null, 1), { mode: 0o600 });
    renameSync(this.file + ".tmp", this.file);
  }

  of(owner: string): Account[] { return this.list.filter((a) => a.owner === owner); }
  get(owner: string, id: string): Account | undefined { return this.list.find((a) => a.owner === owner && a.id === id); }

  /** Adds a mailbox, or gives one this owner already has a new token. Returns it and the token it replaced. */
  put(owner: string, m: { email: string; name: string; zohoId: string; accounts: string; refreshToken: string; client?: { id: string; secret: string } }): { account: Account; replaced: string | null } {
    const old = this.list.find((a) => a.owner === owner && a.zohoId === m.zohoId && a.accounts === m.accounts);
    const token = this.seal(m.refreshToken);
    const client = m.client && { id: m.client.id, secret: this.seal(m.client.secret) };
    if (old) {
      const replaced = old.client ? null : this.open(old.token);   // a carried-over token belongs to the old client
      Object.assign(old, { email: m.email, name: m.name, token });
      if (client) old.client = client; else delete old.client;
      this.save();
      return { account: old, replaced };
    }
    const used = new Set(this.of(owner).map((a) => a.color));
    const color = Array.from({ length: COLORS }, (_, i) => i).find((i) => !used.has(i)) ?? this.of(owner).length % COLORS;
    const account: Account = { id: randomBytes(6).toString("hex"), owner, email: m.email, name: m.name, zohoId: m.zohoId, accounts: m.accounts, token, ...(client ? { client } : {}), color, added: Date.now() };
    this.list.push(account);
    this.save();
    return { account, replaced: null };
  }

  /** Whether any mailbox still opens with this refresh token (one Zoho sign-in can hold several). */
  usesToken(refreshToken: string): boolean { return this.list.some((a) => !a.client && this.open(a.token) === refreshToken); }
  carried(key: string): boolean { return this.carriedOver.includes(key); }
  markCarried(key: string) { this.carriedOver.push(key); this.save(); }

  remove(owner: string, id: string): Account | null {
    const a = this.get(owner, id);
    if (!a) return null;
    this.list = this.list.filter((x) => x !== a);
    this.save();
    return a;
  }
}

export const publicAccount = (a: Account): PublicAccount => ({ id: a.id, email: a.email, name: a.name, color: a.color });
