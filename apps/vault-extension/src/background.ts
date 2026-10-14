/// <reference types="chrome" />
// Vault's extension, behind the scenes. It never stores a password: every login and 2FA code comes from
// the Vault app on this PC (127.0.0.1), which only answers this extension once you allowed it there,
// and only for the site the browser itself says a page is on.
import type { Msg } from "./messages.ts";

const BRIDGE = "http://127.0.0.1:47350/v1";
type Res = Record<string, unknown> & { error?: string; locked?: boolean };

async function stored<T>(key: string, fallback: T): Promise<T> {
  const v = (await chrome.storage.local.get(key))[key];
  return (v ?? fallback) as T;
}

async function call(body: Record<string, unknown>, timeoutMs = 15_000): Promise<Res> {
  try {
    const r = await fetch(BRIDGE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, token: await stored<string>("token", "") }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const res = (await r.json()) as Res;
    if (res.error === "unpaired") await chrome.storage.local.remove("token");
    return res;
  } catch {
    return { error: "offline" };
  }
}

// ------------------------------------------------------------------ the browser's own password manager
/** While Vault is the password manager, the browser stops offering to save passwords itself. */
async function applyTakeover() {
  const on = await stored("takeover", true);
  try { await chrome.privacy.services.passwordSavingEnabled.set({ value: !on }); } catch { /* managed by policy */ }
}
chrome.runtime.onInstalled.addListener(() => void applyTakeover());
chrome.runtime.onStartup.addListener(() => void applyTakeover());

// ------------------------------------------------------------------ saving what was typed
type PendingSave = { id: string; tabId: number; url: string; username: string; password: string; state: "new" | "changed"; name?: string; at: number };
// Kept in session storage (memory only, gone when the browser closes): this worker may be stopped
// between a sign-in and the next page, or while the Save bar waits for a click.
const session = {
  async get<T>(key: string): Promise<T | undefined> { return (await chrome.storage.session.get(key))[key] as T | undefined; },
  set: (key: string, v: unknown) => chrome.storage.session.set({ [key]: v }),
  del: (key: string | string[]) => chrome.storage.session.remove(key),
};

const siteOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };

async function submitted(tabId: number, url: string, username: string, password: string) {
  if (!password || !/^https:|^http:\/\/(localhost|127\.|192\.168\.|10\.)/.test(url)) return;
  const never = await stored<string[]>("never", []);
  if (never.includes(siteOf(url))) return;
  if (!username) {   // a sign-in that asked for the name on an earlier page
    const lu = await session.get<{ username: string; at: number }>(`user:${tabId}`);
    if (lu && Date.now() - lu.at < 10 * 60_000) username = lu.username;
  }
  const r = await call({ op: "check", url, username, password });
  if (r.state !== "new" && r.state !== "changed") return;
  const p: PendingSave = { id: crypto.randomUUID(), tabId, url, username, password, state: r.state, name: r.name as string | undefined, at: Date.now() };
  await session.set(`pending:${tabId}`, p);
  // Same page (a sign-in that doesn't reload): offer it there. Otherwise the next page asks for it.
  setTimeout(() => void offer(tabId), 1200);
}

async function offer(tabId: number) {
  const p = await takePending(tabId);
  if (!p) return;
  try { await chrome.tabs.sendMessage(tabId, { t: "offerSave", ...offerOf(p) }, { frameId: 0 }); }
  catch { await session.set(`pending:${tabId}`, p); }   // the page is still loading: it asks when it's ready
}
async function takePending(tabId: number) {
  const p = await session.get<PendingSave>(`pending:${tabId}`);
  await session.del(`pending:${tabId}`);
  if (!p || Date.now() - p.at > 3 * 60_000) return undefined;
  await session.set(`offer:${p.id}`, p);              // offered: waiting for Save / Never
  return p;
}
const offerOf = (p: PendingSave) => ({ id: p.id, site: siteOf(p.url), username: p.username, state: p.state, name: p.name });

// ------------------------------------------------------------------ messages
const fromPopup = (s: chrome.runtime.MessageSender) => !s.tab && s.url?.startsWith(chrome.runtime.getURL("popup.html"));

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function handle(m: Msg, s: chrome.runtime.MessageSender): Promise<unknown> {
  const tabId = s.tab?.id ?? -1;
  const url = s.url ?? "";
  switch (m.t) {
    // ---- from pages
    case "match": return call({ op: "match", url });
    case "fill": return call({ op: "fill", url, id: m.id });
    case "code": return call({ op: "code", url, id: m.id });
    case "submitted": return void submitted(tabId, url, m.username, m.password);
    case "lastUser": return void session.set(`user:${tabId}`, { username: m.username, at: Date.now() });
    case "pending": { const p = await takePending(tabId); return p ? offerOf(p) : null; }
    case "save": {
      const p = await session.get<PendingSave>(`offer:${m.id}`);
      await session.del(`offer:${m.id}`);
      if (!p) return { error: "expired" };
      if (m.decision === "never") {
        await chrome.storage.local.set({ never: [...new Set([...(await stored<string[]>("never", [])), siteOf(p.url)])] });
        return { ok: true };
      }
      return call({ op: "save", url: p.url, username: p.username, password: p.password });
    }
    case "open": return call({ op: "show" });
  }
  if (!fromPopup(s)) return { error: "not allowed" };
  switch (m.t) {
    // ---- from the popup (only)
    case "status": {
      const r = await call({ op: "hello" });
      return { offline: r.error === "offline", paired: !!r.paired, locked: !!r.locked, takeover: await stored("takeover", true) };
    }
    case "pair": {
      // Keep this worker awake while the person decides in Vault (pairing waits up to 100 s).
      const awake = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
      const browser = /Edg\//.test(navigator.userAgent) ? "Edge" : (navigator as { brave?: unknown }).brave ? "Brave" : "Chrome";
      const r = await call({ op: "pair", code: m.code, browser }, 105_000).finally(() => clearInterval(awake));
      if (typeof r.token === "string") { await chrome.storage.local.set({ token: r.token }); return { ok: true }; }
      return r;
    }
    case "unpair": await chrome.storage.local.remove("token"); return { ok: true };
    case "search": return call({ op: "search", q: m.q });
    case "secret": return call({ op: "secret", id: m.id });
    case "tabMatch": { const tab = await activeTab(); return tab?.url ? { ...(await call({ op: "match", url: tab.url })), site: siteOf(tab.url) } : { logins: [], codes: [] }; }
    case "fillTab": {
      const tab = await activeTab();
      if (!tab?.id || !tab.url) return { error: "no page" };
      const r = await call({ op: "fill", url: tab.url, id: m.id });
      if (r.error) return r;
      await chrome.tabs.sendMessage(tab.id, { t: "doFill", username: r.username, password: r.password, code: r.code }, { frameId: 0 });
      return { ok: true };
    }
    case "takeover": await chrome.storage.local.set({ takeover: m.on }); await applyTakeover(); return { ok: true };
    case "never": return { sites: await stored<string[]>("never", []) };
    case "unnever": await chrome.storage.local.set({ never: (await stored<string[]>("never", [])).filter((x) => x !== m.site) }); return { ok: true };
  }
  return { error: "unknown" };
}

chrome.runtime.onMessage.addListener((m: Msg, s, reply) => {
  handle(m, s).then(reply, (e) => reply({ error: String(e) }));
  return true;
});

chrome.tabs.onRemoved.addListener((id) => void session.del([`pending:${id}`, `user:${id}`]));

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== "fill-login") return;
  const tab = await activeTab();
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { t: "fillBest" }).catch(() => {});
});
