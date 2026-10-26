// Letterbox in the browser and Windows app: every Zoho mailbox the person added, in one place. The sidebar
// has the combined views (all inboxes, unread, important) and then each mailbox's own folders; the list
// has multi-select; the reader; compose with attachments and a From picker; Settings adds and removes
// mailboxes. Talks to server/server.ts (relative URLs on the web, marobotic.dev/letterbox in the app).
import type { Folder, Summary, Message, Upload } from "../server/zoho.ts";
import * as platform from "./platform.ts";

type Account = { id: string; email: string; name: string; color: number };
type Mail = Summary & { account: string; body?: Message };
type Page = { messages: Mail[]; next: string | null; errors: { account: string; error: string }[] };

const PAGE = 50;
const AUTO_REFRESH_MS = 30_000;
const MAX_FILE = 20 * 1024 * 1024;
const ICONS: Record<string, string> = {
  Inbox: "\uf01c", Drafts: "\uf044", Templates: "\uf15c", Snoozed: "\uf017", Sent: "\uf1d8",
  Spam: "\uf05e", Trash: "\uf1f8", Outbox: "\uf093", Archive: "\uf187",
};
// Each mailbox's colour, by its place in the person's list (the server hands out 0-5).
const COLORS = ["var(--accent)", "var(--teal)", "var(--gold)", "var(--orange)", "#8E6BBF", "var(--grey)"];
// Not Zoho folders: lists drawn from every folder of the mailboxes shown.
const INBOX: Folder = { id: "p:/Inbox", name: "Inbox", type: "Inbox", path: "/Inbox" };   // until the folders load
const UNREAD: Folder = { id: "unread", name: "Unread", type: "Unread", path: "" };      // every folder but Spam and Trash
const IMPORTANT: Folder = { id: "important", name: "Important", type: "Important", path: "" };
const SEARCH: Folder = { id: "search", name: "Search", type: "Search", path: "" };
const MIXED = new Set([UNREAD, IMPORTANT, SEARCH]);   // lists whose mail comes from many folders
const SENT_LIKE = new Set(["Sent", "Drafts", "Outbox", "Templates"]);
const ALL = "all";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, text?: string | null): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const state = {
  me: "",
  canAdd: false,
  accounts: [] as Account[],
  folders: new Map<string, Folder[]>(),          // each mailbox's own folders
  folderErrors: new Map<string, string>(),
  account: ALL,                                  // the mailbox the current folder is in, or all of them
  current: INBOX,
  messages: [] as Mail[],
  next: null as string | null,
  loading: false,
  done: false,
  seq: 0,
  selected: new Set<string>(),                   // keyOf() of each picked row
  anchor: -1,                                    // the last row clicked, for shift-click ranges
  open: null as Mail | null,
  query: "",
  before: { account: ALL, folder: INBOX },       // where a search was started from, for clearing it
};
const keyOf = (m: Mail) => `${m.account}:${m.id}`;
const accountOf = (id: string) => state.accounts.find((a) => a.id === id);
const colorOf = (id: string) => COLORS[(accountOf(id)?.color ?? 0) % COLORS.length]!;

// ---------- server ----------
class HttpError extends Error { constructor(message: string, readonly status: number) { super(message); } }
function reqHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  const sess = platform.getSession();
  if (sess) headers.set("authorization", `Bearer ${sess}`);
  return headers;
}
async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = reqHeaders(init.headers);
  if (init.method && init.method !== "GET") headers.set("x-letterbox", "1");
  if (typeof init.body === "string") headers.set("content-type", "application/json");
  let r: Response;
  try {
    r = await fetch(platform.apiUrl(path), { ...init, headers, credentials: platform.inApp ? "omit" : "same-origin" });
  } catch {
    throw new HttpError("Can't reach the server", 0);
  }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { void platform.setSession(""); showGate(); throw new HttpError("Sign in", 401); }
  if (!r.ok) throw new HttpError(j.error || `HTTP ${r.status}`, r.status);
  return j as T;
}
const post = <T = any>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) });
const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();

// ---------- small things ----------
let toastTimer = 0;
function toast(text: string) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 2600);
}
function sync(text: string, color: string) {
  $("sync").textContent = text;
  $("sync").style.setProperty("--state", color);
}
const synced = () => sync("Synced " + new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }), "var(--teal)");
const folderOf = (m: Mail) => state.folders.get(m.account)?.find((f) => f.id === m.folderId);
const typeOf = (m: Mail) => folderOf(m)?.type ?? "";
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function dayGroup(t: number) {
  const d = new Date(t), now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t >= start) return "Today";
  if (t >= start - 864e5) return "Yesterday";
  if (t >= start - 6 * 864e5) return "Last 7 days";
  const month = d.toLocaleDateString(undefined, { month: "long" });
  if (d.getFullYear() === now.getFullYear()) return d.getMonth() === now.getMonth() ? `Earlier in ${month}` : month;
  return String(d.getFullYear());
}
function when(t: number) {
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() && { year: "numeric" }) });
}
/** A dot in the mailbox's colour, so mail from different accounts tells apart in the combined lists. */
function dot(account: string) {
  const d = el("span", "dot");
  d.style.background = colorOf(account);
  d.title = accountOf(account)?.email ?? "";
  return d;
}

// ---------- sign-in (the same screen as Hourglass, Jukebox and Vault) ----------
type GateMode = "signin" | "create" | "forgot";
let gateMode: GateMode = "signin";
let seenUnread: Set<string> | null = null;

function showGate(message = "", mode: GateMode = "signin") {
  gateMode = mode;
  seenUnread = null;
  $("app").hidden = true;
  $("composer").hidden = true;
  $("settings").hidden = true;
  $("gate").hidden = false;
  const create = mode === "create", forgot = mode === "forgot";
  $("gate-switch").hidden = forgot;
  for (const b of $("gate-switch").querySelectorAll<HTMLButtonElement>("button[data-mode]")) {
    b.classList.toggle("on", b.dataset.mode === mode);
  }
  $("gate-lead").hidden = !forgot;
  const em = $<HTMLInputElement>("em"), pw = $<HTMLInputElement>("pw"), pw2 = $<HTMLInputElement>("pw2");
  if (!em.value) em.value = localStorage.getItem("letterbox.email") || "";
  $("pw-lab").hidden = pw.hidden = forgot;
  pw.autocomplete = create ? "new-password" : "current-password";
  $("pw2-lab").hidden = pw2.hidden = !create;
  $("toForgot").hidden = create || forgot;
  $("gate-hint").hidden = forgot;
  $("gate-hint").textContent = create ? "At least 8 characters." : "The same account as Hourglass and Jukebox.";
  $("gate-notice").textContent = "";
  $("gate-error").textContent = message;
  $<HTMLButtonElement>("signin").textContent = forgot ? "Send reset link" : create ? "Create account" : "Sign in";
  $("flip-text").textContent = forgot ? "Remembered it? " : create ? "Already have an account? " : "New here? ";
  $("flip").textContent = forgot || create ? "Sign in" : "Create an account";
  (em.value && !forgot ? pw : em).focus();
}
for (const b of $("gate-switch").querySelectorAll<HTMLButtonElement>("button[data-mode]")) {
  b.onclick = () => showGate("", b.dataset.mode as GateMode);
}
$("toForgot").onclick = (e) => { e.preventDefault(); showGate("", "forgot"); };
$("flip").onclick = (e) => { e.preventDefault(); showGate("", gateMode === "signin" ? "create" : "signin"); };
for (const id of ["em", "pw", "pw2"]) $(id).addEventListener("input", () => { $("gate-error").textContent = ""; });

$("gate-form").onsubmit = async (e) => {
  e.preventDefault();
  const email = $<HTMLInputElement>("em").value.trim().toLowerCase();
  const pw = $<HTMLInputElement>("pw").value;
  const pw2 = $<HTMLInputElement>("pw2").value;
  $("gate-notice").textContent = "";
  $("gate-error").textContent = "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { $("gate-error").textContent = "Enter a valid email address."; return; }
  const btn = $<HTMLButtonElement>("signin");
  const label = btn.textContent ?? "Sign in";
  if (gateMode === "forgot") {
    btn.disabled = true;
    btn.textContent = "Sending…";
    try {
      await post("auth/forgot", { email, app: "music" });
      $("gate-notice").textContent = `If ${email} has an account, a reset link is on its way. Open it on any device; it works for one hour.`;
    } catch (err) {
      $("gate-error").textContent = (err as Error).message;
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
    return;
  }
  if (pw.length < 8) { $("gate-error").textContent = "The password needs at least 8 characters."; return; }
  if (gateMode === "create" && pw2 !== pw) { $("gate-error").textContent = "The passwords do not match."; return; }
  btn.disabled = true;
  btn.textContent = gateMode === "create" ? "Creating account…" : "Signing in…";
  try {
    const out = await post<{ ok: boolean; session?: string }>(gateMode === "create" ? "auth/register" : "auth/login", { email, password: pw });
    localStorage.setItem("letterbox.email", email);
    if (out.session) await platform.setSession(out.session);
    $<HTMLInputElement>("pw").value = $<HTMLInputElement>("pw2").value = "";
    $("gate").hidden = true;
    await start();
  } catch (err) {
    $("gate-error").textContent = (err as Error).message;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
};
async function signOut() {
  await post("auth/logout", {}).catch(() => {});
  await platform.setSession("");
  if (platform.inApp) {
    closeReader();
    showGate();
  } else {
    location.reload();
  }
}
$("signout").onclick = signOut;

// ---------- mailboxes ----------
/** Who is signed in, their mailboxes and each one's folders. */
async function loadAccounts() {
  const me = await api<{ email: string; accounts: Account[]; canAdd: boolean }>("api/me");
  state.me = me.email;
  state.accounts = me.accounts;
  state.canAdd = me.canAdd;
  $("email").textContent = me.email;
  const got = await api<{ account: string; folders?: Folder[]; error?: string }[]>("api/folders");
  state.folders.clear();
  state.folderErrors.clear();
  for (const f of got) {
    if (f.folders) state.folders.set(f.account, f.folders);
    else state.folderErrors.set(f.account, f.error ?? "Couldn't open it");
  }
  renderSettings();
}

// The Zoho sign-in: on the web this page goes to Zoho and comes back; the app opens the browser for it and
// watches for the new mailbox to turn up.
let watching = 0;
async function addAccount() {
  try {
    const { url } = await post<{ url: string }>("api/accounts/connect", { app: platform.inApp });
    if (!platform.inApp) { location.href = url; return; }
    await platform.openUrl(url);
    toast("Sign in to Zoho in your browser, then come back here");
    const had = new Set(state.accounts.map((a) => a.id));
    clearInterval(watching);
    const until = Date.now() + 10 * 60_000;
    watching = window.setInterval(async () => {
      if (Date.now() > until) return clearInterval(watching);
      const me = await api<{ accounts: Account[] }>("api/me").catch(() => null);
      const fresh = me?.accounts.filter((a) => !had.has(a.id)) ?? [];
      if (!fresh.length) return;
      clearInterval(watching);
      toast(`Added ${fresh.map((a) => a.email).join(", ")}`);
      await refreshAll();
    }, 3000);
  } catch (e) {
    toast(`Couldn't start Zoho's sign-in: ${(e as Error).message}`);
  }
}
async function removeAccount(a: Account) {
  if (!confirm(`Remove ${a.email} from Letterbox? Its mail stays in Zoho; you can add it again any time.`)) return;
  try {
    await post("api/accounts/remove", { id: a.id });
    toast(`Removed ${a.email}`);
    if (state.account === a.id) { state.account = ALL; state.current = INBOX; }
    await refreshAll();
  } catch (e) {
    toast(`Couldn't remove it: ${(e as Error).message}`);
  }
}
/** After a mailbox comes or goes: everything that depends on the list of them. */
async function refreshAll() {
  await loadAccounts();
  showMain();
  openFolder(state.current);
  countUnread();
  countImportant();
}

// ---------- settings: a page of its own (back or Esc leave it) ----------
function renderSettings() {
  $("s-email").textContent = state.me;
  showMyPicture();
  const list = $("s-accounts");
  list.replaceChildren(...state.accounts.map((a) => {
    const row = el("div", "set");
    const txt = el("div");
    const b = el("b");
    const pic = el("span", "pic");
    void showPicture(pic, a.email, colorOf(a.id));
    b.append(pic, document.createTextNode(a.email));
    const err = state.folderErrors.get(a.id);
    txt.append(b, el("span", err ? "bad" : null, err ?? (a.name ? `${a.name} · Zoho Mail` : "Zoho Mail")));
    const rm = el("button", "m-btn subtle compact danger", "Remove");
    rm.type = "button";
    rm.onclick = () => void removeAccount(a);
    row.append(txt, rm);
    return row;
  }));
  if (!state.accounts.length) list.append(el("div", "set none", "No mailboxes yet."));
  $<HTMLButtonElement>("s-add").disabled = !state.canAdd;
  $("s-add-note").textContent = state.canAdd
    ? "Zoho asks you to sign in and to let Letterbox read and send your mail. Any Zoho Mail account works, the free plan too, in any of Zoho's regions. Add as many as you like."
    : "Adding accounts isn't switched on for this server yet.";
}
function openSettings() {
  renderSettings();
  $("settings").hidden = false;
}
const closeSettings = () => { $("settings").hidden = true; };
$("open-settings").onclick = openSettings;
$("s-back").onclick = closeSettings;
$("s-add").onclick = () => void addAccount();
$("s-signout").onclick = signOut;
$("welcome-add").onclick = () => void addAccount();

// ---------- the sidebar: accounts, then one set of folders ----------
// One button per mailbox (or all of them); the folders below are the same list for every mailbox, by path,
// so Inbox is every inbox at once until a mailbox is picked.
const pathFolder = (f: Folder): Folder => ({ ...f, id: `p:${f.path || `/${f.name}`}` });
/** The folders to show: the picked mailbox's own, or every mailbox's merged (the first one's order). */
function visibleFolders(): Folder[] {
  const from = state.account === ALL ? state.accounts.map((a) => a.id) : [state.account];
  const seen = new Map<string, Folder>();
  for (const id of from) {
    for (const f of state.folders.get(id) ?? []) {
      const pf = pathFolder(f);
      if (!seen.has(pf.id.toLowerCase())) seen.set(pf.id.toLowerCase(), pf);
    }
  }
  return [...seen.values()];
}
const inboxFolder = () => visibleFolders().find((f) => f.type === "Inbox" && (f.path || "").toLowerCase() === "/inbox") ?? INBOX;

// Unread and important, counted per mailbox from one page of up to 200 over all of them (past that, 200+).
const counts = {
  unread: new Map<string, number>(), unreadCapped: false,
  important: new Map<string, number>(), importantCapped: false,
};
function badge(kind: "unread" | "important", account = state.account): string | null {
  const by = counts[kind];
  const n = account === ALL ? [...by.values()].reduce((a, b) => a + b, 0) : by.get(account) ?? 0;
  return n ? `${n}${counts[`${kind}Capped`] ? "+" : ""}` : null;
}
function tally(kind: "unread" | "important", page: Mail[]) {
  const by = new Map<string, number>();
  for (const m of page) by.set(m.account, (by.get(m.account) ?? 0) + 1);
  counts[kind] = by;
  counts[`${kind}Capped`] = page.length === 200;
}
function bump(kind: "unread" | "important", list: Mail[], delta: 1 | -1) {
  for (const m of list) counts[kind].set(m.account, Math.max(0, (counts[kind].get(m.account) ?? 0) + delta));
  renderFolders();
}

function navRow(f: Folder, icon: string, sub = false, iconCls = "") {
  const row = el("div", "m-nav" + (sub ? " sub" : "") + (f.id.toLowerCase() === state.current.id.toLowerCase() ? " current" : ""));
  row.append(el("span", "ico" + (iconCls ? ` ${iconCls}` : ""), icon), el("span", "name", f.name));
  row.onclick = () => openFolder(f);
  return row;
}
function accountRow(id: string, label: string) {
  const row = el("div", "m-nav acct" + (state.account === id ? " current" : ""));
  const pic = el("span", "pic");
  if (id === ALL) pic.textContent = "\uf0c0";
  else void showPicture(pic, accountOf(id)!.email, colorOf(id));
  row.append(pic, el("span", "name", label));
  const n = badge("unread", id);
  if (n) row.append(el("span", "badge", n));
  row.title = id === ALL ? "Mail from every account" : label;
  row.onclick = () => pickAccount(id);
  return row;
}
function renderFolders() {
  const nav = $("folders");
  nav.replaceChildren();
  if (!state.accounts.length) return;
  if (state.accounts.length > 1) nav.append(accountRow(ALL, "All accounts"));
  for (const a of state.accounts) nav.append(accountRow(a.id, a.email));
  nav.append(el("div", "nav-sep"));
  const unread = navRow(UNREAD, "\uf0e0");
  const u = badge("unread");
  if (u) unread.append(el("span", "badge", u));
  const important = navRow(IMPORTANT, "\uf005", false, "gold");
  const i = badge("important");
  if (i) important.append(el("span", "badge gold", i));
  nav.append(unread, important, el("div", "nav-sep"));
  const err = state.account !== ALL ? state.folderErrors.get(state.account) : null;
  if (err) {
    const bad = el("div", "acct-err", err);
    bad.onclick = openSettings;
    nav.append(bad);
  }
  for (const f of visibleFolders()) {
    const sub = (f.path || "").split("/").filter(Boolean).length > 1;   // /Inbox/Receipts is a sub folder
    nav.append(navRow(f, sub ? "\uf07b" : ICONS[f.type] ?? "\uf07b", sub));
  }
}
/** Shows one mailbox (or all): the same folder when it has one, else its Inbox. */
function pickAccount(id: string) {
  state.account = id;
  const keep = MIXED.has(state.current) || visibleFolders().some((f) => f.id.toLowerCase() === state.current.id.toLowerCase());
  openFolder(keep ? state.current : inboxFolder());
}
function notifyNewMail(fresh: Mail[]) {
  if (!fresh.length) return;
  if (fresh.length === 1) {
    const m = fresh[0]!;
    const from = m.from || m.fromAddress || "New message";
    const subj = m.subject || "(no subject)";
    const to = state.accounts.length > 1 ? ` · ${accountOf(m.account)?.email ?? ""}` : "";
    void platform.notify(from + to, m.summary ? `${subj} — ${m.summary}` : subj);
    return;
  }
  const body = fresh.slice(0, 3).map((m) => `${m.from || m.fromAddress}: ${m.subject || "(no subject)"}`).join("\n");
  void platform.notify(`${fresh.length} new messages`, body);
}

async function countUnread() {
  if (!state.accounts.length) return;
  try {
    const page = (await api<Page>(`api/messages?${qs({ account: ALL, folder: "unread", limit: "200" })}`)).messages;
    tally("unread", page);
    renderFolders();
    if (seenUnread === null) {
      seenUnread = new Set(page.map(keyOf));
      return;
    }
    const fresh = page.filter((m) => !seenUnread!.has(keyOf(m)));
    for (const m of page) seenUnread.add(keyOf(m));
    if (fresh.length) {
      notifyNewMail(fresh);
      if ($("reader").hidden && !state.selected.size && !state.loading && state.current !== SEARCH && state.messages.length <= PAGE && $("list").scrollTop <= 40) {
        load(true, true);
      }
    }
  } catch { /* the badges stay as they were */ }
}
async function countImportant() {
  if (!state.accounts.length) return;
  try {
    tally("important", (await api<Page>(`api/messages?${qs({ account: ALL, folder: "important", limit: "200" })}`)).messages);
    renderFolders();
  } catch { /* the badges stay as they were */ }
}

function openFolder(f: Folder) {
  // A mailbox that is gone (removed in Settings) takes its folders with it.
  if (state.account !== ALL && !accountOf(state.account)) state.account = ALL;
  state.current = f;
  state.selected.clear();
  if (f !== SEARCH) { state.query = ""; $<HTMLInputElement>("q").value = ""; }
  $("q-clear").hidden = f !== SEARCH;
  const where = state.account !== ALL && state.accounts.length > 1 ? ` · ${accountOf(state.account)?.email ?? ""}` : "";
  $("title").textContent = (f === SEARCH ? "SEARCH" : f.name.toUpperCase()) + where;
  closeContextMenu();
  closeReader();
  renderFolders();
  load(true);
}

// ---------- pictures: the marobotic account's own (set here, in Vault or at marobotic.dev/dashboard) ----------
const CACHE = "https://marobotic.dev/cache";
const pictures = new Map<string, Promise<string | null>>();
/** The picture's address for an email (found by its sha256, like Gravatar), or null when there is none. */
function pictureOf(email: string, fresh = false): Promise<string | null> {
  const key = email.trim().toLowerCase();
  if (!fresh && pictures.has(key)) return pictures.get(key)!;
  const p = (async () => {
    if (!key || !crypto.subtle) return null;
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    const url = `${CACHE}/avatar/${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")}?t=${fresh ? Date.now() : Date.now() >> 16}`;
    return new Promise<string | null>((done) => { const i = new Image(); i.onload = () => done(url); i.onerror = () => done(null); i.src = url; });
  })();
  pictures.set(key, p);
  return p;
}
/** The picture in `node`, or the email's first letter (on `color`) until, or unless, there is one. */
async function showPicture(node: HTMLElement, email: string, color = "var(--surface2)"): Promise<boolean> {
  node.textContent = (email[0] || "?").toUpperCase();
  node.style.background = color;
  const url = await pictureOf(email);
  if (!url) return false;
  const img = new Image();
  img.alt = "";
  img.src = url;
  node.replaceChildren(img);
  return true;
}
async function setPicture(image: Blob | null) {
  try {
    await api("api/avatar", { method: image ? "POST" : "DELETE", ...(image ? { body: image, headers: { "content-type": image.type || "application/octet-stream" } } : {}) });
    await pictureOf(state.me, true);
    showMyPicture();
    renderFolders();
    toast(image ? "Picture saved; the other apps show it within a few minutes" : "Picture removed");
  } catch (e) {
    toast((e as Error).message);
  }
}
function showMyPicture() {
  void showPicture($("me"), state.me);
  void showPicture($("s-pic"), state.me).then((has) => { $("s-pic-del").hidden = !has; });
}
$("me").onclick = () => openSettings();
$("s-pic-set").onclick = () => $("s-pic-file").click();
$<HTMLInputElement>("s-pic-file").onchange = (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = "";
  if (f) void setPicture(f);
};
$("s-pic-del").onclick = () => void setPicture(null);

// ---------- the list ----------
function renderList() {
  closeContextMenu();
  const list = $("list");
  list.replaceChildren();
  if (!state.messages.length) {
    const none = state.current === UNREAD ? "You're all caught up."
      : state.current === IMPORTANT ? "Nothing marked important yet."
      : state.current === SEARCH ? `Nothing matches "${state.query}".`
      : "Nothing in this folder.";
    list.append(el("div", "empty", state.loading ? "Loading..." : none));
  }
  let group: string | null = null;
  state.messages.forEach((m, i) => {
    const g = dayGroup(m.time);
    if (g !== group) list.append(el("div", "m-section group", (group = g)));
    list.append(row(m, i));
  });
  renderBulk();
}

const flipping = new Set<string>();
function row(m: Mail, index: number) {
  const key = keyOf(m);
  const r = el("div", "mail" + (m.unread ? " unread" : "") + (state.selected.has(key) ? " selected" : ""));
  r.title = `${m.fromAddress}
${new Date(m.time).toLocaleString()}${state.accounts.length > 1 ? `\nTo ${accountOf(m.account)?.email ?? ""}` : ""}`;
  // The checkbox sits in a cell as tall as the row: a click anywhere in it selects, never opens.
  const box = el("label", "check pick");
  box.title = "Select";
  const cb = el("input");
  cb.type = "checkbox";
  cb.checked = state.selected.has(key);
  box.append(cb, el("span"));
  box.onclick = (e) => e.stopPropagation();
  cb.onclick = (e) => {
    // Shift-click selects (or clears) everything between the last clicked row and this one.
    if (e.shiftKey && state.anchor >= 0) {
      const [a, b] = [Math.min(state.anchor, index), Math.max(state.anchor, index)];
      for (const x of state.messages.slice(a, b + 1)) cb.checked ? state.selected.add(keyOf(x)) : state.selected.delete(keyOf(x));
    } else cb.checked ? state.selected.add(key) : state.selected.delete(key);
    state.anchor = index;
    renderList();
  };
  // Closed envelope = unread, open = read; a click flips it, like Zoho's.
  const env = el("button", "env", m.unread ? "\uf0e0" : "\uf2b6");
  env.type = "button";
  env.title = m.unread ? "Mark as read" : "Mark as unread";
  env.setAttribute("aria-label", env.title);
  env.onclick = async (e) => {
    e.stopPropagation();
    if (flipping.has(key)) return;            // a second click before Zoho answers would undo the first
    flipping.add(key);
    try { await act(m.unread ? "read" : "unread", [m], true); } finally { flipping.delete(key); }
  };

  const who = SENT_LIKE.has(typeOf(m)) && m.to ? m.to.replace(/<[^>]*>/g, "").trim() || m.to : m.from;
  const text = el("div", "text");
  if (m.flagged) {
    const star = el("button", "star", "\uf005");
    star.type = "button";
    star.title = "Remove from Important";
    star.setAttribute("aria-label", star.title);
    star.onclick = async (e) => {
      e.stopPropagation();
      if (flipping.has(key)) return;
      flipping.add(key);
      try { await act("unimportant", [m], true); } finally { flipping.delete(key); }
    };
    text.append(star);
  }
  const subject = el("span", "subject", m.subject || "(no subject)");
  const summary = el("span", "summary", m.summary ? "  " + m.summary : "");
  subject.dir = summary.dir = "auto";
  text.append(subject, summary);
  const info = el("div", "side-info");
  if (MIXED.has(state.current)) {
    const f = folderOf(m);
    if (f) info.append(el("span", "m-chip", f.name));
  }
  if (m.threadCount > 1) info.append(el("span", "count", `(${m.threadCount})`));
  if (m.attachment) info.append(el("span", null, "\uf0c6"));
  info.append(el("span", null, when(m.time)));
  const from = el("span", "from");
  if (state.accounts.length > 1 && state.account === ALL) from.append(dot(m.account));
  from.append(document.createTextNode(who));
  from.dir = "auto";
  r.append(box, env, from, text, info);
  r.onclick = () => openMessage(m);
  r.oncontextmenu = (e) => openContextMenu(e, m, r);
  return r;
}

// ---------- context menu ----------
let ctxRow: HTMLElement | null = null;
function closeContextMenu() {
  const menu = $("ctx");
  if (!menu.hidden) menu.hidden = true;
  if (ctxRow) { ctxRow.classList.remove("ctx-open"); ctxRow = null; }
}
function ctxItem(icon: string, label: string, run: () => void, cls = "") {
  const b = el("button", "r" + (cls ? ` ${cls}` : ""));
  b.type = "button";
  b.setAttribute("role", "menuitem");
  b.append(el("span", "ico", icon), el("span", null, label));
  b.onclick = (e) => {
    e.stopPropagation();
    closeContextMenu();
    run();
  };
  return b;
}
function openContextMenu(e: MouseEvent, m: Mail, rowEl: HTMLElement) {
  e.preventDefault();
  e.stopPropagation();
  closeContextMenu();
  ctxRow = rowEl;
  rowEl.classList.add("ctx-open");
  const targets = state.selected.has(keyOf(m)) && state.selected.size > 1
    ? state.messages.filter((x) => state.selected.has(keyOf(x)))
    : [m];
  const menu = $("ctx");
  menu.replaceChildren();
  const head = el("div", "t", targets.length > 1 ? `${targets.length} selected` : (m.from || m.fromAddress || m.subject || "Message"));
  menu.append(head);
  if (targets.length === 1) {
    menu.append(
      ctxItem("\uf112", "Reply", () => void replyMessage(m)),
      ctxItem("\uf064", "Forward", () => void forwardMessage(m)),
      el("div", "sep"),
    );
  }
  const allImportant = targets.every((x) => x.flagged);
  menu.append(
    allImportant
      ? ctxItem("\uf006", "Remove from Important", () => void act("unimportant", targets))
      : ctxItem("\uf005", "Set as Important", () => void act("important", targets), "gold"),
  );
  if (targets.some((x) => x.unread)) menu.append(ctxItem("\uf2b6", "Mark as read", () => void act("read", targets)));
  if (targets.some((x) => !x.unread)) menu.append(ctxItem("\uf0e0", "Mark as unread", () => void act("unread", targets)));
  const t = typeOf(targets[0]!);
  const inSpam = t === "Spam";
  menu.append(
    inSpam
      ? ctxItem("\uf00c", "Not spam", () => void act("notspam", targets))
      : ctxItem("\uf05e", "Move to Spam", () => void act("spam", targets)),
    el("div", "sep"),
    ctxItem("\uf1f8", t === "Trash" || inSpam ? "Delete forever" : "Delete", () => void act("delete", targets), "danger"),
  );
  menu.style.left = "0px";
  menu.style.top = "0px";
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  const x = Math.max(8, Math.min(e.clientX, window.innerWidth - rect.width - 8));
  const y = Math.max(8, Math.min(e.clientY, window.innerHeight - rect.height - 8));
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}
document.addEventListener("click", (e) => {
  if (!$("ctx").hidden && !$("ctx").contains(e.target as Node)) closeContextMenu();
});
document.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  if (target.closest(".mail") || target.closest("#ctx")) return;
  if (target.closest("input, textarea, [contenteditable]")) return;
  closeContextMenu();
  e.preventDefault();
});
$("list").addEventListener("scroll", closeContextMenu, { passive: true });
window.addEventListener("resize", closeContextMenu);
window.addEventListener("blur", closeContextMenu);

function renderBulk() {
  const n = state.selected.size;
  $("bulk").hidden = n === 0;
  $("count").textContent = `${n} selected`;
  const all = $<HTMLInputElement>("all");
  all.checked = n > 0 && state.messages.every((m) => state.selected.has(keyOf(m)));
  all.indeterminate = n > 0 && !all.checked;
  const picked = state.messages.filter((m) => state.selected.has(keyOf(m)));
  const allFlagged = picked.length > 0 && picked.every((m) => m.flagged);
  ($("bulk").querySelector('[data-act="important"]') as HTMLElement).hidden = allFlagged;
  ($("bulk").querySelector('[data-act="unimportant"]') as HTMLElement).hidden = !allFlagged;
  const t = picked[0] ? typeOf(picked[0]) : state.current.type;
  const inSpam = t === "Spam";
  ($("bulk").querySelector('[data-act="spam"]') as HTMLElement).hidden = inSpam;
  ($("bulk").querySelector('[data-act="notspam"]') as HTMLElement).hidden = !inSpam;
  $("delete-label").textContent = t === "Trash" || inSpam ? " Delete forever" : " Delete";
}
$<HTMLInputElement>("all").onchange = (e) => {
  const on = (e.target as HTMLInputElement).checked;
  state.selected.clear();
  if (on) for (const m of state.messages) state.selected.add(keyOf(m));
  renderList();
};
$("clear").onclick = () => { state.selected.clear(); renderList(); };
for (const b of $("bulk").querySelectorAll<HTMLButtonElement>("[data-act]")) {
  b.onclick = () => act(b.dataset.act as Act, state.messages.filter((m) => state.selected.has(keyOf(m))));
}

async function load(reset: boolean, quiet = false) {
  if (!state.accounts.length) return;
  if (!reset && (state.loading || state.done)) return;
  const seq = ++state.seq;                       // a newer load (folder switch, refresh) makes this one stale
  state.loading = true;
  if (reset && !quiet) { state.messages = []; state.done = false; $("more").hidden = true; renderList(); }
  sync("Syncing", "var(--faint)");
  try {
    const params: Record<string, string> = { account: state.account, limit: String(PAGE) };
    if (!reset && state.next) params.cursor = state.next;
    const page = await api<Page>(state.current === SEARCH
      ? `api/search?${qs({ ...params, q: state.query })}`
      : `api/messages?${qs({ ...params, folder: state.current.id })}`);
    if (seq !== state.seq) return;
    state.messages = reset ? page.messages : state.messages.concat(page.messages);
    state.next = page.next;
    state.done = !page.next;
    // Rows that left the folder can't stay selected.
    const here = new Set(state.messages.map(keyOf));
    for (const k of state.selected) if (!here.has(k)) state.selected.delete(k);
    if (page.errors.length && !quiet) {
      toast(page.errors.map((x) => `${accountOf(x.account)?.email ?? "A mailbox"}: ${x.error}`).join(" · "));
    }
    synced();
  } catch (e) {
    if (seq !== state.seq) return;
    sync("Offline", "var(--orange)");
    if (!state.messages.length) $("list").replaceChildren(el("div", "error", `Couldn't load mail: ${(e as Error).message}`));
    return;
  } finally {
    if (seq === state.seq) state.loading = false;
  }
  renderList();
  $("more").hidden = state.done;
}
$("refresh").onclick = () => { load(true); countUnread(); countImportant(); };
$("more").onclick = () => load(false);

// ---------- search: every mailbox at once ----------
$("search").onsubmit = (e) => {
  e.preventDefault();
  const q = $<HTMLInputElement>("q").value.trim();
  if (!q) return clearSearch();
  if (state.current !== SEARCH) state.before = { account: state.account, folder: state.current };
  state.query = q;
  openFolder(SEARCH);
};
function clearSearch() {
  if (state.current === SEARCH) { state.account = state.before.account; openFolder(state.before.folder); }
  else $<HTMLInputElement>("q").value = "";
}
$("q-clear").onclick = clearSearch;
$("q").onkeydown = (e) => {
  if (e.key !== "Escape") return;
  e.stopPropagation();
  clearSearch();
  $("q").blur();
};
// An emptied box (the field's own clear button too) goes back to the folder.
$("q").oninput = () => { if (!$<HTMLInputElement>("q").value && state.current === SEARCH) clearSearch(); };

// Check for new mail in the background too; refresh the visible list when on page 1 with nothing selected.
setInterval(() => {
  if ($("app").hidden) return;
  countUnread();
  if (document.hidden || !$("reader").hidden || state.selected.size || state.loading || state.current === SEARCH) return;
  if (state.messages.length > PAGE || $("list").scrollTop > 40) return;
  load(true, true);
}, AUTO_REFRESH_MS);

// ---------- actions ----------
type Act = "read" | "unread" | "spam" | "notspam" | "important" | "unimportant" | "delete";
const DONE: Record<Act, string> = {
  read: "Marked read", unread: "Marked unread",
  spam: "Moved to Spam", notspam: "Moved to Inbox",
  important: "Set as Important", unimportant: "Removed from Important",
  delete: "Deleted",
};

async function act(action: Act, list: Mail[], quiet = false) {
  if (!list.length) return;
  const forever = action === "delete" && list.some((m) => ["Trash", "Spam"].includes(typeOf(m)));
  if (forever && !confirm(`Delete ${list.length === 1 ? "this message" : `${list.length} messages`} for good? This can't be undone.`)) return;
  sync("Working", "var(--faint)");
  try {
    const r = await post<{ done: number; failed?: string[] }>("api/actions", { action, items: list.map((m) => ({ account: m.account, id: m.id, folder: m.folderId })) });
    const failed = new Set(r.failed ?? []);
    const ok = list.filter((m) => !failed.has(m.id));
    if (action === "read" || action === "unread") {
      const unread = action === "unread";
      bump("unread", ok.filter((m) => m.unread !== unread), unread ? 1 : -1);
      for (const m of ok) { m.unread = unread; seenUnread?.add(keyOf(m)); }
    } else if (action === "important" || action === "unimportant") {
      const flagged = action === "important";
      bump("important", ok.filter((m) => m.flagged !== flagged), flagged ? 1 : -1);
      for (const m of ok) m.flagged = flagged;
      if (!flagged && state.current === IMPORTANT) {
        const gone = new Set(ok.map(keyOf));
        state.messages = state.messages.filter((m) => !gone.has(keyOf(m)));
      }
      if (state.open && ok.some((m) => keyOf(m) === keyOf(state.open!))) {
        state.open.flagged = flagged;
        syncReaderStar();
      }
    } else {
      // Spam, not spam and delete take the mail out of this folder.
      bump("unread", ok.filter((m) => m.unread), -1);
      bump("important", ok.filter((m) => m.flagged), -1);
      const gone = new Set(ok.map(keyOf));
      state.messages = state.messages.filter((m) => !gone.has(keyOf(m)));
    }
    for (const m of ok) state.selected.delete(keyOf(m));
    renderList();
    synced();
    if (failed.size) toast(`${DONE[action]}: ${ok.length}, ${failed.size} failed`);
    else if (!quiet) toast(`${DONE[action]}${ok.length > 1 ? ` · ${ok.length}` : ""}`);
    return true;
  } catch (e) {
    sync("Offline", "var(--orange)");
    toast(`Couldn't do that: ${(e as Error).message}`);
    return false;
  }
}

// ---------- the reader ----------
function letter(html: string) {
  // The message runs in a sandbox with no scripts and its own origin; links open in a new tab.
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline' https:; font-src https: data:; media-src https: data:">
<base target="_blank"><style>body{margin:18px;font:15px/1.5 system-ui,sans-serif;color:#1d1d1d;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}pre{white-space:pre-wrap}blockquote{margin:0 0 0 .6em;padding-left:.8em;border-left:3px solid #ccc;color:#555}</style>
</head><body>${html}</body></html>`;
}

const wiredDocs = new WeakSet<Document>();
function wireFrameLinks(frame: HTMLIFrameElement) {
  const onLink = (ev: MouseEvent) => {
    if (ev.type === "auxclick" && ev.button !== 1) return;
    const a = (ev.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a) return;
    const raw = a.getAttribute("href")?.trim() || "";
    if (!raw || raw.startsWith("#")) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (/^mailto:/i.test(raw)) {
      const addr = decodeURIComponent(raw.replace(/^mailto:/i, "").split("?")[0] || "").trim();
      openCompose({ to: addr, account: state.open?.account });
      return;
    }
    if (/^https?:\/\//i.test(a.href)) {
      void platform.openUrl(a.href);
    }
  };
  const attach = () => {
    const doc = frame.contentDocument;
    if (!doc || wiredDocs.has(doc) || !doc.body) return;
    wiredDocs.add(doc);
    doc.addEventListener("click", onLink, true);
    doc.addEventListener("auxclick", onLink, true);
  };
  frame.addEventListener("load", attach);
  requestAnimationFrame(attach);
  window.setTimeout(attach, 60);
}

// Each letter gets a new frame, built before it goes into the page. Loading a second document into
// the same sandboxed frame left it blank in Chrome and Brave: the mail arrived but never painted.
function showLetter(html: string | null) {
  const frame = document.createElement("iframe");
  frame.id = "r-body";
  frame.title = "Message";
  frame.setAttribute("sandbox", platform.inApp
    ? "allow-same-origin allow-popups allow-popups-to-escape-sandbox"
    : "allow-popups allow-popups-to-escape-sandbox");
  frame.referrerPolicy = "no-referrer";
  if (html !== null) frame.srcdoc = letter(html);
  $("r-body").replaceWith(frame);
  if (platform.inApp && html !== null) wireFrameLinks(frame);
}

function syncReaderStar() {
  const on = Boolean(state.open?.flagged);
  const star = $("r-star");
  star.textContent = on ? "\uf005" : "\uf006";
  star.classList.toggle("on", on);
  star.title = on ? "Remove from Important" : "Set as Important";
  const btn = $("r-important");
  btn.classList.toggle("on", on);
  $("r-important-label").textContent = on ? " Important" : " Set as Important";
}

// Attached pictures (a form's signature.png, a photo) show under the chips. The server sends files as
// octet-stream behind the session, so the picture is fetched here and shown as a data: URL (the page CSP
// allows data:, not blob:). Clicking it saves the file, same as its chip.
const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const IMAGE_TYPE: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };
async function preview(m: Mail, url: string, name: string, chip: HTMLAnchorElement) {
  try {
    const r = await fetch(url, { headers: reqHeaders(), credentials: platform.inApp ? "omit" : "same-origin" });
    if (!r.ok) return;
    const type = IMAGE_TYPE[name.split(".").pop()!.toLowerCase()];
    const blob = new Blob([await r.arrayBuffer()], { type });
    const src = await new Promise<string>((done, fail) => {
      const fr = new FileReader();
      fr.onload = () => done(String(fr.result));
      fr.onerror = () => fail(fr.error);
      fr.readAsDataURL(blob);
    });
    if (state.open !== m) return;
    const img = document.createElement("img");
    img.src = src;
    img.alt = name;
    const box = el("a", null);
    box.title = `${name} · click to save`;
    box.append(img);
    box.onclick = (ev) => { ev.preventDefault(); chip.click(); };
    $("r-previews").append(box);
  } catch {
    // No preview; the chip still downloads it.
  }
}

const messageUrl = (m: Mail) => `api/message?${qs({ account: m.account, folder: m.folderId, id: m.id })}`;
async function openMessage(m: Mail) {
  closeContextMenu();
  state.open = m;
  $("listview").hidden = true;
  $("reader").hidden = false;
  $("r-subject").textContent = m.subject || "(no subject)";
  $("r-from").textContent = m.from;
  $("r-addr").textContent = m.fromAddress && m.fromAddress !== m.from ? `<${m.fromAddress}>` : "";
  $("r-to").textContent = m.to ? `To ${m.to}` : "";
  $("r-when").textContent = new Date(m.time).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
  const acct = accountOf(m.account);
  $("r-account").replaceChildren(...(acct && state.accounts.length > 1 ? [dot(acct.id), document.createTextNode(`In ${acct.email}`)] : []));
  $("r-files").replaceChildren();
  $("r-previews").replaceChildren();
  syncReaderStar();
  const spam = typeOf(m) === "Spam";
  $("r-spam").hidden = spam;
  $("r-notspam").hidden = !spam;
  showLetter('<p style="color:#888">Loading…</p>');
  try {
    const body = await api<Message>(messageUrl(m));
    if (state.open !== m) return;
    m.body = body;
    if (body.cc) $("r-to").textContent = `To ${body.to}  ·  Cc ${body.cc}`;
    showLetter(body.html || '<p style="color:#888">(This message has no text.)</p>');
    $("r-files").replaceChildren(...body.attachments.map((a) => {
      const link = el("a", "m-chip file", `\uf0c6 ${a.name} · ${size(a.size)}`);
      const url = platform.apiUrl(`api/attachment?${qs({ account: m.account, folder: m.folderId, id: m.id, att: a.id, name: a.name })}`);
      link.href = url;
      link.setAttribute("download", a.name);
      if (platform.inApp) {
        link.onclick = async (ev) => {
          ev.preventDefault();
          toast(`Saving ${a.name}…`);
          try {
            const saved = await platform.saveAttachment(url, a.name);
            toast(`Saved ${saved} to Downloads`);
          } catch (err) {
            toast(`Couldn't save ${a.name}: ${(err as Error).message}`);
          }
        };
      }
      if (IMAGE.test(a.name) && a.size <= 10 * 1024 * 1024) void preview(m, url, a.name, link);
      return link;
    }));
    // Opening a message marks it read.
    if (m.unread) {
      m.unread = false;
      post("api/actions", { action: "read", items: [{ account: m.account, id: m.id, folder: m.folderId }] })
        .then(() => bump("unread", [m], -1), () => { m.unread = true; toast("Couldn't mark it read"); });
    }
  } catch (e) {
    if (state.open === m) showLetter(`<p style="color:#b14242">Couldn't open this message: ${String((e as Error).message).replace(/[<&]/g, "")}</p>`);
  }
}
function closeReader() {
  state.open = null;
  $("reader").hidden = true;
  $("listview").hidden = false;
  showLetter(null);
  renderList();
}
$("back").onclick = closeReader;
async function readerAct(action: Act) {
  const m = state.open;
  if (m && (await act(action, [m]))) closeReader();
}
async function toggleReaderImportant() {
  const m = state.open;
  if (!m) return;
  await act(m.flagged ? "unimportant" : "important", [m]);
}
$("r-star").onclick = toggleReaderImportant;
$("r-important").onclick = toggleReaderImportant;
$("r-unread").onclick = () => readerAct("unread");
$("r-spam").onclick = () => readerAct("spam");
$("r-notspam").onclick = () => readerAct("notspam");
$("r-delete").onclick = () => readerAct("delete");

async function ensureBody(m: Mail): Promise<Message | null> {
  if (m.body) return m.body;
  try {
    m.body = await api<Message>(messageUrl(m));
    return m.body;
  } catch {
    return null;
  }
}
function htmlToText(html: string): string {
  return new DOMParser().parseFromString(html, "text/html").body.innerText.trim();
}
async function replyMessage(m: Mail) {
  const body = await ensureBody(m);
  const quoted = body ? htmlToText(body.html) : m.summary;
  const head = `On ${new Date(m.time).toLocaleString()}, ${m.from}${m.fromAddress ? ` <${m.fromAddress}>` : ""} wrote:`;
  openCompose({
    to: m.fromAddress,
    subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
    text: `\n\n${head}\n${quoted.split("\n").map((l) => `> ${l}`).join("\n")}`,
    replyTo: m.id,
    account: m.account,
  });
}
async function forwardMessage(m: Mail) {
  const body = await ensureBody(m);
  const plainText = body ? htmlToText(body.html) : m.summary;
  const lines = [
    "---------- Forwarded message ----------",
    `From: ${m.from}${m.fromAddress && m.fromAddress !== m.from ? ` <${m.fromAddress}>` : ""}`,
    `Date: ${new Date(m.time).toLocaleString()}`,
    `Subject: ${m.subject || "(no subject)"}`,
    ...(body?.to || m.to ? [`To: ${body?.to || m.to}`] : []),
  ];
  openCompose({
    to: "",
    subject: /^fwd?:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`,
    text: `\n\n${lines.join("\n")}\n\n${plainText}`,
    modeTitle: "Forward",
    account: m.account,
  });
}
$("r-reply").onclick = () => { if (state.open) void replyMessage(state.open); };
$("r-forward").onclick = () => { if (state.open) void forwardMessage(state.open); };

// ---------- compose ----------
// An attachment goes up to the mailbox it is sent from; picking another From sends it up again there.
type Pending = { file: File; name: string; size: number; account: string; ref?: Upload; error?: string; uploading: Promise<void> };
let draft: { replyTo?: string; forwarded?: boolean; files: Pending[] } = { files: [] };
const fromAccount = () => $<HTMLSelectElement>("c-from").value;

function openCompose(p: { to?: string; subject?: string; text?: string; replyTo?: string; modeTitle?: string; account?: string } = {}) {
  if (!state.accounts.length) { toast("Add a Zoho account in Settings first"); return; }
  draft = { files: [], ...(p.replyTo ? { replyTo: p.replyTo } : {}), ...(p.modeTitle === "Forward" ? { forwarded: true } : {}) };
  $("c-title").textContent = p.modeTitle ?? (p.replyTo ? "Reply" : "New message");
  const from = $<HTMLSelectElement>("c-from");
  from.replaceChildren(...state.accounts.map((a) => { const o = el("option", null, a.email); o.value = a.id; return o; }));
  from.value = p.account ?? (state.account !== ALL ? state.account : state.accounts[0]!.id);
  // A reply goes out from the mailbox it came to.
  from.disabled = Boolean(p.replyTo);
  $("c-fromline").hidden = state.accounts.length < 2;
  $<HTMLInputElement>("c-to").value = p.to ?? "";
  $<HTMLInputElement>("c-cc").value = $<HTMLInputElement>("c-bcc").value = "";
  $("c-ccline").hidden = $("c-bccline").hidden = true;
  $<HTMLInputElement>("c-subject").value = p.subject ?? "";
  const t = $<HTMLTextAreaElement>("c-text");
  t.value = p.text ?? "";
  $("c-error").hidden = true;
  renderFiles();
  $("composer").hidden = false;
  if (p.to) { t.focus(); t.setSelectionRange(0, 0); t.scrollTop = 0; } else $("c-to").focus();
}
function dirty() {
  return Boolean($<HTMLInputElement>("c-to").value.trim() || draft.files.length ||
    ($<HTMLInputElement>("c-subject").value.trim() && !draft.replyTo && !draft.forwarded) ||
    ($<HTMLTextAreaElement>("c-text").value.trim() && !draft.replyTo && !draft.forwarded));
}
function closeCompose(force = false) {
  if (!force && dirty() && !confirm("Discard this message?")) return;
  $("composer").hidden = true;
}
$("compose").onclick = () => openCompose();
$("c-close").onclick = () => closeCompose();
$("composer").onclick = (e) => { if (e.target === $("composer")) closeCompose(); };
$("c-ccbtn").onclick = () => { $("c-ccline").hidden = $("c-bccline").hidden = false; $("c-cc").focus(); };
$("c-from").onchange = () => {
  for (const f of draft.files) if (!f.error?.startsWith("over") && f.account !== fromAccount()) upload(f);
  renderFiles();
};

function renderFiles() {
  $("c-files").replaceChildren(...draft.files.map((f) => {
    const chip = el("span", "m-chip file" + (f.error ? " bad" : ""), `\uf0c6 ${f.name} · ${f.error ?? (f.ref ? size(f.size) : "uploading…")}`);
    const x = el("button", "x", "\uf00d");
    x.type = "button";
    x.title = "Remove";
    x.onclick = () => { draft.files = draft.files.filter((g) => g !== f); renderFiles(); };
    chip.append(x);
    return chip;
  }));
}
function upload(p: Pending) {
  const account = (p.account = fromAccount());
  delete p.ref;
  delete p.error;
  p.uploading = fetch(platform.apiUrl(`api/upload?${qs({ account, name: p.name })}`), {
    method: "POST",
    body: p.file,
    headers: reqHeaders({ "x-letterbox": "1" }),
    credentials: platform.inApp ? "omit" : "same-origin",
  })
    .then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      if (p.account === account) p.ref = j as Upload;   // From changed while it went up: the newer upload wins
    })
    .catch((e) => { if (p.account === account) p.error = `failed: ${(e as Error).message}`; })
    .finally(renderFiles);
}
function addFiles(files: Iterable<File>) {
  for (const file of files) {
    const p: Pending = { file, name: file.name, size: file.size, account: fromAccount(), uploading: Promise.resolve() };
    if (file.size > MAX_FILE) p.error = "over 20 MB";
    else upload(p);
    draft.files.push(p);
  }
  renderFiles();
}
$("c-attach").onclick = () => $("c-file").click();
$<HTMLInputElement>("c-file").onchange = (e) => {
  const input = e.target as HTMLInputElement;
  if (input.files) addFiles(input.files);
  input.value = "";
};
const form = $("compose-form");
form.ondragover = (e) => { e.preventDefault(); form.classList.add("dropping"); };
form.ondragleave = () => form.classList.remove("dropping");
form.ondrop = (e) => {
  e.preventDefault();
  form.classList.remove("dropping");
  if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
};

form.onsubmit = async (e) => {
  e.preventDefault();
  const err = $("c-error");
  err.hidden = true;
  const to = $<HTMLInputElement>("c-to").value.trim();
  if (!to) { err.textContent = "Who is it to?"; err.hidden = false; return $("c-to").focus(); }
  const btn = $<HTMLButtonElement>("c-send");
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    // An upload that started before a From change ends with the newer one, so wait until they settle.
    while (draft.files.some((f) => !f.ref && !f.error)) await Promise.all(draft.files.map((f) => f.uploading));
    const bad = draft.files.find((f) => f.error);
    if (bad) throw new Error(`${bad.name}: ${bad.error}. Remove it or attach it again.`);
    const subject = $<HTMLInputElement>("c-subject").value.trim();
    if (!subject && !confirm("Send without a subject?")) return;
    await post("api/send", {
      account: fromAccount(),
      to, cc: $<HTMLInputElement>("c-cc").value, bcc: $<HTMLInputElement>("c-bcc").value, subject,
      text: $<HTMLTextAreaElement>("c-text").value, attachments: draft.files.map((f) => f.ref), replyTo: draft.replyTo,
    });
    closeCompose(true);
    toast("Sent");
    if (state.current.type === "Sent") load(true, true);
  } catch (x) {
    err.textContent = `Not sent: ${(x as Error).message}`;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "\uf1d8 Send";
  }
};

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("ctx").hidden) closeContextMenu();
  else if (!$("composer").hidden) closeCompose();
  else if (!$("settings").hidden) closeSettings();
  else if (!$("reader").hidden) closeReader();
  else if (state.selected.size) { state.selected.clear(); renderList(); }
  else if (state.current === SEARCH) clearSearch();
});

// ---------- start ----------
/** The mail, or the welcome that asks for a first mailbox. */
function showMain() {
  const none = !state.accounts.length;
  $("welcome").hidden = !none;
  $("listview").hidden = none;
  if (none) { $("reader").hidden = true; renderFolders(); sync("No mailboxes yet", "var(--faint)"); }
}
async function start() {
  if (platform.inApp && !platform.getSession()) {
    const saved = await platform.initSession();
    if (!saved) return showGate();
  }
  try {
    await loadAccounts();
    $("gate").hidden = true;
    $("app").hidden = false;
    platform.requestNotifications();
    showMain();
    // Back from Zoho's sign-in on the web: say what came in, and drop it from the address.
    const added = new URLSearchParams(location.search).get("added");
    if (added) {
      toast(`Added ${added}`);
      history.replaceState(null, "", location.pathname);
    }
    if (!state.accounts.length) return;
    openFolder(inboxFolder());
    countUnread();
    countImportant();
  } catch (e) {
    const err = e as HttpError;
    if (err.status === 401) return;
    if (err.status === 403) return showGate(err.message);
    $("app").hidden = false;
    sync("Offline", "var(--orange)");
    $("list").replaceChildren(el("div", "error", `Couldn't reach the mailbox: ${err.message}`));
  }
}
start();
