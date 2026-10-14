/// <reference types="chrome" />
// Vault in the browser, on its own: it signs in to the marobotic account, keeps the sealed vault from
// marobotic.dev, and opens it here, the same way the Vault app does on the PC and the phone. Each one
// syncs with the server by itself; the extension doesn't need the app to be running.
//
// The vault key lives in memory and in session storage (memory only, gone when the browser closes, so
// the worker can be restarted without asking again). The sealed copy is kept in local storage so the
// extension still opens offline. Nothing readable is ever written to disk.
import { init, fromBase64, toBase64 } from "@marobotic/crypto";
import { totp, type OtpEntry } from "@marobotic/otp";
import { Vault, type VaultFile, type Item, type LoginItem, type TotpItem, type PasskeyItem } from "../../vault/src/vault.ts";
import { codesFor, fillableUrl, loginsFor, siteKey } from "../../vault/src/domains.ts";
import { generatePassword, hostOf, matchTotp } from "../../vault/src/passwords.ts";
import { siteOf } from "../../vault/src/icons.ts";
import { createPasskey, passkeysFor, rpIdFor, signIn as passkeySignIn, b64url, fromB64url } from "../../vault/src/passkeys.ts";
import * as account from "../../vault/ui/account.ts";
import { DEFAULTS, type CodeHit, type Detail, type LoginInput, type Msg, type PkCreate, type PkGet, type Settings, type State, type Summary } from "./messages.ts";

type LoginRow = Item & { data: LoginItem };
type TotpRow = Item & { data: TotpItem };
type PasskeyRow = Item & { data: PasskeyItem };

let vault: Vault | null = null;
let session: string | null = null;      // the account session for syncing; null = offline / signed out of the server
let rev = 0;
let synced: State["synced"] = "offline";
let syncing: Promise<void> | null = null;

const local = {
  async get<T>(key: string, fallback: T): Promise<T> { return ((await chrome.storage.local.get(key))[key] ?? fallback) as T; },
  set: (o: Record<string, unknown>) => chrome.storage.local.set(o),
};
const mem = {
  async get<T>(key: string): Promise<T | undefined> { return (await chrome.storage.session.get(key))[key] as T | undefined; },
  set: (o: Record<string, unknown>) => chrome.storage.session.set(o),
  del: (key: string | string[]) => chrome.storage.session.remove(key),
};
const settings = async (): Promise<Settings> => ({ ...DEFAULTS, ...(await local.get<Partial<Settings>>("settings", {})) });

// ------------------------------------------------------------------ open, lock, sync
/** After a restart of this worker: the vault opens again from session storage, if it was open. */
const restored = (async () => {
  await init();
  const s = await mem.get<{ key: string; session: string | null; rev: number }>("open");
  const file = await local.get<VaultFile | null>("file", null);
  if (s && file) {
    try { vault = Vault.withKey(file, fromBase64(s.key)); session = s.session; rev = s.rev; synced = session ? "synced" : "offline"; }
    catch { await mem.del("open"); }
  }
})();

async function remember() {
  if (!vault) return;
  await mem.set({ open: { key: toBase64(vault.keyBytes()), session, rev }, active: Date.now() });
}

async function signIn(email: string, password: string): Promise<void> {
  email = email.trim().toLowerCase();
  const file = await local.get<VaultFile | null>("file", null);
  const mine = file && file.email === email ? file : null;
  try {
    session = await account.signIn(email, password);
  } catch (e) {
    if (e instanceof account.Offline && mine) {
      try { vault = Vault.unlock(mine, password); } catch { throw new Error("That password doesn't open the copy in this browser."); }
      session = null; synced = "offline";
      return void (await opened(email));
    }
    throw e instanceof account.Offline ? new Error(`${e.message}. Vault needs to sign in once while online.`) : e;
  }
  const remote = await account.fetchVault(session);
  if (!remote) throw new Error("This account has no vault yet. Set it up in the Vault app first (it shows your recovery kit).");
  try { vault = Vault.unlock(remote.file, password); }
  catch { throw new Error("Your password changed since the vault was sealed. Open it once in the Vault app with your recovery kit."); }
  rev = remote.rev;
  if (mine) { try { vault.merge(Vault.unlock(mine, password).toFile().items); } catch { /* an old copy for another password: the server's wins */ } }
  synced = "synced";
  await opened(email);
  if (mine) void sync();
}

async function opened(email: string) {
  await local.set({ file: vault!.toFile(), email });
  await remember();
}

async function lock() {
  vault = null; session = null;
  await mem.del(["open", "active"]);
}

/** Saved here, then sent to the server; another device's newer changes are merged in first. */
async function save() {
  if (!vault) return;
  await local.set({ file: vault.toFile() });
  await remember();
  void sync();
}

function sync(): Promise<void> {
  if (!vault || !session) return Promise.resolve();
  return (syncing ??= (async () => {
    try {
      const remote = await account.fetchVault(session!);
      if (remote && remote.rev !== rev && vault) { vault.merge(remote.file.items); rev = remote.rev; }
      for (let i = 0; i < 3 && vault && session; i++) {
        const r = await account.pushVault(session, rev, vault.toFile());
        if ("rev" in r) { rev = r.rev; synced = "synced"; break; }
        rev = r.conflict.rev;
        vault.merge(r.conflict.file.items);
      }
      if (vault) { await local.set({ file: vault.toFile() }); await remember(); }
    } catch (e) {
      synced = e instanceof account.SignInError ? "signedOut" : "offline";
      if (e instanceof account.SignInError) { session = null; await remember(); }
    } finally {
      syncing = null;
    }
  })());
}

// Every minute: the auto-lock is checked, and every few minutes other devices' changes come in.
chrome.alarms.create("tick", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async () => {
  await restored;
  if (!vault) return;
  const { lockAfter } = await settings();
  const active = (await mem.get<number>("active")) ?? Date.now();
  if (lockAfter && Date.now() - active > lockAfter * 60_000) return void (await lock());
  const last = (await mem.get<number>("pulled")) ?? 0;
  if (Date.now() - last > 4 * 60_000) { await mem.set({ pulled: Date.now() }); void sync(); }
});
const touch = () => mem.set({ active: Date.now() });

// ------------------------------------------------------------------ the browser's own password manager
async function applyTakeover() {
  const { takeover } = await settings();
  try { await chrome.privacy.services.passwordSavingEnabled.set({ value: !takeover }); } catch { /* managed by policy */ }
}
chrome.runtime.onInstalled.addListener(() => void applyTakeover());
chrome.runtime.onStartup.addListener(() => void applyTakeover());

// ------------------------------------------------------------------ reading the vault
const logins = () => (vault?.list("login") ?? []) as LoginRow[];
const codes = () => (vault?.list("totp") ?? []) as TotpRow[];
const passkeys = () => (vault?.list("passkey") ?? []) as PasskeyRow[];
const codeName = (c: TotpRow) => c.data.label || c.data.otp.issuer || "2FA";
const passkeyOn = (host: string) => (p: PasskeyRow) => host === p.data.rpId || host.endsWith(`.${p.data.rpId}`);

/** A code with at least 3 seconds left: one about to expire is swapped for the next. */
async function fresh(otp: OtpEntry) {
  const now = Date.now();
  let r = await totp(otp, now);
  if (r.remaining < 3) r = await totp(otp, now + r.remaining * 1000);
  return r;
}
const codeHit = async (c: TotpRow): Promise<CodeHit> => ({ id: c.id, issuer: codeName(c), account: c.data.otp.account, period: c.data.otp.period, ...(await fresh(c.data.otp)) });
const linkedCode = (l: LoginRow) => (l.data.totpId ? codes().find((c) => c.id === l.data.totpId) : undefined) ?? matchTotp(l.data, codes().map((c) => ({ otp: c.data.otp, c })))?.c;
const loginSite = (l: LoginItem) => siteOf({ urls: l.urls, name: l.name });

async function matches(url: string) {
  if (!fillableUrl(url)) return { logins: [], codes: [], passkeys: [] };
  const s = await settings();
  return {
    logins: s.suggest ? loginsFor(url, logins()).map((l) => ({ id: l.id, name: l.data.name, username: l.data.username, site: loginSite(l.data) })) : [],
    codes: s.suggestCodes ? await Promise.all(codesFor(url, codes(), logins()).map(codeHit)) : [],
    passkeys: s.passkeys ? passkeys().filter(passkeyOn(hostOf(url))).map((p) => ({ id: p.id, rpId: p.data.rpId, username: p.data.username, displayName: p.data.displayName ?? "" })) : [],
  };
}

async function summaries(q: string, siteUrl: string | null): Promise<Summary[]> {
  const needle = q.trim().toLowerCase();
  const hit = (s: string) => !needle || s.toLowerCase().includes(needle);
  const ls = siteUrl ? loginsFor(siteUrl, logins()) : logins();
  const cs = siteUrl ? codesFor(siteUrl, codes(), logins()) : codes();
  const ps = siteUrl ? passkeys().filter(passkeyOn(hostOf(siteUrl))) : passkeys();
  const out: Summary[] = [];
  for (const l of ls) if (hit(`${l.data.name} ${l.data.username} ${l.data.urls.join(" ")}`))
    out.push({ id: l.id, kind: "login", title: l.data.name, sub: l.data.username, site: loginSite(l.data), favorite: l.data.favorite });
  for (const c of cs) if (hit(`${codeName(c)} ${c.data.otp.account}`)) {
    const r = await fresh(c.data.otp);
    out.push({ id: c.id, kind: "totp", title: codeName(c), sub: c.data.otp.account, site: siteOf({ issuer: c.data.otp.issuer, name: c.data.label }), favorite: c.data.favorite, code: r.code, remaining: r.remaining, period: c.data.otp.period });
  }
  for (const p of ps) if (hit(`${p.data.rpName ?? ""} ${p.data.rpId} ${p.data.username}`))
    out.push({ id: p.id, kind: "passkey", title: p.data.rpName || p.data.rpId, sub: p.data.username, site: siteKey(p.data.rpId), favorite: p.data.favorite });
  return out.sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || a.title.localeCompare(b.title));
}

async function detail(id: string): Promise<Detail | { error: string }> {
  const it = vault?.get(id);
  if (!it) return { error: "not found" };
  if (it.data.type === "login") {
    const l = it as LoginRow, c = linkedCode(l);
    return { kind: "login", id, name: l.data.name, username: l.data.username, password: l.data.password, urls: l.data.urls, notes: l.data.notes ?? "", site: loginSite(l.data), favorite: l.data.favorite, ...(c ? { code: await codeHit(c) } : {}) };
  }
  if (it.data.type === "totp") { const c = it as TotpRow; return { kind: "totp", id, issuer: codeName(c), account: c.data.otp.account, site: siteOf({ issuer: c.data.otp.issuer }), code: await codeHit(c), favorite: c.data.favorite }; }
  if (it.data.type === "passkey") { const p = it.data; return { kind: "passkey", id, rpId: p.rpId, rpName: p.rpName || p.rpId, username: p.username, displayName: p.displayName ?? "", created: p.created, site: siteKey(p.rpId) }; }
  return { error: "not shown here" };
}

async function saveLogin(input: LoginInput) {
  const data: LoginItem = { type: "login", name: input.name.trim() || hostOf(input.urls[0] ?? "") || "Login", urls: input.urls.filter(Boolean), username: input.username.trim(), password: input.password, notes: input.notes };
  if (input.id) { const old = vault!.get(input.id); if (old?.data.type !== "login") return { error: "not found" }; vault!.update(input.id, { ...old.data, ...data }); }
  else vault!.add(data);
  await save();
  return { ok: true };
}

// ------------------------------------------------------------------ saving what was typed
type PendingSave = { id: string; tabId: number; url: string; username: string; password: string; state: "new" | "changed"; name?: string; loginId?: string; at: number };
const siteOfUrl = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };

async function submitted(tabId: number, url: string, username: string, password: string) {
  if (!vault || !password || !fillableUrl(url) || !(await settings()).offerSave) return;
  if ((await local.get<string[]>("never", [])).includes(siteOfUrl(url))) return;
  if (!username) {
    const lu = await mem.get<{ username: string; at: number }>(`user:${tabId}`);
    if (lu && Date.now() - lu.at < 10 * 60_000) username = lu.username;
  }
  const site = loginsFor(url, logins());
  const same = username ? site.find((l) => l.data.username.toLowerCase() === username.toLowerCase()) : site.length === 1 ? site[0] : undefined;
  if (same && same.data.password === password) return;
  const p: PendingSave = { id: crypto.randomUUID(), tabId, url, username, password, state: same ? "changed" : "new", name: same?.data.name, loginId: same?.id, at: Date.now() };
  await mem.set({ [`pending:${tabId}`]: p });
  setTimeout(() => void offer(tabId), 1200);   // a sign-in that doesn't reload; otherwise the next page asks
}
async function offer(tabId: number) {
  const p = await takePending(tabId);
  if (!p) return;
  try { await chrome.tabs.sendMessage(tabId, { t: "offerSave", ...offerOf(p) }, { frameId: 0 }); }
  catch { await mem.set({ [`pending:${tabId}`]: p }); }
}
async function takePending(tabId: number) {
  const p = await mem.get<PendingSave>(`pending:${tabId}`);
  await mem.del(`pending:${tabId}`);
  if (!p || Date.now() - p.at > 3 * 60_000) return undefined;
  await mem.set({ [`offer:${p.id}`]: p });
  return p;
}
const offerOf = (p: PendingSave) => ({ id: p.id, site: siteOfUrl(p.url), username: p.username, state: p.state, name: p.name });

async function decide(id: string, decision: "save" | "never") {
  const p = await mem.get<PendingSave>(`offer:${id}`);
  await mem.del(`offer:${id}`);
  if (!p) return { error: "expired" };
  if (decision === "never") { await local.set({ never: [...new Set([...(await local.get<string[]>("never", [])), siteOfUrl(p.url)])] }); return { ok: true }; }
  if (!vault) return { locked: true };
  const existing = p.loginId ? vault.get(p.loginId) : undefined;
  if (existing?.data.type === "login") vault.update(existing.id, { ...existing.data, password: p.password });
  else {
    const host = hostOf(p.url);
    const base = siteKey(host).split(".")[0] ?? host;
    vault.add({ type: "login", name: base.charAt(0).toUpperCase() + base.slice(1), urls: [`https://${host}`], username: p.username, password: p.password, notes: "" });
  }
  await save();
  return { saved: existing ? "updated" : "added" };
}

// ------------------------------------------------------------------ passkeys
const originOf = (s: chrome.runtime.MessageSender) => s.origin ?? (s.url ? new URL(s.url).origin : "");
const toCreate = (o: PkCreate) => ({
  rp: o.rp, user: { id: fromB64url(o.user.id), name: o.user.name, displayName: o.user.displayName }, challenge: fromB64url(o.challenge),
  pubKeyCredParams: o.pubKeyCredParams, excludeCredentials: (o.excludeCredentials ?? []).map((c) => ({ id: fromB64url(c.id) })),
});
const toGet = (o: PkGet) => ({ rpId: o.rpId, challenge: fromB64url(o.challenge), allowCredentials: (o.allowCredentials ?? []).map((c) => ({ id: fromB64url(c.id) })) });
const allPasskeys = () => passkeys().map((p) => p.data);

/** Should Vault answer this WebAuthn call (and with which passkeys), or leave it to the browser? */
async function pkCheck(kind: "create" | "get", options: PkCreate | PkGet, s: chrome.runtime.MessageSender) {
  if (s.frameId !== 0 || !(await settings()).passkeys) return { use: false };
  if (!vault) return { use: true, locked: true };
  try {
    if (kind === "get") {
      const list = passkeysFor(toGet(options as PkGet), originOf(s), allPasskeys());
      return { use: list.length > 0, passkeys: passkeys().filter((p) => list.includes(p.data)).map((p) => ({ id: p.id, rpId: p.data.rpId, username: p.data.username, displayName: p.data.displayName ?? "" })) };
    }
    const o = options as PkCreate;
    return { use: true, rpId: rpIdFor(originOf(s), o.rp.id), username: o.user.name };
  } catch (e) { return { use: false, error: String((e as Error).message) }; }
}

async function pkCreate(options: PkCreate, s: chrome.runtime.MessageSender) {
  if (!vault) return { error: "locked" };
  try {
    const r = await createPasskey(toCreate(options), originOf(s), allPasskeys());
    vault.add(r.item);
    await save();
    return {
      id: b64url(r.credentialId), clientDataJSON: b64url(r.clientDataJSON), attestationObject: b64url(r.attestationObject),
      authenticatorData: b64url(r.authenticatorData), publicKey: b64url(r.publicKey), publicKeyAlgorithm: r.publicKeyAlgorithm,
    };
  } catch (e) { return { error: (e as Error).message, name: (e as DOMException).name }; }
}

async function pkGet(options: PkGet, id: string, s: chrome.runtime.MessageSender) {
  const p = vault?.get(id);
  if (!vault || p?.data.type !== "passkey") return { error: "locked" };
  try {
    const a = await passkeySignIn(toGet(options), originOf(s), p.data);
    return { id: b64url(a.credentialId), clientDataJSON: b64url(a.clientDataJSON), authenticatorData: b64url(a.authenticatorData), signature: b64url(a.signature), userHandle: b64url(a.userHandle) };
  } catch (e) { return { error: (e as Error).message, name: (e as DOMException).name }; }
}

// ------------------------------------------------------------------ messages
/** The popup (or any of the extension's own pages); a content script reports the web page's address instead. */
const fromPopup = (s: chrome.runtime.MessageSender) => s.id === chrome.runtime.id && !!s.url?.startsWith(chrome.runtime.getURL(""));
async function activeTab() { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); return tab; }

async function handle(m: Msg, s: chrome.runtime.MessageSender): Promise<unknown> {
  await restored;
  const tabId = s.tab?.id ?? -1;
  const url = s.url ?? "";
  if (vault) void touch();
  switch (m.t) {
    case "settings": return settings();
    case "match": return vault ? matches(url) : { locked: true };
    case "fill": {
      const l = vault && fillableUrl(url) ? loginsFor(url, logins()).find((x) => x.id === m.id) : undefined;
      if (!l) return { error: "not for this site" };
      const c = linkedCode(l);
      return { username: l.data.username, password: l.data.password, ...(c ? { code: (await fresh(c.data.otp)).code } : {}) };
    }
    case "code": {
      const c = vault && fillableUrl(url) ? codesFor(url, codes(), logins()).find((x) => x.id === m.id) : undefined;
      return c ? { code: (await fresh(c.data.otp)).code } : { error: "not for this site" };
    }
    case "submitted": return void submitted(tabId, url, m.username, m.password);
    case "lastUser": return void mem.set({ [`user:${tabId}`]: { username: m.username, at: Date.now() } });
    case "pending": { const p = await takePending(tabId); return p ? offerOf(p) : null; }
    case "save": return decide(m.id, m.decision);
    case "openPopup": try { await chrome.action.openPopup(); return { ok: true }; } catch { return { ok: false }; }
    case "pkCheck": return pkCheck(m.kind, m.options, s);
    case "pkCreate": return s.frameId === 0 ? pkCreate(m.options, s) : { error: "frame" };
    case "pkGet": return s.frameId === 0 ? pkGet(m.options, m.id, s) : { error: "frame" };
  }
  if (!fromPopup(s)) return { error: "not allowed" };
  switch (m.t) {
    case "state": {
      if (vault && session && Date.now() - ((await mem.get<number>("pulled")) ?? 0) > 30_000) { await mem.set({ pulled: Date.now() }); void sync(); }
      const email = vault?.email ?? (await local.get("email", ""));
      return { state: vault ? "open" : email ? "locked" : "signedOut", email, synced, settings: await settings() } satisfies State;
    }
    case "signIn": try { await signIn(m.email, m.password); return { ok: true }; } catch (e) { return { error: (e as Error).message }; }
    case "lock": await lock(); return { ok: true };
    case "signOut": await lock(); await chrome.storage.local.remove(["file", "email"]); return { ok: true };
    case "sync": await sync(); return { synced };
    case "list": {
      if (!vault) return { locked: true };
      const tab = m.site ? await activeTab() : undefined;
      return { items: await summaries(m.q, m.site ? (tab?.url && fillableUrl(tab.url) ? tab.url : "about:blank") : null), site: tab?.url && /^https?:/.test(tab.url) ? siteOfUrl(tab.url) : "" };
    }
    case "item": return vault ? detail(m.id) : { locked: true };
    case "saveLogin": return vault ? saveLogin(m.login) : { locked: true };
    case "delete": if (vault?.get(m.id)) { vault.remove(m.id); await save(); } return { ok: true };
    case "pin": {
      const it = vault?.get(m.id);
      if (it && it.data.type !== "note") { vault!.update(it.id, { ...it.data, favorite: !(it.data as { favorite?: boolean }).favorite } as typeof it.data); await save(); }
      return { ok: true };
    }
    case "fillTab": {
      const tab = await activeTab();
      const l = tab?.url && vault ? loginsFor(tab.url, logins()).find((x) => x.id === m.id) : undefined;
      if (!tab?.id || !l) return { error: "This login isn't for the page that's open." };
      const c = linkedCode(l);
      await chrome.tabs.sendMessage(tab.id, { t: "doFill", username: l.data.username, password: l.data.password, code: c ? (await fresh(c.data.otp)).code : "" }, { frameId: 0 });
      return { ok: true };
    }
    case "setSettings": {
      await local.set({ settings: { ...(await settings()), ...m.settings } });
      if ("takeover" in m.settings) await applyTakeover();
      return settings();
    }
    case "never": return { sites: await local.get<string[]>("never", []) };
    case "unnever": await local.set({ never: (await local.get<string[]>("never", [])).filter((x) => x !== m.site) }); return { ok: true };
    case "generate": return { password: generatePassword({ length: 20 }) };
  }
  return { error: "unknown" };
}

chrome.runtime.onMessage.addListener((m: Msg, s, reply) => {
  handle(m, s).then(reply, (e) => reply({ error: String((e as Error)?.message ?? e) }));
  return true;
});
chrome.tabs.onRemoved.addListener((id) => void mem.del([`pending:${id}`, `user:${id}`]));
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== "fill-login") return;
  const tab = await activeTab();
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { t: "fillBest" }).catch(() => {});
});
