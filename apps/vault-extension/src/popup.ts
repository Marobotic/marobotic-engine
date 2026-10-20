/// <reference types="chrome" />
// The toolbar popup: sign in, then everything in Vault (or just what belongs to the open page), each
// item's details, new and edited logins, and the extension's own settings.
import { entryIcon } from "../../vault/ui/widgets.ts";
import { send, type CodeInput, type Detail, type LoginInput, type Settings, type State, type Summary } from "./messages.ts";

const app = document.getElementById("app")!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function h<T extends HTMLElement = HTMLElement>(html: string): T { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild as T; }
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = app) => root.querySelector(sel) as T;
const group = (code: string) => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code);

let toastTimer = 0;
function toast(text: string) {
  const t = document.getElementById("toast")!;
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 1600);
}
async function copy(text: string, what: string, clearAfter = 0) {
  await navigator.clipboard.writeText(text);
  toast(`${what} copied`);
  if (clearAfter) setTimeout(() => void navigator.clipboard.readText().then((t) => { if (t === text) return navigator.clipboard.writeText(""); }).catch(() => {}), clearAfter);
}

let st: State;
let view: { tab: "site" | "all"; kind: "all" | Summary["kind"]; q: string } = { tab: "site", kind: "all", q: "" };
try { view = { ...view, ...JSON.parse(localStorage.getItem("view") ?? "{}"), q: "" }; } catch { /* first run */ }
const keepView = () => { try { localStorage.setItem("view", JSON.stringify({ tab: view.tab, kind: view.kind })); } catch { /* fine */ } };
let ticker = 0;

async function start() {
  st = await send<State>({ t: "state" });
  if (st.state !== "open") return signInScreen();
  void listScreen();
}

// ------------------------------------------------------------------ sign in
function signInScreen(error = "") {
  clearInterval(ticker);
  const locked = st.state === "locked";
  app.replaceChildren(h(`
    <form class="gate">
      <div class="logo">&#xf023;</div>
      <h1>${locked ? "Unlock Vault" : "Sign in to Vault"}</h1>
      <p>${locked ? `Your vault (${esc(st.email ?? "")}) is locked.` : "Your marobotic account, the same one as the Vault app. Your vault opens here in the browser; the server only ever has the sealed copy."}</p>
      <input id="em" type="email" placeholder="Email" autocomplete="username" required value="${esc(st.email ?? "")}" ${locked ? "hidden" : ""}>
      <input id="pw" type="password" placeholder="Password" autocomplete="current-password" required>
      <div class="err">${esc(error)}</div>
      <button class="primary" type="submit">${locked ? "Unlock" : "Sign in"}</button>
      ${locked ? `<button type="button" id="other">Use another account</button>` : ""}
    </form>`));
  $<HTMLInputElement>(locked || st.email ? "#pw" : "#em").focus();
  $("#other")?.addEventListener("click", async () => { await send({ t: "signOut" }); void start(); });
  $<HTMLFormElement>("form").onsubmit = async (e) => {
    e.preventDefault();
    const b = $<HTMLButtonElement>("button[type=submit]");
    b.disabled = true; b.textContent = "Opening…";
    const r = await send<{ ok?: boolean; error?: string }>({ t: "signIn", email: $<HTMLInputElement>("#em").value, password: $<HTMLInputElement>("#pw").value });
    if (r.ok) return void start();
    signInScreen(r.error ?? "Couldn't sign in.");
  };
}

// ------------------------------------------------------------------ the lists
function foot(): HTMLElement {
  const color = st.synced === "synced" ? "var(--teal)" : "var(--orange)";
  const label = st.synced === "synced" ? "Synced" : st.synced === "signedOut" ? "Sign in again to sync" : "Offline";
  const f = h(`<div class="foot"><span class="dot" style="--st:${color}">●</span><span class="who">${esc(st.email ?? "")} · ${label}</span>
    <button class="icon" id="lock" title="Lock">&#xf023;</button></div>`);
  $("#lock", f).onclick = async () => { await send({ t: "lock" }); void start(); };
  return f;
}

async function listScreen() {
  clearInterval(ticker);
  const kinds = { all: "All", login: "Logins", totp: "2FA", passkey: "Passkeys" } as const;
  app.replaceChildren(
    h(`<div class="top">
      <span class="logo">&#xf023;</span>
      <input id="q" placeholder="Search Vault" value="${esc(view.q)}" autocomplete="off">
      <button class="icon" id="new" title="New login">&#xf067;</button>
      <button class="icon" id="settings" title="Settings">&#xf013;</button>
    </div>`),
    h(`<div class="tabs"><button data-tab="site"><span id="siteName">This site</span></button><button data-tab="all">All items</button></div>`),
    h(`<div class="chips" ${view.tab === "all" ? "" : "hidden"}>${(Object.keys(kinds) as (keyof typeof kinds)[]).map((k) => `<button data-kind="${k}" class="${view.kind === k ? "on" : ""}">${kinds[k]}</button>`).join("")}</div>`),
    h(`<div class="scroll" id="list"></div>`), foot());
  app.querySelectorAll<HTMLElement>("[data-tab]").forEach((b) => {
    b.classList.toggle("on", b.dataset.tab === view.tab);
    b.onclick = () => { view.tab = b.dataset.tab as "site" | "all"; keepView(); void listScreen(); };
  });
  app.querySelectorAll<HTMLElement>("[data-kind]").forEach((b) => (b.onclick = () => { view.kind = b.dataset.kind as typeof view.kind; keepView(); void listScreen(); }));
  const q = $<HTMLInputElement>("#q");
  let t = 0;
  q.oninput = () => { view.q = q.value; clearTimeout(t); t = window.setTimeout(() => void fill(), 120); };
  q.focus();
  $("#new").onclick = () => void editScreen(null);
  $("#settings").onclick = () => void settingsScreen();
  await fill();
}

async function fill() {
  const searching = view.q.trim().length > 0;
  const onSite = view.tab === "site" && !searching;
  const r = await send<{ items?: Summary[]; site?: string; locked?: boolean }>({ t: "list", q: view.q, site: onSite });
  if (r.locked) { st.state = "locked"; return signInScreen(); }
  if (r.site) $("#siteName").textContent = r.site;
  let items = r.items ?? [];
  if (view.tab === "all" && view.kind !== "all") items = items.filter((i) => i.kind === view.kind || (view.kind === "totp" && i.code));
  const list = $("#list");
  if (!list) return;
  if (!items.length) {
    list.replaceChildren(h(`<div class="msg">${searching ? "Nothing matches." : onSite ? `Nothing saved for ${esc(r.site || "this page")} yet.<br>Sign in there and Vault offers to save it.` : "Nothing here yet."}
      ${onSite && r.site ? `<button class="primary" id="add">&#xf067; New login for this site</button>` : ""}</div>`));
    $("#add")?.addEventListener("click", () => void editScreen(null));
    return;
  }
  const out: HTMLElement[] = [];
  for (const [k, label] of [["login", "Logins"], ["totp", "2FA codes"], ["passkey", "Passkeys"]] as const) {
    const of = items.filter((i) => (view.tab === "all" && view.kind === "totp" ? k === "totp" : i.kind === k));
    if (!of.length) continue;
    if (onSite || view.kind === "all") out.push(h(`<div class="group">${label}</div>`));
    for (const i of of) out.push(rowOf(i, onSite));
  }
  list.replaceChildren(...out);
  clearInterval(ticker);
  if (items.some((i) => i.kind === "totp")) ticker = window.setInterval(tick, 1000);
}

function rowOf(i: Summary, onSite: boolean): HTMLElement {
  const low = (i.remaining ?? 99) <= 5 ? "low" : "";
  const row = h(`<div class="row" title="${i.kind === "totp" ? "Copy the code" : "Details"}">
      <span class="tileslot"></span>
      <div class="txt"><b>${i.favorite ? `<span class="pin">&#xf08d;</span>` : ""}${esc(i.title)}</b><span>${esc(i.sub || " ")}</span></div>
      ${i.code ? `<span class="otp ${low}" data-otp title="Copy the code">${esc(group(i.code!))}</span><span class="ring ${low}" data-left="${i.remaining}" data-period="${i.period}" style="--p:${(i.remaining! / i.period!) * 100}"></span>` : ""}
      ${i.kind === "passkey" ? `<span class="kind passkey">PASSKEY</span>` : ""}
      ${i.kind === "login" && onSite ? `<button data-fill>Fill</button>` : ""}
      ${i.kind === "login" ? `<button class="icon" data-copy title="Copy password">&#xf0c5;</button>` : ""}
      ${i.kind === "totp" ? `<button class="icon" data-more title="Details and edit">&#xf054;</button>` : ""}
    </div>`);
  row.querySelector(".tileslot")!.replaceWith(entryIcon(i.title, i.site));
  row.onclick = (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    if (i.kind === "totp" || (e.target as HTMLElement).closest("[data-otp]")) return void copy(i.code!, "Code");
    void detailScreen(i.id);
  };
  row.querySelector<HTMLElement>("[data-more]")?.addEventListener("click", () => void detailScreen(i.id));
  row.querySelector<HTMLElement>("[data-fill]")?.addEventListener("click", async () => {
    const r = await send<{ ok?: boolean; error?: string }>({ t: "fillTab", id: i.id });
    r.ok ? window.close() : toast(r.error ?? "Couldn't fill");
  });
  row.querySelector<HTMLElement>("[data-copy]")?.addEventListener("click", async () => {
    const d = await send<Detail>({ t: "item", id: i.id });
    if (d.kind === "login") await copy(d.password, "Password", 30_000);
  });
  return row;
}

/** Codes count down every second; when one runs out, the list is fetched again. */
function tick() {
  let expired = false;
  app.querySelectorAll<HTMLElement>("[data-left]").forEach((r) => {
    const left = Number(r.dataset.left) - 1, period = Number(r.dataset.period);
    r.dataset.left = String(left);
    r.style.setProperty("--p", String((left / period) * 100));
    r.classList.toggle("low", left <= 5);
    r.previousElementSibling?.classList.toggle("low", left <= 5);
    if (left <= 0) expired = true;
  });
  if (expired) void fill();
}

// ------------------------------------------------------------------ one item
function field(label: string, value: string, opts: { secret?: boolean; copy?: string; html?: boolean } = {}) {
  const dots = "•".repeat(Math.min(16, value.length || 8));
  const f = h(`<div class="field"><div class="txt"><span>${esc(label)}</span><b class="${opts.secret ? "secret" : ""}">${opts.html ? value : esc(opts.secret ? dots : value)}</b></div>
    ${opts.secret ? `<button class="icon" data-eye title="Show">&#xf06e;</button>` : ""}${opts.copy !== undefined ? `<button class="icon" data-c title="Copy">&#xf0c5;</button>` : ""}</div>`);
  let shown = false;
  f.querySelector<HTMLElement>("[data-eye]")?.addEventListener("click", () => { shown = !shown; f.querySelector("b")!.textContent = shown ? value : dots; });
  f.querySelector<HTMLElement>("[data-c]")?.addEventListener("click", () => void copy(opts.copy ?? value, label, opts.secret ? 30_000 : 0));
  return f;
}

function codeField(code: string, remaining: number, period: number) {
  const f = h(`<div class="field"><div class="txt"><span>2FA code</span><b class="otp">${esc(group(code))}</b></div>
    <span class="ring" data-left="${remaining}" data-period="${period}" style="--p:${(remaining / period) * 100}"></span><button class="icon" title="Copy">&#xf0c5;</button></div>`);
  f.querySelector("button")!.onclick = () => void copy(code, "Code");
  return f;
}

async function detailScreen(id: string) {
  clearInterval(ticker);
  const d = await send<Detail | { error?: string; locked?: boolean }>({ t: "item", id });
  if (!("kind" in d)) return void start();
  const title = d.kind === "login" ? d.name : d.kind === "totp" ? d.issuer : d.rpName;
  const fav = d.kind !== "passkey" && d.favorite;
  const bar = h(`<div class="bar"><button class="icon" id="back" title="Back">&#xf060;</button><span class="tileslot"></span><span class="title">${esc(title)}</span>
    ${d.kind !== "passkey" ? `<button class="icon" id="pin" title="${fav ? "Unpin" : "Pin to top"}" style="${fav ? "color:var(--gold)" : ""}">&#xf08d;</button>` : ""}</div>`);
  bar.querySelector(".tileslot")!.replaceWith(entryIcon(title, d.site));
  const body = h(`<div class="scroll"></div>`);
  const acts = h(`<div class="actions"><button class="danger" id="del">&#xf1f8; Delete</button><span class="grow"></span></div>`);
  if (d.kind === "login") {
    if (d.email) body.append(field("Email", d.email, { copy: d.email }));
    if (d.username) body.append(field("Username", d.username, { copy: d.username }));
    if (d.password) body.append(field("Password", d.password, { secret: true, copy: d.password }));
    if (d.code) body.append(codeField(d.code.code, d.code.remaining, d.code.period));
    if (d.urls.length) body.append(field("Websites", d.urls.map((u) => `<a href="#" data-url="${esc(u)}">${esc(u)}</a>`).join("<br>"), { html: true }));
    if (d.notes) body.append(field("Notes", d.notes));
    acts.append(h(`<button id="edit">&#xf044; Edit</button>`), h(`<button class="primary" id="fill">Fill</button>`));
  } else if (d.kind === "totp") {
    body.append(codeField(d.code.code, d.code.remaining, d.code.period));
    if (d.account) body.append(field("Account", d.account, { copy: d.account }));
    if (d.notes) body.append(field("Notes", d.notes));
    acts.append(h(`<button id="edit">&#xf044; Edit</button>`));
  } else {
    body.append(field("Website", d.rpId), field("Username", d.username || d.displayName, { copy: d.username }));
    if (d.created) body.append(field("Created", new Date(d.created).toLocaleString()));
    body.append(h(`<div class="msg" style="padding:10px">Sign in on ${esc(d.rpId)} and pick this passkey when the site asks: Vault signs you in.</div>`));
  }
  app.replaceChildren(bar, body, acts);
  $("#back").onclick = () => void listScreen();
  $("#pin")?.addEventListener("click", async () => { await send({ t: "pin", id }); void detailScreen(id); });
  $("#del").onclick = async () => {
    if (!confirm(`Delete ${title}? It's removed from every device.`)) return;
    await send({ t: "delete", id });
    void listScreen();
  };
  if (d.kind === "login") $("#edit").onclick = () => void editScreen(d);
  if (d.kind === "totp") $("#edit").onclick = () => codeEditScreen(d);
  $("#fill")?.addEventListener("click", async () => {
    const r = await send<{ ok?: boolean; error?: string }>({ t: "fillTab", id });
    r.ok ? window.close() : toast(r.error ?? "Couldn't fill");
  });
  app.querySelectorAll<HTMLElement>("[data-url]").forEach((a) => (a.onclick = (e) => {
    e.preventDefault();
    const u = a.dataset.url!;
    void chrome.tabs.create({ url: /^https?:\/\//.test(u) ? u : `https://${u}` });
  }));
  if (d.kind !== "passkey") ticker = window.setInterval(() => {
    const left = app.querySelector<HTMLElement>("[data-left]");
    if (!left) return;
    const n = Number(left.dataset.left) - 1;
    if (n <= 0) return void detailScreen(id);
    left.dataset.left = String(n);
    left.style.setProperty("--p", String((n / Number(left.dataset.period)) * 100));
  }, 1000);
}

// ------------------------------------------------------------------ new / edit login (the password generator lives here)
async function editScreen(d: Extract<Detail, { kind: "login" }> | null) {
  clearInterval(ticker);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = "";
  try { host = tab?.url && /^https?:/.test(tab.url) ? new URL(tab.url).hostname.replace(/^www\./, "") : ""; } catch { /* not a web page */ }
  const guess = host.split(".").slice(-2, -1)[0] ?? "";
  const name = d?.name ?? guess.replace(/^./, (c) => c.toUpperCase());
  app.replaceChildren(
    h(`<div class="bar"><button class="icon" id="back" title="Back">&#xf060;</button><span class="title">${d ? "Edit login" : "New login"}</span></div>`),
    h(`<div class="scroll"><form class="edit">
      <label>Title</label><input id="name" value="${esc(name)}">
      <label>Email</label><input id="email" type="email" value="${esc(d?.email ?? "")}" autocomplete="off">
      <label>Username</label><input id="user" value="${esc(d?.username ?? "")}" autocomplete="off" placeholder="only if the site has one besides the email">
      <label>Password</label>
      <div class="pwrow"><input id="pass" type="password" value="${esc(d?.password ?? "")}" autocomplete="new-password"><button type="button" class="icon" id="eye" title="Show">&#xf06e;</button><button type="button" id="gen" title="Make a strong password">&#xf021; Generate</button></div>
      <label>One-time code (2FA)</label>
      ${d?.code ? `<div class="pwrow"><input value="${esc(`${d.code.issuer} · ${d.code.account}`)}" disabled><button type="button" id="rmOtp">Remove</button></div>` : ""}
      <input id="otpKey" placeholder="${d?.code ? "Replace with a new setup key or link" : "Setup key (GHBE AHFH ...) or otpauth:// link"}" autocomplete="off" spellcheck="false">
      <label>Website</label><input id="url" value="${esc(d?.urls.join(", ") ?? host)}" placeholder="example.com">
      <label>Notes</label><textarea id="notes">${esc(d?.notes ?? "")}</textarea>
      <div class="err" id="err"></div>
    </form></div>`),
    h(`<div class="actions"><span class="grow"></span><button id="cancel">Cancel</button><button class="primary" id="save">${d ? "Save" : "Add login"}</button></div>`));
  const pass = $<HTMLInputElement>("#pass");
  $("#back").onclick = $("#cancel").onclick = () => void (d ? detailScreen(d.id) : listScreen());
  $("#eye").onclick = () => (pass.type = pass.type === "password" ? "text" : "password");
  $("#gen").onclick = async () => { pass.value = (await send<{ password: string }>({ t: "generate" })).password; pass.type = "text"; };
  $<HTMLInputElement>("#name").focus();
  let removeOtp = false;
  $("#rmOtp")?.addEventListener("click", (e) => { removeOtp = true; (e.currentTarget as HTMLElement).parentElement!.remove(); });
  $("#save").onclick = async () => {
    const login: LoginInput = {
      ...(d ? { id: d.id } : {}), name: $<HTMLInputElement>("#name").value, username: $<HTMLInputElement>("#user").value, email: $<HTMLInputElement>("#email").value, password: pass.value,
      urls: $<HTMLInputElement>("#url").value.split(/[\s,]+/).filter(Boolean), notes: $<HTMLTextAreaElement>("#notes").value,
      otpKey: $<HTMLInputElement>("#otpKey").value, removeOtp,
    };
    if (!login.name.trim() && !login.urls.length) return void ($("#err").textContent = "Give it a title or a website.");
    const r = await send<{ ok?: boolean; error?: string }>({ t: "saveLogin", login });
    if (!r.ok) return void ($("#err").textContent = r.error ?? "Couldn't save.");
    toast(d ? "Saved" : "Login added");
    void listScreen();
  };
}

// ------------------------------------------------------------------ edit a 2FA code
function codeEditScreen(d: Extract<Detail, { kind: "totp" }>) {
  clearInterval(ticker);
  const sel = (id: string, values: (string | number)[], cur: string | number, label = (v: string | number) => String(v)) =>
    `<select id="${id}">${values.map((v) => `<option value="${v}" ${v === cur ? "selected" : ""}>${label(v)}</option>`).join("")}</select>`;
  app.replaceChildren(
    h(`<div class="bar"><button class="icon" id="back" title="Back">&#xf060;</button><span class="title">Edit 2FA code</span></div>`),
    h(`<div class="scroll"><form class="edit">
      <label>Name</label><input id="name" value="${esc(d.name)}" placeholder="${esc(d.service || "e.g. Discord")}">
      <label>Service</label><input id="issuer" value="${esc(d.service)}" placeholder="e.g. Discord">
      <label>Account</label><input id="account" value="${esc(d.account)}" placeholder="the email or username it's for" autocomplete="off">
      <label>New setup key</label><input id="secret" placeholder="Empty keeps the current key" autocomplete="off" spellcheck="false">
      <label>Digits</label>${sel("digits", [6, 7, 8], d.digits)}
      <label>New code every</label>${sel("period", [30, 60], d.period, (v) => `${v} seconds`)}
      <label>Algorithm</label>${sel("algorithm", ["SHA1", "SHA256", "SHA512"], d.algorithm)}
      <label>Notes</label><textarea id="notes">${esc(d.notes)}</textarea>
      <div class="err" id="err"></div>
    </form></div>`),
    h(`<div class="actions"><span class="grow"></span><button id="cancel">Cancel</button><button class="primary" id="save">Save</button></div>`));
  const v = (id: string) => $<HTMLInputElement>(`#${id}`).value;
  $("#back").onclick = $("#cancel").onclick = () => void detailScreen(d.id);
  $("#save").onclick = async () => {
    const code: CodeInput = { id: d.id, name: v("name"), issuer: v("issuer"), account: v("account"), secret: v("secret"),
      digits: Number(v("digits")), period: Number(v("period")), algorithm: v("algorithm") as CodeInput["algorithm"], notes: $<HTMLTextAreaElement>("#notes").value };
    const r = await send<{ ok?: boolean; error?: string }>({ t: "saveCode", code });
    if (!r.ok) return void ($("#err").textContent = r.error ?? "Couldn't save.");
    toast("Saved");
    void detailScreen(d.id);
  };
}

// ------------------------------------------------------------------ settings
async function settingsScreen() {
  clearInterval(ticker);
  st = await send<State>({ t: "state" });
  const s = st.settings;
  const sw = (key: keyof Settings, title: string, sub: string) =>
    `<div class="set"><div><b>${title}</b><span>${sub}</span></div><span class="sw ${s[key] ? "on" : ""}" data-key="${key}" role="switch" tabindex="0"></span></div>`;
  const { sites } = await send<{ sites: string[] }>({ t: "never" });
  const locks: [number, string][] = [[0, "Never"], [5, "5 min"], [15, "15 min"], [60, "1 hour"], [240, "4 hours"]];
  app.replaceChildren(
    h(`<div class="bar"><button class="icon" id="back" title="Back">&#xf060;</button><span class="title">Settings</span></div>`),
    h(`<div class="scroll">
      <div class="group">Account</div>
      <div class="set"><div><b>${esc(st.email ?? "")}</b><span>${st.synced === "synced" ? "Synced with marobotic.dev, on its own: the Vault app doesn't need to be open." : st.synced === "signedOut" ? "Signed out of the server: lock and sign in again to sync." : "Offline: changes sync when you're back online."}</span></div><button id="sync">&#xf021; Sync</button></div>
      ${sw("stayUnlocked", "Stay unlocked", "Vault opens by itself when the browser starts again, no password. Lock (below) still locks it until you type the password.")}
      <div class="set"><div><b>Lock automatically</b><span>After this long without using Vault in this browser.</span></div>
        <select id="lockAfter">${locks.map(([v, l]) => `<option value="${v}" ${s.lockAfter === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="set"><div><b>Lock or sign out</b><span>Signing out also removes the sealed copy from this browser.</span></div><button id="lockNow">Lock</button><button class="danger" id="out">Sign out</button></div>
      <div class="group">Autofill</div>
      ${sw("suggest", "Suggest logins", "Under username and password fields on sites you have logins for.")}
      ${sw("suggestCodes", "Suggest 2FA codes", "Under 2FA code fields, with the code for that site.")}
      ${sw("suggestPasswords", "Suggest strong passwords", "Under new-password fields when you sign up or change a password.")}
      ${sw("offerSave", "Offer to save logins", "After you sign in with a login Vault doesn't have yet, or a changed password.")}
      ${sw("passkeys", "Passkeys in Vault", "Save new passkeys in Vault and sign in with them, on every device. Off: the browser handles passkeys.")}
      <div class="group">Browser</div>
      ${sw("takeover", "Replace the browser's password manager", "Turns off the browser's own \"Save password?\" and its form autofill (typed names, addresses, cards). Passwords the browser saved before: export them as a .csv, import them in the Vault app, then delete them from the browser.")}
      <div class="set"><div><b>Keyboard shortcut</b><span>Ctrl+Shift+L fills the best login, or the 2FA code in a code field.</span></div><button id="keys">Change</button></div>
      <div class="group">Never save on</div>
      ${sites.length ? sites.map((x) => `<div class="site"><span>${esc(x)}</span><button class="icon" data-unnever="${esc(x)}" title="Ask again">&#xf00d;</button></div>`).join("") : `<div class="site"><span>No sites.</span></div>`}
      <div class="group">About</div>
      <div class="site"><span>Vault for browsers ${esc(chrome.runtime.getManifest().version)}</span></div>
    </div>`));
  $("#back").onclick = () => void listScreen();
  app.querySelectorAll<HTMLElement>("[data-key]").forEach((el) => (el.onclick = async () => {
    el.classList.toggle("on");
    await send({ t: "setSettings", settings: { [el.dataset.key as keyof Settings]: el.classList.contains("on") } });
  }));
  $<HTMLSelectElement>("#lockAfter").onchange = (e) => void send({ t: "setSettings", settings: { lockAfter: Number((e.target as HTMLSelectElement).value) } });
  $("#sync").onclick = async () => { const r = await send<{ synced: string }>({ t: "sync" }); toast(r.synced === "synced" ? "Synced" : "Couldn't sync"); void settingsScreen(); };
  $("#lockNow").onclick = async () => { await send({ t: "lock" }); void start(); };
  $("#out").onclick = async () => { if (!confirm("Sign out of Vault in this browser?")) return; await send({ t: "signOut" }); void start(); };
  $("#keys").onclick = () => void chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  app.querySelectorAll<HTMLElement>("[data-unnever]").forEach((b) => (b.onclick = async () => { await send({ t: "unnever", site: b.dataset.unnever! }); void settingsScreen(); }));
}

void start();
