// Letterbox in the browser: folders, the message list with multi-select, the reader, and compose with
// attachments. Talks to its own server (server/server.ts) with relative URLs, so it works at any prefix.
import type { Folder, Summary, Message, Upload } from "../server/zoho.ts";

const PAGE = 50;
const AUTO_REFRESH_MS = 90_000;
const MAX_FILE = 20 * 1024 * 1024;
const ICONS: Record<string, string> = {
  Inbox: "", Drafts: "", Templates: "", Snoozed: "", Sent: "",
  Spam: "", Trash: "", Outbox: "", Archive: "",
};
// Not a Zoho folder: unread mail from every folder except Spam and Trash.
const UNREAD: Folder = { id: "unread", name: "Unread", type: "Unread", path: "" };
const SENT_LIKE = new Set(["Sent", "Drafts", "Outbox", "Templates"]);

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, text?: string | null): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const state = {
  folders: [] as Folder[],
  current: UNREAD,
  messages: [] as Summary[],
  loading: false,
  done: false,
  seq: 0,
  unread: null as string | null,
  selected: new Set<string>(),
  anchor: -1,                      // the last row clicked, for shift-click ranges
  open: null as (Summary & { body?: Message }) | null,
};

// ---------- server ----------
class HttpError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== "GET") headers.set("x-letterbox", "1");
  if (typeof init.body === "string") headers.set("content-type", "application/json");
  let r: Response;
  try { r = await fetch(path, { ...init, headers, credentials: "same-origin" }); } catch { throw new HttpError("Can't reach the server", 0); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { showGate(); throw new HttpError("Sign in", 401); }
  if (!r.ok) throw new HttpError(j.error || `HTTP ${r.status}`, r.status);
  return j as T;
}
const post = <T = any>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) });

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
const folderOf = (id: string) => state.folders.find((f) => f.id === id);
const typeOf = (id: string) => folderOf(id)?.type ?? "";
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

// ---------- sign-in ----------
function showGate(message?: string) {
  $("app").hidden = true;
  $("composer").hidden = true;
  $("gate").hidden = false;
  const err = $("gate-error");
  err.hidden = !message;
  err.textContent = message ?? "";
  $<HTMLInputElement>("em").focus();
}
$("gate").onsubmit = async (e) => {
  e.preventDefault();
  const btn = $<HTMLButtonElement>("signin");
  btn.disabled = true;
  $("gate-error").hidden = true;
  try {
    await post("auth/login", { email: $<HTMLInputElement>("em").value.trim(), password: $<HTMLInputElement>("pw").value });
    $<HTMLInputElement>("pw").value = "";
    $("gate").hidden = true;
    await start();
  } catch (err) {
    $("gate-error").textContent = (err as Error).message;
    $("gate-error").hidden = false;
  } finally { btn.disabled = false; }
};
$("signout").onclick = async () => {
  await post("auth/logout", {}).catch(() => {});
  location.reload();
};

// ---------- folders ----------
function navRow(f: Folder, icon: string, sub = false) {
  const row = el("div", "m-nav" + (sub ? " sub" : "") + (f.id === state.current.id ? " current" : ""));
  row.append(el("span", "ico", icon), el("span", "name", f.name));
  row.onclick = () => openFolder(f);
  return row;
}
function renderFolders() {
  const nav = $("folders");
  const unread = navRow(UNREAD, "");
  if (state.unread) unread.append(el("span", "badge", state.unread));
  nav.replaceChildren(unread, el("div", "nav-sep"));
  for (const f of state.folders) {
    const sub = (f.path || "").split("/").filter(Boolean).length > 1;   // /Inbox/Receipts is a sub folder
    nav.append(navRow(f, sub ? "" : ICONS[f.type] ?? "", sub));
  }
}
// One page of up to 200 is plenty for a count; past that the badge says 200+.
async function countUnread() {
  try {
    const page = await api<Summary[]>("api/messages?folder=unread&limit=200");
    state.unread = page.length ? (page.length === 200 ? "200+" : String(page.length)) : null;
    renderFolders();
  } catch { /* the badge stays as it was */ }
}
function bumpUnread(delta: number) {
  if (state.unread === null && delta < 0) return;
  if (state.unread?.endsWith("+")) return;
  const n = Math.max(0, Number(state.unread ?? 0) + delta);
  state.unread = n ? String(n) : null;
  renderFolders();
}

function openFolder(f: Folder) {
  state.current = f;
  state.selected.clear();
  $("title").textContent = f.name.toUpperCase();
  closeReader();
  renderFolders();
  load(true);
}

// ---------- the list ----------
function renderList() {
  const list = $("list");
  list.replaceChildren();
  if (!state.messages.length) {
    const none = state.current === UNREAD ? "You're all caught up." : "Nothing in this folder.";
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

function row(m: Summary, index: number) {
  const r = el("div", "mail" + (m.unread ? " unread" : "") + (state.selected.has(m.id) ? " selected" : ""));
  r.title = `${m.fromAddress}\n${new Date(m.time).toLocaleString()}`;
  const box = el("label", "check");
  const cb = el("input");
  cb.type = "checkbox";
  cb.checked = state.selected.has(m.id);
  box.append(cb, el("span"));
  box.onclick = (e) => e.stopPropagation();
  cb.onclick = (e) => {
    // Shift-click selects (or clears) everything between the last clicked row and this one.
    if (e.shiftKey && state.anchor >= 0) {
      const [a, b] = [Math.min(state.anchor, index), Math.max(state.anchor, index)];
      for (const x of state.messages.slice(a, b + 1)) cb.checked ? state.selected.add(x.id) : state.selected.delete(x.id);
    } else cb.checked ? state.selected.add(m.id) : state.selected.delete(m.id);
    state.anchor = index;
    renderList();
  };

  const who = SENT_LIKE.has(typeOf(m.folderId)) && m.to ? m.to.replace(/<[^>]*>/g, "").trim() || m.to : m.from;
  const text = el("div", "text");
  const subject = el("span", "subject", m.subject || "(no subject)");
  const summary = el("span", "summary", m.summary ? "  " + m.summary : "");
  subject.dir = summary.dir = "auto";
  text.append(subject, summary);
  const info = el("div", "side-info");
  if (state.current === UNREAD) {
    const f = folderOf(m.folderId);
    if (f) info.append(el("span", "m-chip", f.name));
  }
  if (m.threadCount > 1) info.append(el("span", "count", `(${m.threadCount})`));
  if (m.flagged) info.append(el("span", "flag", ""));
  if (m.attachment) info.append(el("span", null, ""));
  info.append(el("span", null, when(m.time)));
  const from = el("span", "from", who);
  from.dir = "auto";
  r.append(box, el("span", "dot"), from, text, info);
  r.onclick = () => openMessage(m);
  return r;
}

function renderBulk() {
  const n = state.selected.size;
  $("bulk").hidden = n === 0;
  $("count").textContent = `${n} selected`;
  const all = $<HTMLInputElement>("all");
  all.checked = n > 0 && state.messages.every((m) => state.selected.has(m.id));
  all.indeterminate = n > 0 && !all.checked;
  const t = state.current.type;
  const inSpam = t === "Spam";
  ($("bulk").querySelector('[data-act="spam"]') as HTMLElement).hidden = inSpam;
  ($("bulk").querySelector('[data-act="notspam"]') as HTMLElement).hidden = !inSpam;
  $("delete-label").textContent = t === "Trash" || inSpam ? " Delete forever" : " Delete";
}
$<HTMLInputElement>("all").onchange = (e) => {
  const on = (e.target as HTMLInputElement).checked;
  state.selected.clear();
  if (on) for (const m of state.messages) state.selected.add(m.id);
  renderList();
};
$("clear").onclick = () => { state.selected.clear(); renderList(); };
for (const b of $("bulk").querySelectorAll<HTMLButtonElement>("[data-act]")) {
  b.onclick = () => act(b.dataset.act as Act, state.messages.filter((m) => state.selected.has(m.id)));
}

async function load(reset: boolean, quiet = false) {
  if (!reset && (state.loading || state.done)) return;
  const seq = ++state.seq;                       // a newer load (folder switch, refresh) makes this one stale
  state.loading = true;
  if (reset && !quiet) { state.messages = []; state.done = false; $("more").hidden = true; renderList(); }
  sync("Syncing", "var(--faint)");
  try {
    const startAt = reset ? 1 : state.messages.length + 1;
    const page = await api<Summary[]>(`api/messages?folder=${state.current.id}&start=${startAt}&limit=${PAGE}`);
    if (seq !== state.seq) return;
    state.messages = reset ? page : state.messages.concat(page);
    state.done = page.length < PAGE;
    // Rows that left the folder can't stay selected.
    const here = new Set(state.messages.map((m) => m.id));
    for (const id of state.selected) if (!here.has(id)) state.selected.delete(id);
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
$("refresh").onclick = () => { load(true); countUnread(); };
$("more").onclick = () => load(false);

// New mail shows up by itself while the first page is on screen and nothing is selected.
setInterval(() => {
  if (document.hidden || $("app").hidden || !$("reader").hidden || state.selected.size || state.loading) return;
  if (state.messages.length > PAGE || $("list").scrollTop > 40) return;
  load(true, true);
  countUnread();
}, AUTO_REFRESH_MS);

// ---------- actions ----------
type Act = "read" | "unread" | "spam" | "notspam" | "delete";
const DONE: Record<Act, string> = { read: "Marked read", unread: "Marked unread", spam: "Moved to Spam", notspam: "Moved to Inbox", delete: "Deleted" };

async function act(action: Act, list: Summary[]) {
  if (!list.length) return;
  const forever = action === "delete" && ["Trash", "Spam"].includes(state.current.type === "Unread" ? typeOf(list[0]!.folderId) : state.current.type);
  if (forever && !confirm(`Delete ${list.length === 1 ? "this message" : `${list.length} messages`} for good? This can't be undone.`)) return;
  sync("Working", "var(--faint)");
  try {
    const r = await post<{ done: number; failed?: string[] }>("api/actions", { action, items: list.map((m) => ({ id: m.id, folder: m.folderId })) });
    const failed = new Set(r.failed ?? []);
    const ok = list.filter((m) => !failed.has(m.id));
    if (action === "read" || action === "unread") {
      const unread = action === "unread";
      bumpUnread(ok.filter((m) => m.unread !== unread).length * (unread ? 1 : -1));
      for (const m of ok) m.unread = unread;
    } else {
      // Spam, not spam and delete take the mail out of this folder.
      bumpUnread(-ok.filter((m) => m.unread).length);
      const gone = new Set(ok.map((m) => m.id));
      state.messages = state.messages.filter((m) => !gone.has(m.id));
    }
    for (const m of ok) state.selected.delete(m.id);
    renderList();
    synced();
    toast(failed.size ? `${DONE[action]}: ${ok.length}, ${failed.size} failed` : `${DONE[action]}${ok.length > 1 ? ` · ${ok.length}` : ""}`);
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

async function openMessage(m: Summary & { body?: Message }) {
  state.open = m;
  $("listview").hidden = true;
  $("reader").hidden = false;
  $("r-subject").textContent = m.subject || "(no subject)";
  $("r-from").textContent = m.from;
  $("r-addr").textContent = m.fromAddress && m.fromAddress !== m.from ? `<${m.fromAddress}>` : "";
  $("r-to").textContent = m.to ? `To ${m.to}` : "";
  $("r-when").textContent = new Date(m.time).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
  $("r-files").replaceChildren();
  const spam = typeOf(m.folderId) === "Spam";
  $("r-spam").hidden = spam;
  $("r-notspam").hidden = !spam;
  const frame = $<HTMLIFrameElement>("r-body");
  frame.srcdoc = letter('<p style="color:#888">Loading…</p>');
  try {
    const body = await api<Message>(`api/message?folder=${m.folderId}&id=${m.id}`);
    if (state.open !== m) return;
    m.body = body;
    if (body.cc) $("r-to").textContent = `To ${body.to}  ·  Cc ${body.cc}`;
    frame.srcdoc = letter(body.html || '<p style="color:#888">(This message has no text.)</p>');
    $("r-files").replaceChildren(...body.attachments.map((a) => {
      const link = el("a", "m-chip file", ` ${a.name} · ${size(a.size)}`);
      link.href = `api/attachment?${new URLSearchParams({ folder: m.folderId, id: m.id, att: a.id, name: a.name })}`;
      link.setAttribute("download", a.name);
      return link;
    }));
    // Opening a message marks it read.
    if (m.unread) {
      m.unread = false;
      post("api/actions", { action: "read", items: [{ id: m.id, folder: m.folderId }] })
        .then(() => bumpUnread(-1), () => { m.unread = true; toast("Couldn't mark it read"); });
    }
  } catch (e) {
    if (state.open === m) frame.srcdoc = letter(`<p style="color:#b14242">Couldn't open this message: ${String((e as Error).message).replace(/[<&]/g, "")}</p>`);
  }
}
function closeReader() {
  state.open = null;
  $("reader").hidden = true;
  $("listview").hidden = false;
  $<HTMLIFrameElement>("r-body").srcdoc = "";
  renderList();
}
$("back").onclick = closeReader;
async function readerAct(action: Act) {
  const m = state.open;
  if (m && (await act(action, [m]))) closeReader();
}
$("r-unread").onclick = () => readerAct("unread");
$("r-spam").onclick = () => readerAct("spam");
$("r-notspam").onclick = () => readerAct("notspam");
$("r-delete").onclick = () => readerAct("delete");
$("r-reply").onclick = () => {
  const m = state.open;
  if (!m) return;
  const quoted = m.body ? new DOMParser().parseFromString(m.body.html, "text/html").body.innerText.trim() : m.summary;
  const head = `On ${new Date(m.time).toLocaleString()}, ${m.from}${m.fromAddress ? ` <${m.fromAddress}>` : ""} wrote:`;
  openCompose({
    to: m.fromAddress,
    subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
    text: `\n\n${head}\n${quoted.split("\n").map((l) => `> ${l}`).join("\n")}`,
    replyTo: m.id,
  });
};

// ---------- compose ----------
type Pending = { name: string; size: number; ref?: Upload; error?: string; uploading: Promise<void> };
let draft: { replyTo?: string; files: Pending[] } = { files: [] };

function openCompose(p: { to?: string; subject?: string; text?: string; replyTo?: string } = {}) {
  draft = { files: [], ...(p.replyTo ? { replyTo: p.replyTo } : {}) };
  $("c-title").textContent = p.replyTo ? "Reply" : "New message";
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
  return Boolean($<HTMLInputElement>("c-to").value.trim() || $<HTMLInputElement>("c-subject").value.trim() || draft.files.length ||
    ($<HTMLTextAreaElement>("c-text").value.trim() && !draft.replyTo));
}
function closeCompose(force = false) {
  if (!force && dirty() && !confirm("Discard this message?")) return;
  $("composer").hidden = true;
}
$("compose").onclick = () => openCompose();
$("c-close").onclick = () => closeCompose();
$("composer").onclick = (e) => { if (e.target === $("composer")) closeCompose(); };
$("c-ccbtn").onclick = () => { $("c-ccline").hidden = $("c-bccline").hidden = false; $("c-cc").focus(); };

function renderFiles() {
  $("c-files").replaceChildren(...draft.files.map((f) => {
    const chip = el("span", "m-chip file" + (f.error ? " bad" : ""), ` ${f.name} · ${f.error ?? (f.ref ? size(f.size) : "uploading…")}`);
    const x = el("button", "x", "");
    x.type = "button";
    x.title = "Remove";
    x.onclick = () => { draft.files = draft.files.filter((g) => g !== f); renderFiles(); };
    chip.append(x);
    return chip;
  }));
}
function addFiles(files: Iterable<File>) {
  for (const file of files) {
    const p: Pending = { name: file.name, size: file.size, uploading: Promise.resolve() };
    if (file.size > MAX_FILE) p.error = "over 20 MB";
    else {
      p.uploading = fetch(`api/upload?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file, headers: { "x-letterbox": "1" }, credentials: "same-origin" })
        .then(async (r) => {
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
          p.ref = j as Upload;
        })
        .catch((e) => { p.error = `failed: ${(e as Error).message}`; })
        .finally(renderFiles);
    }
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
    await Promise.all(draft.files.map((f) => f.uploading));
    const bad = draft.files.find((f) => f.error);
    if (bad) throw new Error(`${bad.name}: ${bad.error}. Remove it or attach it again.`);
    const subject = $<HTMLInputElement>("c-subject").value.trim();
    if (!subject && !confirm("Send without a subject?")) return;
    await post("api/send", {
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
    btn.textContent = " Send";
  }
};

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("composer").hidden) closeCompose();
  else if (!$("reader").hidden) closeReader();
  else if (state.selected.size) { state.selected.clear(); renderList(); }
});

// ---------- start ----------
async function start() {
  try {
    const me = await api<{ email: string; mailbox: string }>("api/me");
    $("app").hidden = false;
    $("email").textContent = me.mailbox;
    state.folders = await api<Folder[]>("api/folders");
    openFolder(state.folders.find((f) => f.type === "Inbox") ?? state.folders[0] ?? UNREAD);
    countUnread();
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
