// The browser extension's side door into the running Vault (Windows). The native side listens on
// 127.0.0.1 only and turns away web pages; every request but "hello" and "pair" carries a token the
// user approved in this window. A page's logins are only ever looked up for the address the browser
// itself reports for that page, so a look-alike site gets nothing.
import { totp, type OtpEntry } from "@marobotic/otp";
import type { Vault, Item, LoginItem, TotpItem } from "../src/vault.ts";
import { codesFor, fillableUrl, loginsFor, siteKey } from "../src/domains.ts";
import { hostOf } from "../src/passwords.ts";
import { siteOf } from "../src/icons.ts";

type LoginRow = Item & { data: LoginItem };
type TotpRow = Item & { data: TotpItem };

export type BridgeContext = {
  vault(): Vault | null;
  save(): Promise<void>;
  /** Ask the person whether this browser may use Vault; the same code shows in the extension. */
  approvePair(code: string, browser: string): Promise<boolean>;
  notify(text: string): void;
};

type Paired = { hash: string; browser: string; added: number };
const KEY = "vault.bridge";
export const pairedBrowsers = (): Paired[] => { try { return JSON.parse(localStorage.getItem(KEY) || "[]") as Paired[]; } catch { return []; } };
export const forgetBrowsers = () => localStorage.removeItem(KEY);

async function sha256(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A code with at least 3 seconds left: one about to expire is swapped for the next. */
async function freshCode(otp: OtpEntry) {
  const now = Date.now();
  let r = await totp(otp, now);
  if (r.remaining < 3) r = await totp(otp, now + r.remaining * 1000);
  return r;
}

const codeLabel = (c: TotpRow) => c.data.label || c.data.otp.issuer || "2FA";

export async function handle(ctx: BridgeContext, req: Record<string, unknown>): Promise<unknown> {
  const op = String(req.op ?? "");
  const vault = ctx.vault();
  if (op === "hello") {
    const paired = typeof req.token === "string" && (await isPaired(req.token));
    return { app: "vault", paired, locked: !vault };
  }
  if (op === "pair") {
    if (!vault) return { error: "locked" };
    const code = String(req.code ?? "").replace(/\D/g, "").slice(0, 6);
    const browser = String(req.browser ?? "a browser").slice(0, 60);
    if (code.length !== 4) return { error: "bad request" };
    if (!(await ctx.approvePair(code, browser))) return { error: "denied" };
    const token = hex(32);
    localStorage.setItem(KEY, JSON.stringify([...pairedBrowsers(), { hash: await sha256(token), browser, added: Date.now() }]));
    return { token };
  }
  if (typeof req.token !== "string" || !(await isPaired(req.token))) return { error: "unpaired" };
  if (!vault) return { locked: true };

  const logins = vault.list("login") as LoginRow[];
  const codes = vault.list("totp") as TotpRow[];
  const url = String(req.url ?? "");
  const pageOk = () => fillableUrl(url);

  switch (op) {
    case "status":
      return { locked: false };

    case "match": {
      if (!pageOk()) return { logins: [], codes: [] };
      const ls = loginsFor(url, logins);
      const cs = codesFor(url, codes, logins);
      return {
        logins: ls.map((l) => ({ id: l.id, name: l.data.name, username: l.data.username, site: siteOf({ urls: l.data.urls, name: l.data.name }) })),
        codes: await Promise.all(cs.map(async (c) => ({ id: c.id, issuer: codeLabel(c), account: c.data.otp.account, period: c.data.otp.period, ...(await freshCode(c.data.otp)) }))),
      };
    }

    case "fill": {
      const l = loginsFor(url, logins).find((x) => x.id === req.id);
      if (!pageOk() || !l) return { error: "not for this site" };
      const linked = codesFor(url, codes, [l])[0];
      return { username: l.data.username, password: l.data.password, ...(linked ? { code: (await freshCode(linked.data.otp)).code } : {}) };
    }

    case "code": {
      const c = codesFor(url, codes, logins).find((x) => x.id === req.id);
      if (!pageOk() || !c) return { error: "not for this site" };
      return { code: (await freshCode(c.data.otp)).code };
    }

    // The popup: the person picked the entry themselves, from Vault's own list.
    case "search": {
      const q = String(req.q ?? "").trim().toLowerCase();
      const hit = (s: string) => !q || s.toLowerCase().includes(q);
      return {
        logins: logins.filter((l) => hit(`${l.data.name} ${l.data.username} ${l.data.urls.join(" ")}`)).slice(0, 60)
          .map((l) => ({ id: l.id, name: l.data.name, username: l.data.username, site: siteOf({ urls: l.data.urls, name: l.data.name }) })),
        codes: await Promise.all(codes.filter((c) => hit(`${codeLabel(c)} ${c.data.otp.account}`)).slice(0, 60)
          .map(async (c) => ({ id: c.id, issuer: codeLabel(c), account: c.data.otp.account, period: c.data.otp.period, ...(await freshCode(c.data.otp)) }))),
      };
    }
    case "secret": {
      const it = vault.get(String(req.id));
      if (it?.data.type === "login") {
        const linked = codesFor(it.data.urls[0] ? `https://${hostOf(it.data.urls[0])}` : "", codes, [it as LoginRow])[0];
        return { username: it.data.username, password: it.data.password, ...(linked ? { code: (await freshCode(linked.data.otp)).code } : {}) };
      }
      if (it?.data.type === "totp") return { code: (await freshCode(it.data.otp)).code };
      return { error: "not found" };
    }

    // Saving what was typed into a sign-in form.
    case "check":
    case "save": {
      if (!pageOk()) return { error: "not for this site" };
      const username = String(req.username ?? "").trim();
      const password = String(req.password ?? "");
      if (!password) return { error: "no password" };
      const site = loginsFor(url, logins);
      const same = username ? site.find((l) => l.data.username.toLowerCase() === username.toLowerCase()) : site.length === 1 ? site[0] : undefined;
      if (op === "check") return { state: !same ? "new" : same.data.password === password ? "same" : "changed", name: same?.data.name };
      if (same) {
        vault.update(same.id, { ...same.data, password });
        await ctx.save();
        ctx.notify(`Password updated · ${same.data.name}`);
        return { saved: "updated", name: same.data.name };
      }
      const host = hostOf(url);
      const name = String(req.name ?? "").trim() || prettyName(host);
      vault.add({ type: "login", name, urls: [`https://${host}`], username, password, notes: "" });
      await ctx.save();
      ctx.notify(`Login saved · ${name}`);
      return { saved: "added", name };
    }
  }
  return { error: "unknown request" };
}

async function isPaired(token: string) {
  const h = await sha256(token);
  return pairedBrowsers().some((p) => p.hash === h);
}

/** A name for a newly saved login: "secure.github.com" -> "Github". */
function prettyName(host: string): string {
  const base = siteKey(host).split(".")[0] ?? host;
  return base.charAt(0).toUpperCase() + base.slice(1);
}
