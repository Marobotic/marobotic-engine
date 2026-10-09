// Vault's window: sign in with the marobotic account, and the 2FA codes. Everything secret is opened
// here, on the device; the copy on this PC and the one on the server are both sealed.
import { init, KDF_V1 } from "@marobotic/crypto";
import { totp, normalizeEntry, type OtpEntry } from "@marobotic/otp";
import { importText, type ImportResult } from "@marobotic/importers";
import { Vault, type VaultFile, type Item, type TotpItem } from "../src/vault.ts";
import { findFfxivEntry, sendWhenAsked } from "../src/xivlauncher.ts";
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
      codesScreen();
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
  codesScreen();
}

function unlockOrNull(f: VaultFile, pw: string): Vault | null {
  try { return Vault.unlock(f, pw); } catch { return null; }
}

function recoveryScreen(code: string) {
  app.replaceChildren(h(`
    <div class="gate">
      <div class="brand"><span class="logo"></span> Vault</div>
      <h1>Your recovery kit</h1>
      <p>Your vault is ready. Write this down or print it and keep it somewhere safe: it is the <b>only</b> way back into your vault if your account password is ever reset. It is shown once; nobody, including the server, can show it again.</p>
      <div class="kit">${esc(code)}</div>
      <button class="m-btn" id="copy"> Copy</button>
      <label class="check"><input type="checkbox" id="ok"> I have written it down</label>
      <button class="m-btn primary" id="go" disabled>Open my vault</button>
    </div>`));
  $("#copy").onclick = async () => { await navigator.clipboard.writeText(code); toast("Recovery kit copied - paste it somewhere safe, then clear it"); };
  $<HTMLInputElement>("#ok").onchange = (e) => ($<HTMLButtonElement>("#go").disabled = !(e.target as HTMLInputElement).checked);
  $("#go").onclick = () => codesScreen();
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
      codesScreen();
      toast("Opened with the recovery kit; the vault now opens with your current password");
    } catch (e) {
      $("#err").textContent = (e as Error).message;
    }
  };
}

// ------------------------------------------------------------------ codes
const otps = () => (vault?.list("totp") ?? []) as (Item & { data: TotpItem })[];
const groupCode = (c: string) => (c.length === 6 ? `${c.slice(0, 3)} ${c.slice(3)}` : c.length === 8 ? `${c.slice(0, 4)} ${c.slice(4)}` : c);
const nameOf = (i: Item & { data: TotpItem }) => i.data.label || i.data.otp.issuer || i.data.otp.account || "Untitled";

function codesScreen() {
  app.replaceChildren(h(`
    <div class="top">
      <div class="brand grow"><span class="logo"></span> Vault</div>
      <button class="m-btn primary compact" id="add"> Add</button>
      <button class="m-btn compact" id="lock" title="Lock"> Lock</button>
    </div>
    <div class="m-sync sync-line" id="sync" style="--state: var(--faint)">${session ? "Syncing…" : "Offline - saved on this PC"}</div>
    <input class="m-field search" id="q" placeholder="Search" value="${esc(query)}">
    <h2 class="m-section">2FA CODES <span class="detail" id="count"></span></h2>
    <div id="list"></div>`));
  $("#add").onclick = () => addModal();
  $("#lock").onclick = () => signInScreen();
  $<HTMLInputElement>("#q").oninput = (e) => { query = (e.target as HTMLInputElement).value; renderList(); };
  renderList();
  if (autoXl) startAutoXl();
  if (session) void sync();
}

function renderList() {
  const list = $("#list");
  if (!list) return;
  const all = otps().sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const q = query.trim().toLowerCase();
  const shown = all.filter((i) => !q || `${nameOf(i)} ${i.data.otp.issuer} ${i.data.otp.account}`.toLowerCase().includes(q));
  $("#count").textContent = `· ${all.length}`;
  if (!all.length) {
    list.replaceChildren(h(`<div class="empty"><div>No codes yet.</div><div class="faint">Add them from a QR code, a Google Authenticator export, or a setup key.</div><button class="m-btn primary" id="add2"> Add codes</button></div>`));
    $("#add2").onclick = () => addModal();
    return;
  }
  const ff = findFfxivEntry(all.map((i) => i.data.otp));
  list.replaceChildren(...shown.map((i) => {
    const isFf = ff === i.data.otp;
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
      const { code } = await totp(i.data.otp);
      await navigator.clipboard.writeText(code);
      toast(`${nameOf(i)}: code copied`);
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
  }));
  tick();
}

async function tick() {
  const now = Date.now();
  for (const row of document.querySelectorAll<HTMLElement>(".code-row")) {
    const item = vault?.get(row.dataset.id!);
    if (!item || item.data.type !== "totp") continue;
    const { code, remaining } = await totp(item.data.otp, now);
    const el = row.querySelector<HTMLElement>("[data-code]")!;
    el.textContent = groupCode(code);
    el.classList.toggle("low", remaining <= 5);
    const bar = row.querySelector<HTMLElement>("[data-bar]")!;
    bar.style.setProperty("--v", `${(remaining / item.data.otp.period) * 100}%`);
    bar.parentElement!.classList.toggle("full", remaining <= 5);
  }
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

// ------------------------------------------------------------------ adding codes
function addModal() {
  const back = h(`
    <div class="backdrop">
      <form class="m-modal modal">
        <header>Add codes <button class="m-btn subtle compact" type="button" data-close></button></header>
        <div class="sub">From a QR code image or screenshot, a Google Authenticator export, or a setup key.</div>
        <div class="content">
          <div class="drop" id="pick"> Choose QR images or screenshots<br><span class="faint">Google Authenticator's "Transfer accounts" QR codes work too: one image per code</span></div>
          <input type="file" id="files" accept="image/*" multiple hidden>
          <label class="lab">or paste links (otpauth:// or otpauth-migration://)</label>
          <textarea id="text" placeholder="otpauth://totp/GitHub:you?secret=...&#10;otpauth-migration://offline?data=..."></textarea>
          <label class="lab">or type a setup key</label>
          <div class="row2"><input class="m-field" id="iss" placeholder="Service (e.g. Square Enix)"><input class="m-field" id="acc" placeholder="Account"></div>
          <input class="m-field" id="key" placeholder="Setup key (letters A-Z and 2-7)">
          <div class="result" id="result"></div>
        </div>
        <footer><button class="m-btn" type="button" data-close>Close</button><button class="m-btn primary" type="submit">Add</button></footer>
      </form>
    </div>`).firstElementChild as HTMLElement;
  document.body.append(back);
  const close = () => { back.remove(); renderList(); };
  back.querySelectorAll<HTMLElement>("[data-close]").forEach((b) => (b.onclick = close));
  back.onclick = (e) => { if (e.target === back) close(); };
  const files = $<HTMLInputElement>("#files", back);
  $("#pick", back).onclick = () => files.click();
  files.onchange = async () => {
    const texts: string[] = [];
    const unreadable: string[] = [];
    for (const f of files.files ?? []) {
      const t = await readQr(f);
      t ? texts.push(t) : unreadable.push(f.name);
    }
    report(await addAll(importText(texts.join("\n"))), unreadable.map((n) => `${n}: no QR code found in it`));
    files.value = "";
  };
  $<HTMLFormElement>("form", back).onsubmit = async (ev) => {
    ev.preventDefault();
    const text = $<HTMLTextAreaElement>("#text", back).value;
    const key = $<HTMLInputElement>("#key", back).value.trim();
    const results: ImportResult = { entries: [], skipped: [] };
    if (text.trim()) { const r = importText(text); results.entries.push(...r.entries); results.skipped.push(...r.skipped); }
    if (key) {
      try {
        results.entries.push(normalizeEntry({ issuer: $<HTMLInputElement>("#iss", back).value, account: $<HTMLInputElement>("#acc", back).value, secret: key }));
      } catch (e) { results.skipped.push(`setup key: ${(e as Error).message}`); }
    }
    if (!text.trim() && !key) return void ($("#result", back).textContent = "Paste a link, type a setup key, or choose images.");
    report(await addAll(results), []);
    $<HTMLTextAreaElement>("#text", back).value = "";
    $<HTMLInputElement>("#key", back).value = "";
  };
  function report(r: { added: number; already: number; skipped: string[] }, extra: string[]) {
    const lines = [`Added ${r.added}` + (r.already ? `, ${r.already} already here` : "") + "."];
    for (const s of [...r.skipped, ...extra]) lines.push(`Skipped - ${s}`);
    $("#result", back).textContent = lines.join("\n");
  }
}

async function addAll(r: ImportResult) {
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
  const text = await platform.loadVault();
  if (!text) return signInScreen();
  try {
    file = JSON.parse(text) as VaultFile;
    signInScreen();
  } catch {
    app.replaceChildren(h(`<div class="center">The vault file couldn't be read. It has not been changed.<br><span class="faint">${esc(await platform.vaultPath())}</span></div>`));
  }
})();

