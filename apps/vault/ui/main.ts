// Vault's window: sign in with the marobotic account, and the 2FA codes. Everything secret is opened
// here, on the device; the copy on this PC and the one on the server are both sealed.
import { init, KDF_V1 } from "@marobotic/crypto";
import { totp, normalizeEntry, type OtpEntry } from "@marobotic/otp";
import { importText, importPasswordCsv, type ImportResult } from "@marobotic/importers";
import { Vault, type VaultFile, type Item, type TotpItem, type LoginItem } from "../src/vault.ts";
import { findFfxivEntry, sendWhenAsked } from "../src/xivlauncher.ts";
import { generatePassword, hostOf, matchTotp } from "../src/passwords.ts";
import jsQRModule from "jsqr";
// jsqr is CommonJS with a default export: bundlers and TypeScript disagree on which object that is.
const jsQR = ((jsQRModule as unknown as { default?: unknown }).default ?? jsQRModule) as unknown as typeof import("jsqr").default;
import * as platform from "./platform.ts";
import * as account from "./account.ts";

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const app = $("#app");
const LOCK_AFTER_MS = 10 * 60_000;

let vault: Vault | null = null;
let file: VaultFile | null = null;      // the sealed copy on this PC (null before the first sign-in here)
let session: string | null = null;      // the account session; null = offline, changes stay on this PC
let rev = 0;                            // the server version this vault is based on
let syncing: Promise<void> | null = null;
let query = "";
let lastActive = Date.now();
let autoXl = localStorage.getItem("vault.autoXl") === "1";
let xlRun: AbortController | null = null;
let filter: "all" | "login" | "totp" = "all";

function h(html: string): DocumentFragment {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content;
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let toastTimer = 0;
function toast(text: string) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 2200);
}

async function save() {
  if (!vault) return;
  file = vault.toFile();
  await platform.saveVault(JSON.stringify(file));
  void sync();
}

/** Send this PC's vault to the server; when another device saved first, take its changes in and try again. */
function sync(): Promise<void> {
  if (!session || !vault) return Promise.resolve();
  return (syncing ??= (async () => {
    try {
      for (let i = 0; i < 3 && vault && session; i++) {
        const r = await account.pushVault(session, rev, vault.toFile());
        if ("rev" in r) { rev = r.rev; setSyncState("synced"); return; }
        rev = r.conflict.rev;
        if (vault.merge(r.conflict.file.items)) { file = vault.toFile(); await platform.saveVault(JSON.stringify(file)); renderList(); }
      }
    } catch (e) {
      setSyncState(e instanceof account.SignInError ? "signed out" : "offline");
      if (e instanceof account.SignInError) session = null;
    } finally {
      syncing = null;
    }
  })());
}

function setSyncState(state: "synced" | "offline" | "signed out") {
  const el = document.getElementById("sync");
  if (!el) return;
  el.textContent = state === "synced" ? "Synced" : state === "offline" ? "Offline - saved on this PC" : "Signed out - saved on this PC";
  el.style.setProperty("--state", state === "synced" ? "var(--teal)" : "var(--orange)");
}

// ------------------------------------------------------------------ sign in
function signInScreen(message = "") {
  vault = null;
  session = null;
  stopAutoXl();
  const last = file?.email || localStorage.getItem("vault.email") || "";
  app.replaceChildren(h(`
    <form class="gate">
      <div class="brand"><span class="logo"></span> Vault</div>
      <h1>Sign in</h1>
      <p>Your marobotic account, the same as Hourglass and Jukebox. Your vault is sealed on this device with your password; the server only keeps the sealed copy.</p>
      <label class="lab" for="em">Email</label><input id="em" class="m-field" type="email" autocomplete="username" required value="${esc(last)}">
      <label class="lab" for="pw">Password</label><input id="pw" class="m-field" type="password" autocomplete="current-password" required>
      <div class="err" id="err">${esc(message)}</div>
      <button class="m-btn primary" type="submit">Sign in</button>
    </form>`));
  const form = $<HTMLFormElement>("form", app);
  $(last ? "#pw" : "#em", form).focus();
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const email = $<HTMLInputElement>("#em").value.trim().toLowerCase();
    const pw = $<HTMLInputElement>("#pw").value;
    const btn = $<HTMLButtonElement>("button[type=submit]", form);
    btn.disabled = true; btn.textContent = "Signing in…";
    await new Promise((r) => setTimeout(r, 30)); // let the label paint before Argon2 runs
    try {
      await openAccount(email, pw);
    } catch (e) {
      btn.disabled = false; btn.textContent = "Sign in";
      $("#err").textContent = (e as Error).message;
    }
  };
}

/** Sign in, then: the server's vault (with this PC's offline changes merged in), this PC's vault
 *  uploaded, or a brand-new vault for an account that has none yet. */
async function openAccount(email: string, pw: string) {
  localStorage.setItem("vault.email", email);
  const localFile = file && file.email === email ? file : null;
  try {
    session = await account.signIn(email, pw);
  } catch (e) {
    if (e instanceof account.Offline && localFile) {
      vault = unlockOrNull(localFile, pw);
      if (!vault) throw new Error("That password doesn't open the copy on this PC.");
      homeScreen();
      setSyncState("offline");
      return;
    }
    throw e instanceof account.Offline ? new Error(`${e.message}, and there is no copy of this vault on this PC yet.`) : e;
  }
  const remote = await account.fetchVault(session);
  if (remote) {
    rev = remote.rev;
    vault = unlockOrNull(remote.file, pw);
    if (!vault) return recoveryUnlockScreen(remote.file, pw);   // the account password changed since
    if (localFile) {
      const mine = unlockOrNull(localFile, pw);
      if (mine) vault.merge(mine.toFile().items);
    }
  } else if (localFile && unlockOrNull(localFile, pw)) {
    vault = unlockOrNull(localFile, pw);
    rev = 0;
  } else {
    const made = Vault.create(email, pw, { kdf: KDF_V1 });
    vault = made.vault;
    rev = 0;
    await save();
    return recoveryScreen(made.recoveryCode);
  }
  await save();
  homeScreen();
}

function unlockOrNull(f: VaultFile, pw: string): Vault | null {
  try { return Vault.unlock(f, pw); } catch { return null; }
}

function recoveryScreen(code: string, replaced = false) {
  app.replaceChildren(h(`
    <div class="gate">
      <div class="brand"><span class="logo"></span> Vault</div>
      <h1>Your recovery kit</h1>
      <p>${replaced ? "This replaces your old recovery kit, which no longer opens your vault." : "Your vault is ready."} Write this down or print it and keep it somewhere safe: it is the <b>only</b> way back into your vault if your account password is ever reset. It is shown once; nobody, including the server, can show it again.</p>
      <div class="kit">${esc(code)}</div>
      <button class="m-btn" id="copy"> Copy</button>
      <label class="check"><input type="checkbox" id="ok"> I have written it down</label>
      <button class="m-btn primary" id="go" disabled>Open my vault</button>
    </div>`));
  $("#copy").onclick = async () => { await navigator.clipboard.writeText(code); toast("Recovery kit copied - paste it somewhere safe, then clear it"); };
  $<HTMLInputElement>("#ok").onchange = (e) => ($<HTMLButtonElement>("#go").disabled = !(e.target as HTMLInputElement).checked);
  $("#go").onclick = () => homeScreen();
}

/** The account password changed since the vault was sealed: the recovery kit opens it, then it is
 *  sealed again for the password just used. */
function recoveryUnlockScreen(sealed: VaultFile, newPassword: string) {
  app.replaceChildren(h(`
    <form class="gate">
      <div class="brand"><span class="logo"></span> Vault</div>
      <h1>Your password changed</h1>
      <p>You signed in, but your vault is still sealed with your old password. Type the 52 letters from your recovery kit (dashes and spaces don't matter) and the vault opens with your current password from now on.</p>
      <textarea id="code" class="m-field" style="height:90px;padding:10px" required></textarea>
      <div class="err" id="err"></div>
      <button class="m-btn primary" type="submit">Open my vault</button>
      <button class="m-btn subtle" type="button" id="back">Back</button>
    </form>`));
  $("#back").onclick = () => signInScreen();
  $<HTMLFormElement>("form", app).onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      vault = Vault.unlockWithRecovery(sealed, $<HTMLTextAreaElement>("#code").value);
      vault.setPassword(newPassword);
      await save();
      homeScreen();
      toast("Opened with the recovery kit; the vault now opens with your current password");
    } catch (e) {
      $("#err").textContent = (e as Error).message;
    }
  };
}

// ------------------------------------------------------------------ the vault: logins and 2FA codes
type TotpRow = Item & { data: TotpItem };
type LoginRow = Item & { data: LoginItem };

const otps = () => (vault?.list("totp") ?? []) as TotpRow[];
const logins = () => (vault?.list("login") ?? []) as LoginRow[];
const groupCode = (c: string) => (c.length === 6 ? `${c.slice(0, 3)} ${c.slice(3)}` : c.length === 8 ? `${c.slice(0, 4)} ${c.slice(4)}` : c);
const nameOf = (i: TotpRow) => i.data.label || i.data.otp.issuer || i.data.otp.account || "Untitled";

/** The 2FA code for a login: the one it is linked to, else one that matches by site and account. */
function codeFor(login: LoginItem): OtpEntry | undefined {
  if (login.totpId) { const it = vault?.get(login.totpId); if (it?.data.type === "totp") return it.data.otp; }
  return matchTotp(login, otps().map((i) => i.data))?.otp;
}

async function copy(text: string, said: string, clearAfter = 0) {
  await navigator.clipboard.writeText(text);
  toast(said);
  if (clearAfter) setTimeout(async () => { try { if ((await navigator.clipboard.readText()) === text) await navigator.clipboard.writeText(""); } catch { /* clipboard not readable: leave it */ } }, clearAfter);
}

function homeScreen() {
  app.replaceChildren(h(`
    <div class="top">
      <div class="brand grow"><span class="logo"></span> Vault</div>
      <button class="m-btn compact" id="lock" title="Lock"> Lock</button>
      <button class="m-btn subtle compact" id="kit" title="Make a new recovery kit; the old one stops working"> Recovery kit</button>
    </div>
    <div class="m-sync sync-line" id="sync" style="--state: var(--faint)">${session ? "Syncing…" : "Offline - saved on this PC"}</div>
    <div class="bar">
      <input class="m-field grow" id="q" placeholder="Search" value="${esc(query)}">
      <button class="m-btn primary compact" id="newLogin"> Login</button>
      <button class="m-btn compact" id="newCode"> 2FA</button>
      <button class="m-btn compact" id="import"> Import</button>
    </div>
    <div class="m-seg filter" id="filter"></div>
    <div id="list"></div>`));
  $("#lock").onclick = () => signInScreen();
  $("#kit").onclick = async () => {
    if (!confirm("Make a new recovery kit? Your current one stops working, so write the new one down right away.")) return;
    const code = vault!.newRecoveryKit();
    await save();
    recoveryScreen(code, true);
  };
  $("#newLogin").onclick = () => loginEditor(null);
  $("#newCode").onclick = () => addModal("codes");
  $("#import").onclick = () => addModal("import");
  const seg = $("#filter");
  for (const [v, label] of [["all", "All"], ["login", "Passwords"], ["totp", "2FA codes"]] as const) {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = filter === v ? "on" : "";
    b.onclick = () => { filter = v; homeScreen(); };
    seg.append(b);
  }
  $<HTMLInputElement>("#q").oninput = (e) => { query = (e.target as HTMLInputElement).value; renderList(); };
  renderList();
  if (autoXl) startAutoXl();
  if (session) void sync();
}

const matchesQuery = (hay: string) => { const q = query.trim().toLowerCase(); return !q || hay.toLowerCase().includes(q); };

function renderList() {
  const list = $("#list");
  if (!list) return;
  const ls = logins().sort((a, b) => a.data.name.localeCompare(b.data.name));
  const ts = otps().sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const rows: HTMLElement[] = [];
  if (filter !== "totp") for (const i of ls) if (matchesQuery(`${i.data.name} ${i.data.username} ${i.data.urls.join(" ")}`)) rows.push(loginRow(i));
  const ff = findFfxivEntry(ts.map((i) => i.data.otp));
  if (filter !== "login") for (const i of ts) if (matchesQuery(`${nameOf(i)} ${i.data.otp.issuer} ${i.data.otp.account}`)) rows.push(codeRow(i, ff === i.data.otp));

  if (!rows.length) {
    const msg = ls.length || ts.length ? "Nothing matches your search." : "Your vault is empty.";
    const hint = ls.length || ts.length ? "" : "Add a login, a 2FA code, or import from your browser or another app.";
    list.replaceChildren(h(`<div class="empty"><div>${msg}</div>${hint ? `<div class="faint">${hint}</div>` : ""}
      ${ls.length || ts.length ? "" : `<div class="row2" style="max-width:420px"><button class="m-btn primary" id="e1"> New login</button><button class="m-btn" id="e2"> Add 2FA</button></div>`}</div>`));
    $("#e1")?.addEventListener("click", () => loginEditor(null));
    $("#e2")?.addEventListener("click", () => addModal("codes"));
    return;
  }
  list.replaceChildren(...rows);
  tick();
}

function loginRow(i: LoginRow): HTMLElement {
  const d = i.data;
  const host = d.urls[0] ? hostOf(d.urls[0]) : "";
  const linked = codeFor(d);
  const row = h(`
    <div class="item login" data-login="${i.id}">
      <div class="who"><b>${esc(d.name)}</b><span>${esc(d.username)}${host ? " · " + esc(host) : ""}</span></div>
      <div class="actions">
        ${d.username ? `<button class="m-btn subtle compact" data-cuser> User</button>` : ""}
        ${d.password ? `<button class="m-btn subtle compact" data-cpass> Password</button>` : ""}
        ${linked ? `<span class="mini" title="${esc(linked.issuer || linked.account)} 2FA"><span class="mono" data-code>······</span><span class="m-level mini-bar"><i data-bar></i></span><button class="m-btn subtle compact" data-ccode>Copy</button></span>` : ""}
        <span class="grow"></span>
        <button class="m-btn subtle compact" data-edit title="Edit"></button>
      </div>
    </div>`).firstElementChild as HTMLElement;
  if (linked) (row as HTMLElement).dataset.code = JSON.stringify({}); // marks it for tick()
  row.querySelector<HTMLElement>("[data-cuser]")?.addEventListener("click", () => copy(d.username, `${d.name}: username copied`));
  row.querySelector<HTMLElement>("[data-cpass]")?.addEventListener("click", () => copy(d.password, `${d.name}: password copied (clears in 30s)`, 30_000));
  row.querySelector<HTMLElement>("[data-ccode]")?.addEventListener("click", async () => { if (linked) await copy((await totp(linked)).code, `${d.name}: 2FA code copied`); });
  row.querySelector<HTMLElement>("[data-edit]")!.onclick = () => loginEditor(i);
  return row;
}

function codeRow(i: TotpRow, isFf: boolean): HTMLElement {
  const row = h(`
    <div class="code-row" data-id="${i.id}" style="border-left-color:${isFf ? "var(--gold)" : "var(--border)"}">
      <div class="who"><b>${esc(nameOf(i))}</b><span>${esc(i.data.otp.account)}</span></div>
      <div class="code" data-code>······</div>
      <div class="m-level"><i data-bar></i></div>
      <div class="actions">
        ${isFf ? `<button class="m-btn compact" data-xl> Send to XIVLauncher</button>
                  <span class="m-switch ${autoXl ? "on" : ""}" data-auto title="Send it by itself whenever XIVLauncher asks"></span>
                  <span class="note">Auto-send when XIVLauncher asks</span>` : ""}
        <span class="grow" style="flex:1"></span>
        <button class="m-btn subtle compact trash" data-del title="Remove"></button>
      </div>
    </div>`).firstElementChild as HTMLElement;
  row.onclick = async (ev) => {
    if ((ev.target as HTMLElement).closest("button, .m-switch")) return;
    await copy((await totp(i.data.otp)).code, `${nameOf(i)}: code copied`);
  };
  row.querySelector<HTMLElement>("[data-del]")!.onclick = async () => {
    if (!confirm(`Remove ${nameOf(i)}? Make sure you can still sign in to it another way.`)) return;
    vault!.remove(i.id);
    await save();
    renderList();
  };
  row.querySelector<HTMLElement>("[data-xl]")?.addEventListener("click", () => sendOnce(i.data.otp));
  row.querySelector<HTMLElement>("[data-auto]")?.addEventListener("click", (e) => {
    autoXl = !autoXl;
    localStorage.setItem("vault.autoXl", autoXl ? "1" : "0");
    (e.target as HTMLElement).classList.toggle("on", autoXl);
    autoXl ? startAutoXl() : stopAutoXl();
    toast(autoXl ? "Vault will send your FFXIV code whenever XIVLauncher asks" : "Auto-send is off");
  });
  return row;
}

async function tick() {
  const now = Date.now();
  for (const row of document.querySelectorAll<HTMLElement>(".code-row")) {
    const item = vault?.get(row.dataset.id!);
    if (!item || item.data.type !== "totp") continue;
    paintCode(row, await totp(item.data.otp, now), item.data.otp.period);
  }
  for (const row of document.querySelectorAll<HTMLElement>(".login[data-login]")) {
    const item = vault?.get(row.dataset.login!);
    if (!item || item.data.type !== "login") continue;
    const otp = codeFor(item.data);
    if (otp) paintCode(row, await totp(otp, now), otp.period);
  }
}
function paintCode(row: HTMLElement, r: { code: string; remaining: number }, period: number) {
  const el = row.querySelector<HTMLElement>("[data-code]");
  if (!el) return;
  el.textContent = groupCode(r.code);
  el.classList.toggle("low", r.remaining <= 5);
  const bar = row.querySelector<HTMLElement>("[data-bar]");
  if (bar) { bar.style.setProperty("--v", `${(r.remaining / period) * 100}%`); bar.parentElement!.classList.toggle("full", r.remaining <= 5); }
}

// ------------------------------------------------------------------ login editor
function loginEditor(existing: LoginRow | null) {
  const d: LoginItem = existing ? { ...existing.data } : { type: "login", name: "", urls: [], username: "", password: "", notes: "" };
  const codes = otps();
  const back = h(`
    <div class="backdrop">
      <form class="m-modal modal">
        <header>${existing ? "Edit login" : "New login"} <button class="m-btn subtle compact" type="button" data-close></button></header>
        <div class="content">
          <label class="lab">Name</label><input class="m-field" id="name" value="${esc(d.name)}" placeholder="e.g. GitHub" required>
          <label class="lab">Website</label><input class="m-field" id="url" value="${esc(d.urls.join(", "))}" placeholder="github.com">
          <label class="lab">Username or email</label><input class="m-field" id="user" value="${esc(d.username)}" autocomplete="off">
          <label class="lab">Password</label>
          <div class="pw"><input class="m-field grow" id="pass" type="password" value="${esc(d.password)}" autocomplete="off"><button class="m-btn subtle compact" type="button" id="show"></button><button class="m-btn subtle compact" type="button" id="gen"> Generate</button></div>
          <label class="lab">2FA code</label>
          <select class="m-field" id="totp"></select>
          <label class="lab">Notes</label><textarea id="notes">${esc(d.notes ?? "")}</textarea>
          <div class="result" id="result"></div>
        </div>
        <footer>
          ${existing ? `<button class="m-btn danger" type="button" id="del"> Delete</button>` : ""}
          <span class="grow"></span>
          <button class="m-btn" type="button" data-close>Cancel</button>
          <button class="m-btn primary" type="submit">${existing ? "Save" : "Add login"}</button>
        </footer>
      </form>
    </div>`).firstElementChild as HTMLElement;
  document.body.append(back);
  const sel = $<HTMLSelectElement>("#totp", back);
  const auto = codeFor({ ...d, totpId: undefined });
  sel.append(new Option(auto ? `Match automatically (${auto.issuer || auto.account})` : "None / match automatically", ""));
  for (const c of codes) sel.append(new Option(`${nameOf(c)} · ${c.data.otp.account}`, c.id));
  sel.value = d.totpId && codes.some((c) => c.id === d.totpId) ? d.totpId : "";
  const close = () => { back.remove(); renderList(); };
  back.querySelectorAll<HTMLElement>("[data-close]").forEach((b) => (b.onclick = close));
  back.onclick = (e) => { if (e.target === back) close(); };
  const pass = $<HTMLInputElement>("#pass", back);
  $("#show", back).onclick = () => (pass.type = pass.type === "password" ? "text" : "password");
  $("#gen", back).onclick = () => { pass.value = generatePassword({ length: 20 }); pass.type = "text"; };
  $("#name", back).focus();
  $("#del", back)?.addEventListener("click", async () => {
    if (!existing || !confirm(`Delete ${existing.data.name}? This can't be undone.`)) return;
    vault!.remove(existing.id);
    await save();
    close();
  });
  $<HTMLFormElement>("form", back).onsubmit = async (ev) => {
    ev.preventDefault();
    const name = $<HTMLInputElement>("#name", back).value.trim();
    if (!name) return void ($("#result", back).textContent = "Give it a name.");
    const data: LoginItem = {
      type: "login",
      name,
      urls: $<HTMLInputElement>("#url", back).value.split(/[\s,]+/).filter(Boolean),
      username: $<HTMLInputElement>("#user", back).value.trim(),
      password: pass.value,
      notes: $<HTMLTextAreaElement>("#notes", back).value,
      ...(sel.value ? { totpId: sel.value } : {}),
    };
    if (existing) vault!.update(existing.id, data); else vault!.add(data);
    await save();
    close();
    toast(existing ? `${name} saved` : `${name} added`);
  };
}

// ------------------------------------------------------------------ XIVLauncher
async function sendOnce(entry: OtpEntry) {
  if (!platform.inApp) return toast("Sending to XIVLauncher works in the Vault app, not in a browser");
  toast("Waiting for XIVLauncher's OTP box…");
  const r = await sendWhenAsked(entry, { untilMs: 60_000, send: platform.xlSend });
  toast(r.sent ? "Code sent to XIVLauncher" : "XIVLauncher didn't ask within a minute - is its OTP box open, with app support on?");
}

function startAutoXl() {
  if (xlRun || !platform.inApp || !vault) return;
  const run = (xlRun = new AbortController());
  (async () => {
    while (!run.signal.aborted && vault) {
      const entry = findFfxivEntry(otps().map((i) => i.data.otp));
      if (!entry) break;
      const r = await sendWhenAsked(entry, { untilMs: 60 * 60_000, everyMs: 1500, send: platform.xlSend, signal: run.signal });
      if (r.sent) { toast("FFXIV code sent to XIVLauncher"); await new Promise((ok) => setTimeout(ok, 45_000)); }
    }
  })();
}
function stopAutoXl() { xlRun?.abort(); xlRun = null; }

// ------------------------------------------------------------------ adding codes and importing
function addModal(tab: "codes" | "import" = "codes") {
  const back = h(`
    <div class="backdrop">
      <form class="m-modal modal">
        <header>${tab === "import" ? "Import" : "Add 2FA codes"} <button class="m-btn subtle compact" type="button" data-close></button></header>
        <div class="content">
          <div class="drop" id="pick"> Choose QR images or screenshots<br><span class="faint">Google Authenticator's "Transfer accounts" QR codes work too: one image per code</span></div>
          <input type="file" id="files" accept="image/*" multiple hidden>
          <div class="drop" id="pickCsv"> Import passwords from a .csv<br><span class="faint">Chrome, Brave, Edge, Firefox, Bitwarden, Apple Passwords, 1Password, LastPass — their 2FA keys come too</span></div>
          <input type="file" id="csv" accept=".csv,text/csv" hidden>
          <label class="lab">or paste 2FA links (otpauth:// or otpauth-migration://)</label>
          <textarea id="text" placeholder="otpauth://totp/GitHub:you?secret=...&#10;otpauth-migration://offline?data=..."></textarea>
          <div class="row2"><input class="m-field" id="iss" placeholder="Service (optional)"><input class="m-field" id="acc" placeholder="Account (optional)"></div>
          <input class="m-field" id="key" placeholder="or a setup key (letters A-Z and 2-7)">
          <div class="result" id="result"></div>
        </div>
        <footer><button class="m-btn" type="button" data-close>Close</button><button class="m-btn primary" type="submit">Add</button></footer>
      </form>
    </div>`).firstElementChild as HTMLElement;
  document.body.append(back);
  const close = () => { back.remove(); renderList(); };
  back.querySelectorAll<HTMLElement>("[data-close]").forEach((b) => (b.onclick = close));
  back.onclick = (e) => { if (e.target === back) close(); };
  const report = (lines: string[]) => ($("#result", back).textContent = lines.join("\n"));

  const files = $<HTMLInputElement>("#files", back);
  $("#pick", back).onclick = () => files.click();
  files.onchange = async () => {
    const texts: string[] = [], unreadable: string[] = [];
    for (const f of files.files ?? []) { const t = await readQr(f); t ? texts.push(t) : unreadable.push(f.name); }
    const r = await addCodes(importText(texts.join("\n")));
    report([`Added ${r.added}${r.already ? `, ${r.already} already here` : ""}.`, ...r.skipped.map((s) => `Skipped - ${s}`), ...unreadable.map((n) => `Skipped - ${n}: no QR code found`)]);
    files.value = "";
  };

  const csv = $<HTMLInputElement>("#csv", back);
  $("#pickCsv", back).onclick = () => csv.click();
  csv.onchange = async () => {
    const f = csv.files?.[0];
    if (f) report(await importLogins(await f.text()));
    csv.value = "";
  };

  $<HTMLFormElement>("form", back).onsubmit = async (ev) => {
    ev.preventDefault();
    const text = $<HTMLTextAreaElement>("#text", back).value;
    const key = $<HTMLInputElement>("#key", back).value.trim();
    const results: ImportResult = { entries: [], skipped: [] };
    if (text.trim()) { const r = importText(text); results.entries.push(...r.entries); results.skipped.push(...r.skipped); }
    if (key) {
      try { results.entries.push(normalizeEntry({ issuer: $<HTMLInputElement>("#iss", back).value, account: $<HTMLInputElement>("#acc", back).value, secret: key })); }
      catch (e) { results.skipped.push(`setup key: ${(e as Error).message}`); }
    }
    if (!text.trim() && !key) return void report(["Paste a link, type a setup key, or choose a file above."]);
    const r = await addCodes(results);
    report([`Added ${r.added}${r.already ? `, ${r.already} already here` : ""}.`, ...r.skipped.map((s) => `Skipped - ${s}`)]);
    $<HTMLTextAreaElement>("#text", back).value = "";
    $<HTMLInputElement>("#key", back).value = "";
  };
}

async function addCodes(r: ImportResult) {
  const have = new Set(otps().map((i) => `${i.data.otp.secret}|${i.data.otp.issuer}|${i.data.otp.account}`));
  let added = 0, already = 0;
  for (const e of r.entries) {
    const k = `${e.secret}|${e.issuer}|${e.account}`;
    if (have.has(k)) { already++; continue; }
    vault!.add({ type: "totp", otp: e });
    have.add(k);
    added++;
  }
  if (added) await save();
  return { added, already, skipped: r.skipped };
}

/** Import logins from a password-manager CSV; each login's 2FA key becomes a linked code. */
async function importLogins(text: string): Promise<string[]> {
  const res = importPasswordCsv(text);
  const haveLogin = new Set(logins().map((i) => `${i.data.name}|${i.data.username}`.toLowerCase()));
  const haveCode = new Set(otps().map((i) => i.data.otp.secret));
  let added = 0, already = 0, withCode = 0;
  for (const l of res.logins) {
    if (haveLogin.has(`${l.name}|${l.username}`.toLowerCase())) { already++; continue; }
    let totpId: string | undefined;
    if (l.totp && !haveCode.has(l.totp.secret)) { totpId = vault!.add({ type: "totp", otp: l.totp }).id; haveCode.add(l.totp.secret); withCode++; }
    vault!.add({ type: "login", name: l.name, urls: l.urls, username: l.username, password: l.password, notes: l.notes, ...(totpId ? { totpId } : {}) });
    haveLogin.add(`${l.name}|${l.username}`.toLowerCase());
    added++;
  }
  if (added || withCode) await save();
  return [`From ${res.source}: added ${added} login${added === 1 ? "" : "s"}${withCode ? ` (${withCode} with a 2FA code)` : ""}${already ? `, ${already} already here` : ""}.`, ...res.skipped.map((s) => `Skipped - ${s}`)];
}

async function readQr(f: File): Promise<string | null> {
  const bmp = await createImageBitmap(f);
  const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height)); // big screenshots: QR still readable, less work
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const g = c.getContext("2d")!;
  g.drawImage(bmp, 0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height);
  return jsQR(img.data, img.width, img.height)?.data ?? null;
}

// ------------------------------------------------------------------ start
for (const ev of ["pointerdown", "keydown"]) addEventListener(ev, () => (lastActive = Date.now()));
setInterval(() => {
  if (vault && Date.now() - lastActive > LOCK_AFTER_MS) signInScreen("Locked after 10 minutes without use.");
  else if (vault) tick();
}, 1000);

(async () => {
  await init();
  // Browser-only preview: ?dev opens a throwaway local vault with sample data (never in the app).
  if (!platform.inApp && location.search.includes("dev")) {
    const made = Vault.create("dev@marobotic.dev", "dev", { kdf: { v: 1, alg: "argon2id13", ops: 1, memBytes: 8 * 1024 * 1024 } });
    vault = made.vault;
    vault.add({ type: "login", name: "GitHub", urls: ["github.com"], username: "mi@marobotic.dev", password: "s3cr3t-demo", notes: "" });
    vault.add({ type: "login", name: "Square Enix", urls: ["https://secure.square-enix.com"], username: "maro", password: "demo-pw-9", notes: "" });
    vault.add({ type: "totp", otp: normalizeEntry({ issuer: "GitHub", account: "mi@marobotic.dev", secret: "JBSWY3DPEHPK3PXP" }) });
    vault.add({ type: "totp", otp: normalizeEntry({ issuer: "Square Enix", account: "maro", secret: "GEZDGNBVGY3TQOJQ" }) });
    return homeScreen();
  }
  const text = await platform.loadVault();
  if (!text) return signInScreen();
  try {
    file = JSON.parse(text) as VaultFile;
    signInScreen();
  } catch {
    app.replaceChildren(h(`<div class="center">The vault file couldn't be read. It has not been changed.<br><span class="faint">${esc(await platform.vaultPath())}</span></div>`));
  }
})();

