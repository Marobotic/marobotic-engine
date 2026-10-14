// Vault's window: sign in with the marobotic account, and the 2FA codes. Everything secret is opened
// here, on the device; the copy on this PC and the one on the server are both sealed.
import { init, KDF_V1 } from "@marobotic/crypto";
import { totp, normalizeEntry, base32Decode, type OtpEntry, type Algorithm } from "@marobotic/otp";
import { importText, importPasswordCsv, type ImportResult } from "@marobotic/importers";
import { Vault, type VaultFile, type Item, type TotpItem, type LoginItem, type PasskeyItem } from "../src/vault.ts";
import { ffxivEntries, sendWhenAsked } from "../src/xivlauncher.ts";
import { generatePassword, hostOf, matchTotp } from "../src/passwords.ts";
import { siteOf } from "../src/icons.ts";
import { MULTI, SAME_SIGN_IN, loginsFor, siteKey } from "../src/domains.ts";
import { allCodes, mergeCodesIntoLogins } from "../src/merge.ts";
import { entryIcon, openMenu, closeMenu, type MenuSection } from "./widgets.ts";
import jsQRModule from "jsqr";
// jsqr is CommonJS with a default export: bundlers and TypeScript disagree on which object that is.
const jsQR = ((jsQRModule as unknown as { default?: unknown }).default ?? jsQRModule) as unknown as typeof import("jsqr").default;
import * as platform from "./platform.ts";
import * as account from "./account.ts";

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const app = $("#app");
/** "this phone" or "this PC", for messages about the copy kept here. */
const here = platform.isMobile ? "this phone" : "this PC";
const LOCK_CHOICES = [0, 5, 15, 30, 60, 240, 1440];   // minutes; 0 = never

let vault: Vault | null = null;
let file: VaultFile | null = null;      // the sealed copy on this PC (null before the first sign-in here)
let session: string | null = null;      // the account session; null = offline, changes stay on this PC
let rev = 0;                            // the server version this vault is based on
let syncing: Promise<void> | null = null;
let query = "";
let lastActive = Date.now();
let lockAfterMin = Number(localStorage.getItem("vault.lockAfterMin")) || 0;   // off unless chosen in Settings
let autoXlId = localStorage.getItem("vault.autoXlId") || "";                 // the one FFXIV account auto-sent
let xlRun: AbortController | null = null;
let filter: "totp" | "login" = "totp";
let pendingLink: string | null = null;                                         // an otpauth:// link waiting for the vault to open
let linksOn = localStorage.getItem("vault.links") !== "off";                  // Windows: Vault opens otpauth:// links
const copiedUntil = new Map<string, number>();                                // row id -> when "Copied" goes back to the code

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
  refreshAutofill();
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
  el.textContent = state === "synced" ? "Synced" : state === "offline" ? `Offline - saved on ${here}` : `Signed out - saved on ${here}`;
  el.style.setProperty("--state", state === "synced" ? "var(--teal)" : "var(--orange)");
}

// ------------------------------------------------------------------ sign in
// Vault's mark, drawn from a grid like Hourglass's: a gold lock with a red keyhole.
const LOCK = ["..#####..", ".##...##.", ".#.....#.", ".#.....#.", "ooooooooo", "oooxxxooo", "oooxxxooo", "ooooxoooo", "ooooxoooo", "ooooooooo"];
function pixelLock(cell = 7): string {
  const rects = LOCK.flatMap((row, y) => [...row].map((ch, x) => (ch === "." ? "" :
    `<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="${ch === "x" ? "var(--accent)" : "var(--gold)"}"/>`))).join("");
  return `<svg class="pixel" width="${9 * cell}" height="${10 * cell}" viewBox="0 0 ${9 * cell} ${10 * cell}" aria-hidden="true">${rects}</svg>`;
}

let signedInWith: { email: string; password: string } | null = null;   // only to turn on quick unlock this session

/** Signed out (or locked): sign in, create an account, or get a reset link - the same screen as
 *  Hourglass and Jukebox. On a phone with quick unlock on, the fingerprint prompt comes up first. */
function signInScreen(message = "", mode: "signin" | "create" | "forgot" = "signin", tryQuick = true) {
  vault = null;
  session = null;
  signedInWith = null;
  stopAutoXl();
  platform.setAutofill(null);
  const last = file?.email || localStorage.getItem("vault.email") || "";
  const quick = mode === "signin" && platform.quickUnlock.state() === "saved";
  const create = mode === "create", forgot = mode === "forgot";
  app.replaceChildren(h(`
    <div class="login">
      ${pixelLock()}
      <div class="title">Vault</div>
      <div class="tag">Your passwords, 2FA codes and passkeys, on every device.</div>
      <form class="card" novalidate>
        ${forgot ? `<div class="lead">Forgot your password? Enter your email and we'll send you a link to choose a new one.</div>`
          : `<div class="switch"><button type="button" data-mode="signin" class="${create ? "" : "on"}">Sign in</button><button type="button" data-mode="create" class="${create ? "on" : ""}">Create account</button></div>`}
        <label class="lab" for="em">Email</label>
        <input id="em" class="m-field" type="email" autocomplete="username" inputmode="email" autocapitalize="off" value="${esc(last)}">
        ${forgot ? "" : `<label class="lab" for="pw">Password</label><input id="pw" class="m-field" type="password" autocomplete="${create ? "new-password" : "current-password"}">`}
        ${create ? `<label class="lab" for="pw2">Confirm password</label><input id="pw2" class="m-field" type="password" autocomplete="new-password">` : ""}
        ${!create && !forgot ? `<a href="#" class="forgot" id="toForgot">Forgot password?</a>` : ""}
        ${forgot ? "" : `<div class="hint">${create ? "At least 8 characters. Your vault is sealed with it on your devices; the server only ever keeps the sealed copy." : "The same account as Hourglass and Jukebox."}</div>`}
        <div class="notice" id="notice"></div>
        <div class="err" id="err">${esc(message)}</div>
        ${quick ? `<button class="m-btn primary" type="button" id="quick">&#xf023; Unlock with fingerprint or screen lock</button>` : ""}
        <button class="m-btn ${quick ? "" : "primary"}" type="submit">${forgot ? "Send reset link" : create ? "Create account" : "Sign in"}</button>
      </form>
      <div class="other">${forgot ? "Remembered it? " : create ? "Already have an account? " : "New here? "}<a href="#" id="flip">${forgot || create ? "Sign in" : "Create an account"}</a></div>
    </div>`));
  const form = $<HTMLFormElement>("form", app);
  const err = (t: string) => { $("#err").textContent = t; $("#notice").textContent = ""; };
  app.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => (b.onclick = () => signInScreen("", b.dataset.mode as "signin" | "create", false)));
  $("#toForgot")?.addEventListener("click", (e) => { e.preventDefault(); signInScreen("", "forgot", false); });
  $("#flip").onclick = (e) => { e.preventDefault(); signInScreen("", forgot || create ? "signin" : "create", false); };
  if (!platform.isMobile) $<HTMLInputElement>(last && !forgot ? "#pw" : "#em").focus();

  const quickUnlock = async () => {
    const r = await platform.quickUnlock.open();
    if (!r.email || !r.password) {
      if (r.error === "changed") err("Your phone's fingerprints changed, so quick unlock was turned off. Sign in with your password to turn it on again.");
      else if (r.error && r.error !== "cancelled") err(r.error);
      return;
    }
    const b = $<HTMLButtonElement>("#quick");
    if (b) { b.disabled = true; b.textContent = "Opening…"; }
    try { await openAccount(r.email, r.password); }
    catch (e) {
      if (e instanceof account.SignInError) { platform.quickUnlock.clear(); signInScreen("Your password changed. Sign in with the new one to turn quick unlock on again.", "signin", false); }
      else { if (b) { b.disabled = false; b.innerHTML = "&#xf023; Unlock with fingerprint or screen lock"; } err((e as Error).message); }
    }
  };
  $("#quick")?.addEventListener("click", () => void quickUnlock());
  if (quick && tryQuick) void quickUnlock();

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const email = $<HTMLInputElement>("#em").value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err("Enter a valid email address.");
    const btn = $<HTMLButtonElement>("button[type=submit]", form);
    const label = btn.textContent ?? "";
    if (forgot) {
      btn.disabled = true; btn.textContent = "Sending…";
      try { await account.forgot(email); err(""); $("#notice").textContent = `If ${email} has an account, a reset link is on its way. Open it on any device; it works for one hour. Afterwards your recovery kit opens your vault.`; }
      catch (e) { err((e as Error).message); }
      btn.disabled = false; btn.textContent = label;
      return;
    }
    const pw = $<HTMLInputElement>("#pw").value;
    if (pw.length < 8) return err("The password needs at least 8 characters.");
    if (create && $<HTMLInputElement>("#pw2").value !== pw) return err("The passwords do not match.");
    btn.disabled = true; btn.textContent = create ? "Creating account…" : "Signing in…";
    await new Promise((r) => setTimeout(r, 30)); // let the label paint before Argon2 runs
    try {
      await openAccount(email, pw, create);
    } catch (e) {
      btn.disabled = false; btn.textContent = label;
      err((e as Error).message);
    }
  };
}

/** On a phone, once: offer to unlock with the fingerprint or screen lock from now on. */
async function offerQuickUnlock() {
  if (!signedInWith || platform.quickUnlock.state() !== "ready" || localStorage.getItem("vault.quickAsked")) return;
  localStorage.setItem("vault.quickAsked", "1");
  if (!confirm("Unlock Vault with your fingerprint or screen lock from now on, instead of typing your password?")) return;
  const r = await platform.quickUnlock.save(signedInWith.email, signedInWith.password);
  toast(r.ok ? "Quick unlock is on" : r.error === "cancelled" ? "Quick unlock stays off" : `Couldn't turn it on: ${r.error}`);
}

/** Sign in, then: the server's vault (with this PC's offline changes merged in), this PC's vault
 *  uploaded, or a brand-new vault for an account that has none yet. */
async function openAccount(email: string, pw: string, create = false) {
  localStorage.setItem("vault.email", email);
  const localFile = file && file.email === email ? file : null;
  signedInWith = { email, password: pw };
  try {
    session = create ? await account.register(email, pw) : await account.signIn(email, pw);
  } catch (e) {
    if (e instanceof account.Offline && localFile) {
      vault = unlockOrNull(localFile, pw);
      if (!vault) throw new Error(`That password doesn't open the copy on ${here}.`);
      homeScreen();
      setSyncState("offline");
      return;
    }
    throw e instanceof account.Offline ? new Error(`${e.message}, and there is no copy of this vault on ${here} yet.`) : e;
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
type PasskeyRow = Item & { data: PasskeyItem };
const passkeys = () => (vault?.list("passkey") ?? []) as PasskeyRow[];

/** Every one-time code: 2FA entries, and each login's own code (as a row with the login's id). */
const otps = () => (vault ? allCodes(vault) : []) as TotpRow[];
const standaloneCodes = () => (vault?.list("totp") ?? []) as TotpRow[];
const logins = () => (vault?.list("login") ?? []) as LoginRow[];
const groupCode = (c: string) => (c.length === 6 ? `${c.slice(0, 3)} ${c.slice(3)}` : c.length === 8 ? `${c.slice(0, 4)} ${c.slice(4)}` : c);
const nameOf = (i: TotpRow) => i.data.label || i.data.otp.issuer || i.data.otp.account || "Untitled";

/** A login's one-time code: its own, else (older vaults) the code it is linked to or that matches it. */
function codeFor(login: LoginItem): OtpEntry | undefined {
  if (login.otp) return login.otp;
  if (login.totpId) { const it = vault?.get(login.totpId); if (it?.data.type === "totp") return it.data.otp; }
  return matchTotp(login, standaloneCodes().map((i) => i.data))?.otp;
}

async function copy(text: string, said: string, clearAfter = 0): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); } catch { toast("Couldn't copy - the clipboard is busy, try again"); return false; }
  toast(said);
  if (clearAfter) setTimeout(async () => { try { if ((await navigator.clipboard.readText()) === text) await navigator.clipboard.writeText(""); } catch { /* clipboard not readable: leave it */ } }, clearAfter);
  return true;
}

function homeScreen() {
  app.replaceChildren(h(`
    <div class="top">
      <div class="brand"><span class="logo"></span> Vault</div>
      <div class="m-sync sync-line grow" id="sync" style="--state: var(--faint)">${session ? "Syncing…" : `Offline - saved on ${here}`}</div>
      <button class="m-btn subtle compact" id="settings" title="Settings">&#xf013;<span class="lbl"> Settings</span></button>
    </div>
    <div class="bar">
      <div class="m-seg filter grow" id="filter"></div>
      <button class="m-btn primary compact" id="import" title="${filter === "totp" ? "Add or import 2FA codes" : "Add or import logins"}">&#xf019;<span class="lbl"> Import</span></button>
    </div>
    <input class="m-field search" id="q" placeholder="Search" value="${esc(query)}">
    <div id="list"></div>`));
  $("#settings").onclick = () => settingsModal();
  $("#import").onclick = () => (filter === "totp" ? addCodeModal() : importModal());
  const seg = $("#filter");
  for (const [v, label] of [["totp", "2FA codes"], ["login", "Passwords"]] as const) {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = filter === v ? "on" : "";
    b.onclick = () => { filter = v; homeScreen(); };
    seg.append(b);
  }
  $<HTMLInputElement>("#q").oninput = (e) => { query = (e.target as HTMLInputElement).value; renderList(); };
  renderList();
  if (autoXlId) startAutoXl();
  if (session) void sync();
  void unlocked();
}

/** Each time the vault opens: Android autofill gets its list, and a link Vault was opened with is offered. */
async function unlocked() {
  await mergeCodes();
  void offerQuickUnlock();
  refreshAutofill();
  const link = pendingLink ?? (await platform.takeLaunchLink());
  pendingLink = null;
  if (link) offerLink(link);
}

/** One entry per account: codes that belong to a login move into it (and sync everywhere). */
async function mergeCodes() {
  if (!vault) return;
  const moved = mergeCodesIntoLogins(vault);
  if (!moved.size) return;
  if (moved.has(autoXlId)) { autoXlId = moved.get(autoXlId)!; localStorage.setItem("vault.autoXlId", autoXlId); }
  await save();
  renderList();
  toast(`${moved.size} 2FA code${moved.size === 1 ? "" : "s"} joined ${moved.size === 1 ? "its login" : "their logins"}: one entry each now`);
}

// ------------------------------------------------------------------ settings
const lockLabel = (m: number) => (!m ? "Never" : m >= 1440 ? "After a day" : m >= 60 ? `After ${m / 60} hour${m === 60 ? "" : "s"}` : `After ${m} min`);

function settingsModal() {
  const back = h(`
    <div class="backdrop">
      <div class="m-modal modal settings">
        <header>Settings <button class="m-btn subtle compact" type="button" data-close title="Close">&#xf00d;</button></header>
        <div class="content">
          <div class="set">
            <div><b>Account</b><span>${esc([file?.email || localStorage.getItem("vault.email") || "", session ? "" : "offline"].filter(Boolean).join(" · "))}</span></div>
            <button class="m-btn compact" id="lockNow">Lock now</button>
          </div>
          <div class="set">
            <div><b>Lock automatically</b><span>Sign out of Vault after this long without use.${platform.isMobile ? "" : " Closing the window keeps Vault open in the tray; Quit from the tray icon locks it."}</span></div>
            <select class="m-field" id="lockAfter">${LOCK_CHOICES.map((m) => `<option value="${m}" ${m === lockAfterMin ? "selected" : ""}>${lockLabel(m)}</option>`).join("")}</select>
          </div>
          <div class="set">
            <div><b>Recovery kit</b><span>The only way back into your vault if your account password is reset. Making a new one stops the old one working.</span></div>
            <button class="m-btn compact" id="kit">New kit</button>
          </div>
          <div class="set" ${platform.isMobile ? "hidden" : ""}>
            <div><b>Browser extension</b><span>Vault for Chrome, Brave and Edge signs in with this same account and syncs on its own (this app doesn't need to be open). It fills logins and 2FA codes, saves new logins and passkeys, and signs in with passkeys; they show up here too.</span></div>
          </div>
          ${platform.isDesktopApp ? `
          <div class="set">
            <div><b>Only Vault fills passwords</b><span>Brave, Chrome and Edge stop suggesting and filling the passwords they saved themselves, and their address and card autofill. Windows asks for administrator approval once. Nothing is deleted; the browser says it is "managed" while this is on. Restart the browser after changing it. Move its old passwords in first: export a .csv from the browser, then Import here.<br><span id="lockdownState"></span></span></div>
            <span class="m-switch" id="lockdown" role="switch" tabindex="0"></span>
          </div>
          <div class="set">
            <div><b>Open 2FA setup links</b><span>When a site offers "Add to authenticator app" (an otpauth:// link), it opens in Vault.</span></div>
            <span class="m-switch ${linksOn ? "on" : ""}" id="links" role="switch" tabindex="0"></span>
          </div>` : ""}
          ${platform.hasAutofill ? `
          <div class="set">
            <div><b>Autofill in apps and browsers</b><span id="afState"></span></div>
            <button class="m-btn compact" id="afSet">Choose Vault</button>
          </div>` : ""}
          ${platform.quickUnlock.state() !== "unavailable" ? `
          <div class="set">
            <div><b>Unlock with fingerprint or screen lock</b><span>Your password is sealed by the phone and only opens after your fingerprint, face or the phone's PIN.</span></div>
            <span class="m-switch ${platform.quickUnlock.state() === "saved" ? "on" : ""}" id="quickSw" role="switch" tabindex="0"></span>
          </div>` : ""}
        </div>
      </div>
    </div>`).firstElementChild as HTMLElement;
  document.body.append(back);
  const close = () => back.remove();
  back.querySelectorAll<HTMLElement>("[data-close]").forEach((b) => (b.onclick = close));
  back.onclick = (e) => { if (e.target === back) close(); };
  const qs = $("#quickSw", back);
  if (qs) qs.onclick = async () => {
    if (qs.classList.contains("on")) { platform.quickUnlock.clear(); qs.classList.remove("on"); return toast("Quick unlock is off"); }
    if (!signedInWith) return toast("Lock Vault and sign in with your password once, then turn this on");
    const r = await platform.quickUnlock.save(signedInWith.email, signedInWith.password);
    qs.classList.toggle("on", r.ok);
    toast(r.ok ? "Quick unlock is on" : r.error === "cancelled" ? "Quick unlock stays off" : `Couldn't turn it on: ${r.error}`);
  };
  const ld = $("#lockdown", back);
  if (ld) {
    // The switch shows what the registry says, not what was last clicked.
    const showLd = async () => {
      const st = await platform.browserLockdownState().catch(() => [] as [string, boolean][]);
      const on = st.length > 0 && st.every(([, off]) => off);
      ld.classList.toggle("on", on);
      $("#lockdownState", back).textContent = st.length ? st.map(([n, off]) => `${n}: ${off ? "Vault only" : "its own password manager is on"}`).join(" · ") : "No Brave, Chrome or Edge on this PC.";
      return on;
    };
    void showLd();
    ld.onclick = async () => {
      const turnOn = !ld.classList.contains("on");
      try {
        const changed = await platform.setBrowserLockdown(turnOn);
        toast(changed.length ? `${changed.join(", ")}: ${turnOn ? "only Vault fills passwords" : "own password manager back on"} - restart the browser` : "No Brave, Chrome or Edge found");
      } catch (e) { toast(String(e)); }
      await showLd();
    };
  }
  const sw = $("#links", back);
  if (sw) {
    sw.onclick = async () => {
      linksOn = !linksOn;
      localStorage.setItem("vault.links", linksOn ? "on" : "off");
      sw.classList.toggle("on", linksOn);
      await platform.setLinkHandler(linksOn).catch(() => toast("Couldn't change the link setting"));
    };
  }
  const af = $("#afState", back);
  if (af) {
    const showAf = () => {
      let st = "unsupported", who = "", keys = false;
      try { st = platform.autofillState(); who = platform.autofillProvider(); keys = platform.passkeysOnVault(); } catch { /* keep the row usable */ }
      af.textContent = st === "on" ? `On: Vault offers your logins, strong new passwords and 2FA codes (under the field and in the keyboard) when you sign in to apps and websites, and saves new logins.${keys ? " Passkeys too." : " Passkeys: pick Vault as the preferred service too."}`
        : st === "off" ? `${who ? `${who} fills passwords now. ` : ""}Pick Vault under Passwords, passkeys & autofill so it fills logins, passkeys and 2FA codes everywhere. In Chrome, also turn on Settings > Autofill services > Autofill using another service.`
        : "This Android version has no autofill service setting.";
      $<HTMLButtonElement>("#afSet", back).textContent = st === "on" ? "Change" : "Choose Vault";
    };
    $("#afSet", back).onclick = () => platform.openAutofillSettings();
    showAf();
    addEventListener("focus", showAf, { once: true });
  }
  $<HTMLSelectElement>("#lockAfter", back).onchange = (e) => {
    lockAfterMin = Number((e.target as HTMLSelectElement).value) || 0;
    localStorage.setItem("vault.lockAfterMin", String(lockAfterMin));
    toast(lockAfterMin ? `Vault locks after ${lockLabel(lockAfterMin).replace("After ", "")} without use` : "Vault stays open until you quit or lock it");
  };
  $("#lockNow", back).onclick = () => { close(); signInScreen("", "signin", false); };
  $("#kit", back).onclick = async () => {
    if (!confirm("Make a new recovery kit? Your current one stops working, so write the new one down right away.")) return;
    const code = vault!.newRecoveryKit();
    await save();
    close();
    recoveryScreen(code, true);
  };
}

const matchesQuery = (hay: string) => { const q = query.trim().toLowerCase(); return !q || hay.toLowerCase().includes(q); };

function renderList() {
  const list = $("#list");
  if (!list) return;
  const pinFirst = (af: boolean, bf: boolean) => (bf ? 1 : 0) - (af ? 1 : 0);
  const ls = logins().sort((a, b) => pinFirst(!!a.data.favorite, !!b.data.favorite) || a.data.name.localeCompare(b.data.name));
  const ts = otps().sort((a, b) => pinFirst(!!a.data.favorite, !!b.data.favorite) || nameOf(a).localeCompare(nameOf(b)));
  const rows: HTMLElement[] = [];
  if (filter === "login") for (const i of ls) if (matchesQuery(`${i.data.name} ${i.data.username} ${i.data.urls.join(" ")}`)) rows.push(loginRow(i));
  const ps = passkeys().sort((a, b) => (a.data.rpName || a.data.rpId).localeCompare(b.data.rpName || b.data.rpId));
  if (filter === "login") for (const i of ps) if (matchesQuery(`${i.data.rpName ?? ""} ${i.data.rpId} ${i.data.username}`)) rows.push(passkeyRow(i));
  const ff = new Set(ffxivEntries(ts.map((i) => i.data.otp)));
  if (filter === "totp") for (const i of ts) if (matchesQuery(`${nameOf(i)} ${i.data.otp.issuer} ${i.data.otp.account}`)) rows.push(codeRow(i, ff.has(i.data.otp)));

  if (!rows.length) {
    const shown = filter === "totp" ? ts.length : ls.length + ps.length;
    const msg = shown ? "Nothing matches your search." : filter === "totp" ? "No 2FA codes yet." : "No passwords yet.";
    const hint = shown ? "" : filter === "totp" ? `Scan a QR code${platform.isDesktopApp ? " on your screen" : platform.isMobile ? " with the camera" : ""}, type a setup key, or import from Google Authenticator.` : "Add a login, or import passwords from your browser or another app.";
    list.replaceChildren(h(`<div class="empty"><div>${msg}</div>${hint ? `<div class="faint">${hint}</div>` : ""}
      ${shown ? "" : filter === "totp" ? `<button class="m-btn primary" id="e2">&#xf023; Add 2FA</button>` : `<button class="m-btn primary" id="e1">&#xf084; New login</button>`}</div>`));
    $("#e1")?.addEventListener("click", () => loginEditor(null));
    $("#e2")?.addEventListener("click", () => addCodeModal());
    return;
  }
  closeMenu();
  list.replaceChildren(...rows);
  tick();
}

/** A passkey made by the Vault browser extension (or on the phone): the site's name, the account, delete. */
function passkeyRow(i: PasskeyRow): HTMLElement {
  const d = i.data;
  const row = h(`
    <div class="item login passkey">
      <span class="tileslot"></span>
      ${whoLines(d.username || d.displayName || "", `Passkey · ${d.rpName || d.rpId}`, false)}
      <div class="tools"><span class="kindtag">PASSKEY</span><button class="m-btn subtle compact" data-del title="Delete">&#xf1f8;</button></div>
    </div>`).firstElementChild as HTMLElement;
  row.querySelector(".tileslot")!.replaceWith(entryIcon(d.rpName || d.rpId, siteKey(d.rpId)));
  row.title = `Signs you in on ${d.rpId}${d.created ? ` · saved ${new Date(d.created).toLocaleDateString()}` : ""}. Passkeys are used by the Vault browser extension and by Vault on Android.`;
  row.querySelector<HTMLElement>("[data-del]")!.onclick = async () => {
    if (!confirm(`Delete the passkey for ${d.rpId} (${d.username})? Make sure you can still sign in there another way.`)) return;
    vault!.remove(i.id); await save(); renderList();
  };
  return row;
}

async function togglePin(i: LoginRow | TotpRow) {
  const item = vault!.get(i.id)!;      // a login's own code pins the login
  vault!.update(i.id, { ...item.data, favorite: !(item.data as LoginItem).favorite } as LoginItem);
  await save();
  renderList();
}

/** Copy a 2FA code: the toast names the account, and the code itself reads "Copied" for 3 seconds. */
async function copyCode(rowId: string, otp: OtpEntry, who: string) {
  if (!(await copy((await totp(otp)).code, `Code copied · ${who}`))) return;
  copiedUntil.set(rowId, Date.now() + 3000);
  tick();
  setTimeout(tick, 3050);
}

/** A row's menu, from a right-click point or next to its ⋯ button (copy, pin, edit, delete). */
function rowMenu(i: LoginRow | TotpRow, x: number, y: number) {
  const pin = { label: i.data.favorite ? "Unpin" : "Pin to top", icon: "&#xf08d;", checked: !!i.data.favorite, onClick: () => void togglePin(i) };
  const del = {
    label: "Delete", icon: "&#xf1f8;", danger: true, onClick: async () => {
      const name = i.data.type === "login" ? i.data.name : nameOf(i as TotpRow);
      if (!confirm(`Delete ${name}? Make sure you can still sign in another way.`)) return;
      vault!.remove(i.id); await save(); renderList();
    },
  };
  if (i.data.type === "login") {
    const d = i.data, linked = codeFor(d), who = d.username || d.name;
    const copies: MenuSection["items"] = [];
    if (d.password) copies.push({ label: "Copy password", icon: "&#xf084;", onClick: () => void copy(d.password, `Password copied · ${who} (clears in 30s)`, 30_000) });
    if (d.username) copies.push({ label: "Copy username", icon: "&#xf007;", onClick: () => void copy(d.username, `Username copied · ${d.name}`) });
    if (linked) copies.push({ label: "Copy 2FA code", icon: "&#xf023;", onClick: () => void copyCode(i.id, linked, who) });
    openMenu(x, y, [{ title: d.name, items: copies }, { items: [pin, { label: "Edit", icon: "&#xf044;", onClick: () => loginEditor(i as LoginRow) }] }, { items: [del] }]);
  } else if (i.data.inLogin) {
    const t = i as TotpRow, owner = vault!.get(t.id) as LoginRow;
    openMenu(x, y, [{ title: nameOf(t), items: [{ label: "Copy code", icon: "&#xf0c5;", onClick: () => void copyCode(t.id, t.data.otp, t.data.otp.account || nameOf(t)) }] },
      { items: [pin, { label: "Edit login", icon: "&#xf044;", onClick: () => loginEditor(owner) }] },
      { items: [{ label: "Remove the code from this login", icon: "&#xf1f8;", danger: true, onClick: async () => {
        if (!confirm(`Remove the 2FA code from ${owner.data.name}? Make sure you can still sign in another way.`)) return;
        const { otp: _gone, ...rest } = owner.data;
        vault!.update(owner.id, rest); await save(); renderList();
      } }] }]);
  } else {
    const t = i as TotpRow;
    openMenu(x, y, [{ title: nameOf(t), items: [{ label: "Copy code", icon: "&#xf0c5;", onClick: () => void copyCode(t.id, t.data.otp, t.data.otp.account || nameOf(t)) }] }, { items: [pin] }, { items: [del] }]);
  }
}

/** The two lines next to an icon: the account big, the service under it. */
const whoLines = (big: string, small: string, pinned: boolean) =>
  `<div class="txt"><b>${pinned ? '<span class="pin">&#xf08d;</span> ' : ""}${esc(big || small)}</b>${big && small ? `<span>${esc(small)}</span>` : ""}</div>`;

function loginRow(i: LoginRow): HTMLElement {
  const d = i.data;
  const host = d.urls[0] ? hostOf(d.urls[0]) : "";
  const linked = codeFor(d);
  const small = host && host !== d.name.toLowerCase() ? `${d.name} · ${host}` : d.name;
  const row = h(`
    <div class="item login" data-login="${i.id}">
      <span class="tileslot"></span>
      ${whoLines(d.username, small, !!d.favorite)}
      <div class="tools">
        <button class="m-btn subtle compact" data-edit title="Edit">&#xf044;</button>
        <button class="m-btn subtle compact" data-menu title="More">&#xf142;</button>
      </div>
      <div class="actions">
        ${d.username ? `<button class="m-btn subtle compact" data-cuser>&#xf007; User</button>` : ""}
        ${d.password ? `<button class="m-btn subtle compact" data-cpass>&#xf084; Password</button>` : ""}
        ${linked ? `<button class="mini" title="Copy the 2FA code" data-ccode><span class="mono" data-code>······</span><span class="m-level mini-bar"><i data-bar></i></span></button>` : ""}
      </div>
    </div>`).firstElementChild as HTMLElement;
  row.querySelector(".tileslot")!.replaceWith(entryIcon(d.name, siteOf({ urls: d.urls, name: d.name })));
  const who = d.username || d.name;
  row.querySelector<HTMLElement>("[data-cuser]")?.addEventListener("click", () => void copy(d.username, `Username copied · ${d.name}`));
  row.querySelector<HTMLElement>("[data-cpass]")?.addEventListener("click", () => void copy(d.password, `Password copied · ${who} (clears in 30s)`, 30_000));
  row.querySelector<HTMLElement>("[data-ccode]")?.addEventListener("click", () => { if (linked) void copyCode(i.id, linked, who); });
  row.querySelector<HTMLElement>("[data-edit]")!.onclick = () => loginEditor(i);
  row.querySelector<HTMLElement>("[data-menu]")!.onclick = (e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); rowMenu(i, r.left, r.bottom + 4); };
  row.oncontextmenu = (e) => { e.preventDefault(); rowMenu(i, e.clientX, e.clientY); };
  return row;
}

/** The site a 2FA code belongs to: a linked login's address when there is one, else its service name. */
function siteForCode(i: TotpRow): string {
  const own = i.data.inLogin ? (vault?.get(i.id) as LoginRow | undefined) : undefined;
  if (own?.data.urls.length) return siteOf({ urls: own.data.urls, name: own.data.name });
  const login = logins().find((l) => l.data.totpId === i.id) ?? logins().find((l) => !l.data.totpId && matchTotp(l.data, [i.data]));
  return siteOf(login?.data.urls.length ? { urls: login.data.urls } : { issuer: i.data.otp.issuer, name: i.data.label });
}

function codeRow(i: TotpRow, isFf: boolean): HTMLElement {
  const auto = isFf && autoXlId === i.id;
  const row = h(`
    <div class="code-row ${isFf ? "ff" : ""}" data-id="${i.id}">
      <span class="tileslot"></span>
      ${whoLines(i.data.otp.account, nameOf(i), !!i.data.favorite)}
      <div class="code" data-code>······</div>
      <button class="m-btn subtle compact menu" data-menu title="More">&#xf142;</button>
      <div class="m-level"><i data-bar></i></div>
      ${isFf ? `<div class="actions">
        <button class="m-btn compact" data-xl>&#xf1d8; Send to XIVLauncher</button>
        <label class="auto" title="Send this account's code by itself whenever XIVLauncher asks (one account at a time)"><span class="m-switch ${auto ? "on" : ""}" data-auto></span> Auto-send</label>
      </div>` : ""}
    </div>`).firstElementChild as HTMLElement;
  row.querySelector(".tileslot")!.replaceWith(entryIcon(nameOf(i), siteForCode(i)));
  row.onclick = (ev) => {
    if ((ev.target as HTMLElement).closest("button, .auto")) return;
    void copyCode(i.id, i.data.otp, i.data.otp.account || nameOf(i));
  };
  row.querySelector<HTMLElement>("[data-menu]")!.onclick = (e) => { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); rowMenu(i, r.left, r.bottom + 4); };
  row.oncontextmenu = (e) => { e.preventDefault(); rowMenu(i, e.clientX, e.clientY); };
  row.querySelector<HTMLElement>("[data-xl]")?.addEventListener("click", () => sendOnce(i.data.otp, i.data.otp.account || nameOf(i)));
  row.querySelector<HTMLElement>(".auto")?.addEventListener("click", (e) => {
    e.preventDefault();
    autoXlId = autoXlId === i.id ? "" : i.id;
    localStorage.setItem("vault.autoXlId", autoXlId);
    document.querySelectorAll<HTMLElement>(".code-row [data-auto]").forEach((s) => s.classList.toggle("on", s.closest<HTMLElement>(".code-row")!.dataset.id === autoXlId));
    stopAutoXl();
    if (autoXlId) startAutoXl();
    toast(autoXlId ? `Auto-send on for ${i.data.otp.account || nameOf(i)}` : "Auto-send is off");
  });
  return row;
}

async function tick() {
  const now = Date.now();
  for (const row of document.querySelectorAll<HTMLElement>(".code-row")) {
    const item = vault?.get(row.dataset.id!);
    const otp = item?.data.type === "totp" ? item.data.otp : item?.data.type === "login" ? item.data.otp : undefined;
    if (!otp) continue;
    paintCode(row, await totp(otp, now), otp.period, (copiedUntil.get(row.dataset.id!) ?? 0) > now);
  }
  for (const row of document.querySelectorAll<HTMLElement>(".login[data-login]")) {
    const item = vault?.get(row.dataset.login!);
    if (!item || item.data.type !== "login") continue;
    const otp = codeFor(item.data);
    if (otp) paintCode(row, await totp(otp, now), otp.period, (copiedUntil.get(row.dataset.login!) ?? 0) > now);
  }
}
function paintCode(row: HTMLElement, r: { code: string; remaining: number }, period: number, copied: boolean) {
  const el = row.querySelector<HTMLElement>("[data-code]");
  if (!el) return;
  el.textContent = copied ? "Copied" : groupCode(r.code);
  el.classList.toggle("copied", copied);
  el.classList.toggle("low", !copied && r.remaining <= 5);
  const bar = row.querySelector<HTMLElement>("[data-bar]");
  if (bar) { bar.style.setProperty("--v", `${(r.remaining / period) * 100}%`); bar.parentElement!.classList.toggle("full", r.remaining <= 5); }
}

// ------------------------------------------------------------------ login editor
function loginEditor(existing: LoginRow | null) {
  const d: LoginItem = existing ? { ...existing.data } : { type: "login", name: "", urls: [], username: "", password: "", notes: "" };
  const codes = standaloneCodes();
  let otp: OtpEntry | undefined = codeFor(d);
  const fromLink = !d.otp && otp ? (d.totpId ?? standaloneCodes().find((c) => c.data.otp === otp)?.id) : undefined;   // an older separate code
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
          <label class="lab">One-time code (2FA)</label>
          <div id="otpBox" class="otpbox"></div>
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
  // The login's code: shown with Remove, or a setup key / link to add, or one of the separate 2FA codes to move in.
  let moveIn = fromLink ?? "";
  const otpBox = $("#otpBox", back);
  const showOtp = () => {
    if (otp) {
      otpBox.replaceChildren(h(`<div class="pw"><span class="grow otpnow" data-otpnow></span><span class="faint">${esc([otp.issuer, otp.account].filter(Boolean).join(" · "))}</span><button class="m-btn subtle compact" type="button" id="otpRm">Remove</button></div>`));
      const paint = async () => { const el = otpBox.querySelector<HTMLElement>("[data-otpnow]"); if (el && otp) el.textContent = groupCode((await totp(otp)).code); };
      void paint();
      $("#otpRm", otpBox).onclick = () => { otp = undefined; moveIn = ""; showOtp(); };
      return;
    }
    otpBox.replaceChildren(h(`<div class="otpadd"><input class="m-field key" id="otpKey" placeholder="Setup key (GHBE AHFH ...) or otpauth:// link" autocomplete="off" autocapitalize="characters" spellcheck="false"><div class="keystate" id="otpState"></div>
      ${codes.length ? `<select class="m-field" id="otpPick"><option value="">or use a saved 2FA code...</option>${codes.map((c) => `<option value="${c.id}">${esc(`${nameOf(c)} · ${c.data.otp.account}`)}</option>`).join("")}</select>` : ""}</div>`));
    const key = $<HTMLInputElement>("#otpKey", otpBox);
    key.oninput = () => {
      const v = key.value.trim();
      const k = /^otpauth/i.test(v) ? { ok: true, message: "A 2FA link ✓" } : checkKey(v);
      $("#otpState", otpBox).textContent = k.message;
      $("#otpState", otpBox).className = `keystate ${k.ok ? "ok" : k.message ? "bad" : ""}`;
    };
    $<HTMLSelectElement>("#otpPick", otpBox)?.addEventListener("change", (e) => {
      const c = codes.find((x) => x.id === (e.target as HTMLSelectElement).value);
      if (c) { otp = c.data.otp; moveIn = c.id; showOtp(); }
    });
  };
  showOtp();
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
    const username = $<HTMLInputElement>("#user", back).value.trim();
    const typed = back.querySelector<HTMLInputElement>("#otpKey")?.value.trim() ?? "";
    if (typed) {
      try {
        if (/^otpauth/i.test(typed)) { const r = importText(typed); if (!r.entries[0]) throw new Error(r.skipped[0] ?? "that link has no 2FA code"); otp = r.entries[0]; }
        else { const k = checkKey(typed); if (!k.ok) throw new Error(k.message); otp = normalizeEntry({ issuer: name, account: username, secret: k.clean }); }
      } catch (e) { return void ($("#result", back).textContent = `One-time code: ${(e as Error).message}`); }
    }
    const data: LoginItem = {
      type: "login",
      name,
      urls: $<HTMLInputElement>("#url", back).value.split(/[\s,]+/).filter(Boolean),
      username,
      password: pass.value,
      notes: $<HTMLTextAreaElement>("#notes", back).value,
      ...(otp ? { otp } : {}),
      ...(d.favorite ? { favorite: true } : {}),
    };
    if (existing) vault!.update(existing.id, data); else vault!.add(data);
    if (otp && moveIn && vault!.get(moveIn)?.data.type === "totp") vault!.remove(moveIn);   // the separate code is now part of this login
    await save();
    close();
    toast(existing ? `${name} saved` : `${name} added`);
  };
}

// ------------------------------------------------------------------ XIVLauncher
/** Send one account's code now. Auto-send (maybe for another account) pauses meanwhile so the two never race. */
async function sendOnce(entry: OtpEntry, who: string) {
  if (!platform.inApp) return toast("Sending to XIVLauncher works in the Vault app, not in a browser");
  stopAutoXl();
  toast(`Waiting for XIVLauncher's OTP box (${who})…`);
  const r = await sendWhenAsked(entry, { untilMs: 60_000, send: platform.xlSend });
  toast(r.sent ? `Code sent to XIVLauncher · ${who}` : "XIVLauncher didn't ask within a minute - is its OTP box open, with app support on?");
  if (autoXlId) startAutoXl();
}

/** Auto-send: whenever XIVLauncher asks, it gets the code of the one account chosen for it. */
function startAutoXl() {
  if (xlRun || !platform.inApp || !vault) return;
  const run = (xlRun = new AbortController());
  (async () => {
    while (!run.signal.aborted && vault) {
      const item = vault.get(autoXlId);
      if (!item || item.data.type !== "totp") break;
      const who = item.data.otp.account || nameOf(item as TotpRow);
      const r = await sendWhenAsked(item.data.otp, { untilMs: 60 * 60_000, everyMs: 1500, send: platform.xlSend, signal: run.signal });
      if (r.sent) { toast(`FFXIV code sent to XIVLauncher · ${who}`); await new Promise((ok) => setTimeout(ok, 45_000)); }
    }
  })();
}
function stopAutoXl() { xlRun?.abort(); xlRun = null; }

// ------------------------------------------------------------------ adding codes and importing
/** Adding one 2FA code: scan a QR code (the screen on Windows, the camera on a phone, or an image),
 *  or type the setup key a site shows under its QR code ("GHBE AHFH ADJA …"). */
function addCodeModal() {
  const back = h(`
    <div class="backdrop">
      <form class="m-modal modal add2fa">
        <header>Import a 2FA code <button class="m-btn subtle compact" type="button" data-close title="Close">&#xf00d;</button></header>
        <div class="content">
          <div class="scan">
            ${platform.isDesktopApp ? `<button class="m-btn primary" type="button" id="screen">&#xf108; Scan the screen</button>` : ""}
            ${platform.isMobile ? `<button class="m-btn primary" type="button" id="camera">&#xf030; Scan with the camera</button>` : ""}
            <button class="m-btn" type="button" id="pick">&#xf03e; From an image</button>
          </div>
          <div class="faint hint">${platform.isDesktopApp ? "Open the site's QR code, then Scan the screen: Vault steps aside for a moment and reads every QR code on your monitors. A screenshot works too (choose it, or paste it here with Ctrl+V)." : platform.isMobile ? "Point the camera at the QR code on the other screen, or choose a screenshot of it." : "Choose a screenshot of the QR code, or paste one here."}</div>
          <input type="file" id="files" accept="image/*" multiple hidden>
          <div class="m-section">or type the setup key</div>
          <label class="lab" for="key">Setup key</label>
          <input class="m-field key" id="key" placeholder="e.g. GHBE AHFH ADJA 7KQ2 …" autocomplete="off" autocapitalize="characters" spellcheck="false">
          <div class="keystate" id="keystate"></div>
          <div class="row2">
            <div><label class="lab" for="iss">Service</label><input class="m-field" id="iss" placeholder="e.g. GitHub"></div>
            <div><label class="lab" for="acc">Account</label><input class="m-field" id="acc" placeholder="you@example.com"></div>
          </div>
          <details class="more"><summary>Options (only if the site says so)</summary>
            <div class="row3">
              <div><label class="lab">Digits</label><select class="m-field" id="digits"><option>6</option><option>8</option><option>7</option><option>5</option></select></div>
              <div><label class="lab">Every</label><select class="m-field" id="period"><option value="30">30 s</option><option value="60">60 s</option><option value="15">15 s</option></select></div>
              <div><label class="lab">Algorithm</label><select class="m-field" id="algo"><option>SHA1</option><option>SHA256</option><option>SHA512</option></select></div>
            </div>
          </details>
          <div class="m-section">or paste a link</div>
          <input class="m-field" id="link" placeholder="otpauth://totp/… or otpauth-migration://…" autocomplete="off" spellcheck="false">
          <div class="m-section">from another app</div>
          <div class="faint hint">Google Authenticator: Transfer accounts, then scan or choose its QR codes above (all accounts at once).</div>
          <button class="m-btn" type="button" id="more">&#xf084; Passwords from a .csv, or many links at once</button>
          <div class="result" id="result"></div>
        </div>
        <footer><span class="grow"></span><button class="m-btn" type="button" data-close>Close</button><button class="m-btn primary" type="submit">Add</button></footer>
      </form>
    </div>`).firstElementChild as HTMLElement;
  document.body.append(back);
  const onPaste = async (e: ClipboardEvent) => {
    const img = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
    if (!img) return;
    e.preventDefault();
    const t = await readQr(img);
    t ? await fromTexts([t]) : report(["The pasted image has no readable QR code."]);
  };
  const close = () => { back.remove(); document.removeEventListener("paste", onPaste); renderList(); };
  back.querySelectorAll<HTMLElement>("[data-close]").forEach((b) => (b.onclick = close));
  back.onclick = (e) => { if (e.target === back) close(); };
  const report = (lines: string[]) => ($("#result", back).textContent = lines.join("\n"));
  const fromTexts = async (texts: string[], unreadable: string[] = []) => {
    const r = await addCodes(importText(texts.join("\n")));
    report([r.added ? `Added ${r.names.join(", ")}.` : texts.length ? "Nothing new added." : "", r.already ? `${r.already} already in Vault.` : "",
      ...r.skipped.map((s) => `Skipped - ${s}`), ...unreadable].filter(Boolean));
    if (r.added && !r.skipped.length && !unreadable.length) { toast(`Added ${r.names.join(", ")}`); close(); }
  };
  document.addEventListener("paste", onPaste);

  $("#screen", back)?.addEventListener("click", async () => {
    report(["Looking at your screen…"]);
    try {
      const texts = await platform.scanScreen();
      if (!texts.length) return report(["No QR code found on screen. Make sure it's fully visible (not covered or scrolled away) and try again."]);
      await fromTexts(texts);
    } catch (e) { report([`Couldn't read the screen: ${String((e as Error)?.message ?? e)}`]); }
  });
  $("#camera", back)?.addEventListener("click", () => cameraScan((text) => void fromTexts([text])));
  $("#more", back).onclick = () => { close(); importModal(); };
  const files = $<HTMLInputElement>("#files", back);
  $("#pick", back).onclick = () => files.click();
  files.onchange = async () => {
    const texts: string[] = [], unreadable: string[] = [];
    for (const f of files.files ?? []) { const t = await readQr(f); t ? texts.push(t) : unreadable.push(`${f.name}: no QR code found`); }
    files.value = "";
    await fromTexts(texts, unreadable);
  };

  const key = $<HTMLInputElement>("#key", back);
  key.oninput = () => {
    const k = checkKey(key.value), st = $("#keystate", back);
    st.textContent = k.message;
    st.className = `keystate ${k.ok ? "ok" : k.message ? "bad" : ""}`;
  };

  $<HTMLFormElement>("form", back).onsubmit = async (ev) => {
    ev.preventDefault();
    const link = $<HTMLInputElement>("#link", back).value.trim();
    if (link) { await fromTexts([link]); $<HTMLInputElement>("#link", back).value = ""; return; }
    const k = checkKey(key.value);
    if (!key.value.trim()) return report(["Scan a QR code, type the setup key, or paste a link."]);
    if (!k.ok) return report([k.message]);
    const iss = $<HTMLInputElement>("#iss", back).value.trim(), acc = $<HTMLInputElement>("#acc", back).value.trim();
    if (!iss && !acc) return report(["Give it a service or an account name, so you can tell it apart."]);
    try {
      const e = normalizeEntry({
        issuer: iss, account: acc, secret: k.clean,
        digits: Number($<HTMLSelectElement>("#digits", back).value), period: Number($<HTMLSelectElement>("#period", back).value),
        algorithm: $<HTMLSelectElement>("#algo", back).value as Algorithm,
      });
      const r = await addCodes({ entries: [e], skipped: [] });
      if (r.added) { toast(`Added ${r.names[0]}`); close(); } else report(["That code is already in Vault."]);
    } catch (e) { report([(e as Error).message]); }
  };
  if (!platform.isMobile) key.focus();
}

/** A setup key as people type it: any case, spaces and dashes anywhere. Look-alike digits get a hint. */
function checkKey(text: string): { ok: boolean; clean: string; message: string } {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  if (!clean) return { ok: false, clean, message: "" };
  const bad = [...new Set(clean.replace(/[A-Z2-7]/g, ""))];
  if (bad.length) {
    const tips: Record<string, string> = { "0": "O", "1": "I", "8": "B" };
    const tip = bad.filter((c) => tips[c]).map((c) => `${tips[c]} for ${c}`);
    return { ok: false, clean, message: `Setup keys only use the letters A-Z and the digits 2-7, so ${bad.map((c) => `"${c}"`).join(" ")} can't be in one${tip.length ? ` (did you mean ${tip.join(", ")}?)` : "."}` };
  }
  if (base32Decode(clean).length < 10) return { ok: false, clean, message: `${clean.length} characters so far - setup keys are usually 16 or 32.` };
  return { ok: true, clean, message: `${clean.length} characters ✓` };
}

/** Phones: the camera fills the screen until it sees a QR code. */
async function cameraScan(found: (text: string) => void) {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false });
  } catch {
    return toast("Vault can't use the camera - allow it in Android's settings for Vault");
  }
  const view = h(`<div class="camera"><video playsinline muted></video><div class="frame"></div>
    <div class="cam-bar"><span>Point at the QR code</span><button class="m-btn" type="button">Cancel</button></div></div>`).firstElementChild as HTMLElement;
  document.body.append(view);
  const video = view.querySelector("video")!;
  video.srcObject = stream;
  await video.play().catch(() => {});
  const c = document.createElement("canvas");
  const g = c.getContext("2d", { willReadFrequently: true })!;
  let done = false;
  const stop = () => { done = true; stream.getTracks().forEach((t) => t.stop()); view.remove(); };
  view.querySelector("button")!.onclick = stop;
  const look = () => {
    if (done) return;
    if (video.videoWidth) {
      const scale = Math.min(1, 900 / Math.max(video.videoWidth, video.videoHeight));
      c.width = Math.round(video.videoWidth * scale);
      c.height = Math.round(video.videoHeight * scale);
      g.drawImage(video, 0, 0, c.width, c.height);
      const hit = jsQR(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: "attemptBoth" });
      if (hit?.data && /^otpauth(-migration)?:/i.test(hit.data)) { navigator.vibrate?.(40); stop(); return found(hit.data); }
    }
    setTimeout(look, 160);
  };
  look();
}

/** Importing from other apps: Google Authenticator's transfer QR codes, links, and password CSVs. */
function importModal() {
  const back = h(`
    <div class="backdrop">
      <form class="m-modal modal">
        <header>Import <button class="m-btn subtle compact" type="button" data-close title="Close">&#xf00d;</button></header>
        <div class="content">
          <div class="scan"><button class="m-btn primary" type="button" id="newLogin">&#xf067; New login</button><button class="m-btn" type="button" id="new2fa">&#xf023; New 2FA code</button></div>
          <div class="drop" id="pickCsv">&#xf084; Passwords from a .csv<br><span class="faint">Chrome, Brave, Edge, Firefox, Bitwarden, Apple Passwords, 1Password, LastPass - their 2FA keys come too</span></div>
          <input type="file" id="csv" accept=".csv,text/csv" hidden>
          <div class="drop" id="pick">&#xf029; 2FA codes from QR images<br><span class="faint">Google Authenticator's "Transfer accounts" QR codes: one screenshot per code</span></div>
          <input type="file" id="files" accept="image/*" multiple hidden>
          ${platform.isDesktopApp ? `<button class="m-btn" type="button" id="screen">&#xf108; Scan the screen for transfer QR codes</button>` : ""}
          ${platform.isMobile ? `<button class="m-btn" type="button" id="camera">&#xf030; Scan a transfer QR code with the camera</button>` : ""}
          <label class="lab">or paste 2FA links (otpauth:// or otpauth-migration://), one per line</label>
          <textarea id="text" placeholder="otpauth://totp/GitHub:you?secret=...&#10;otpauth-migration://offline?data=..."></textarea>
          <div class="result" id="result"></div>
        </div>
        <footer><span class="grow"></span><button class="m-btn" type="button" data-close>Close</button><button class="m-btn primary" type="submit">Import links</button></footer>
      </form>
    </div>`).firstElementChild as HTMLElement;
  document.body.append(back);
  const close = () => { back.remove(); renderList(); };
  back.querySelectorAll<HTMLElement>("[data-close]").forEach((b) => (b.onclick = close));
  back.onclick = (e) => { if (e.target === back) close(); };
  const report = (lines: string[]) => ($("#result", back).textContent = lines.join("\n"));
  const fromTexts = async (texts: string[], unreadable: string[] = []) => {
    const r = await addCodes(importText(texts.join("\n")));
    report([`Added ${r.added}${r.already ? `, ${r.already} already here` : ""}.`, ...r.skipped.map((s) => `Skipped - ${s}`), ...unreadable]);
  };

  $("#newLogin", back).onclick = () => { close(); loginEditor(null); };
  $("#new2fa", back).onclick = () => { close(); addCodeModal(); };
  const files = $<HTMLInputElement>("#files", back);
  $("#pick", back).onclick = () => files.click();
  files.onchange = async () => {
    const texts: string[] = [], unreadable: string[] = [];
    for (const f of files.files ?? []) { const t = await readQr(f); t ? texts.push(t) : unreadable.push(`Skipped - ${f.name}: no QR code found`); }
    files.value = "";
    await fromTexts(texts, unreadable);
  };
  $("#screen", back)?.addEventListener("click", async () => {
    report(["Looking at your screen…"]);
    const texts = await platform.scanScreen().catch(() => [] as string[]);
    texts.length ? await fromTexts(texts) : report(["No QR code found on screen."]);
  });
  $("#camera", back)?.addEventListener("click", () => cameraScan((t) => void fromTexts([t])));

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
    if (!text.trim()) return void report(["Paste links above, or choose a file."]);
    await fromTexts([text]);
    $<HTMLTextAreaElement>("#text", back).value = "";
  };
}

/** An otpauth:// link Vault was opened with (a site's "add to authenticator app" link). */
function offerLink(link: string) {
  if (!vault) { pendingLink = link; return; }
  const r = importText(link);
  if (!r.entries.length) return toast(`That link isn't a 2FA code${r.skipped[0] ? ` (${r.skipped[0]})` : ""}`);
  const names = r.entries.map((e) => [e.issuer, e.account].filter(Boolean).join(" · ")).join(", ");
  if (!confirm(`Add this 2FA code to Vault?\n\n${names}`)) return;
  void addCodes(r).then((x) => { toast(x.added ? `Added ${x.names.join(", ")}` : "Already in Vault"); filter = "totp"; homeScreen(); });
}

async function addCodes(r: ImportResult) {
  const have = new Set(otps().map((i) => `${i.data.otp.secret}|${i.data.otp.issuer}|${i.data.otp.account}`));
  let added = 0, already = 0;
  const names: string[] = [];
  for (const e of r.entries) {
    const k = `${e.secret}|${e.issuer}|${e.account}`;
    if (have.has(k)) { already++; continue; }
    vault!.add({ type: "totp", otp: e });
    have.add(k);
    names.push([e.issuer, e.account].filter(Boolean).join(" · ") || "a code");
    added++;
  }
  if (added) { mergeCodesIntoLogins(vault!); await save(); }   // a code for a saved login joins it
  return { added, already, skipped: r.skipped, names };
}

/** Import logins from a password-manager CSV; each login's 2FA key becomes a linked code. */
async function importLogins(text: string): Promise<string[]> {
  const res = importPasswordCsv(text);
  const haveLogin = new Set(logins().map((i) => `${i.data.name}|${i.data.username}`.toLowerCase()));
  const haveCode = new Set(otps().map((i) => i.data.otp.secret));
  let added = 0, already = 0, withCode = 0;
  for (const l of res.logins) {
    if (haveLogin.has(`${l.name}|${l.username}`.toLowerCase())) { already++; continue; }
    const otp = l.totp && !haveCode.has(l.totp.secret) ? l.totp : undefined;
    if (otp) { haveCode.add(otp.secret); withCode++; }
    vault!.add({ type: "login", name: l.name, urls: l.urls, username: l.username, password: l.password, notes: l.notes, ...(otp ? { otp } : {}) });
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

// ------------------------------------------------------------------ Android autofill
const word = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const otpOf = (o: OtpEntry) => ({ secret: o.secret, digits: o.digits, period: o.period, algorithm: o.algorithm });

/** What Android's autofill service may offer, handed over while the vault is open (memory only).
 *  `rules` carries the same site-matching tables the browser extension uses. */
function refreshAutofill() {
  if (!platform.hasAutofill || !vault) return;
  const ls = logins(), cs = otps();
  platform.setAutofill({
    rules: { multi: [...MULTI], groups: SAME_SIGN_IN },
    logins: ls.map((l) => {
      const otp = codeFor(l.data);
      const hosts = l.data.urls.map(hostOf).filter((x) => x && !x.includes(" "));
      return {
        id: l.id, name: l.data.name, username: l.data.username, password: l.data.password, hosts,
        words: [...new Set([word(l.data.name), ...hosts.map((x) => word(siteKey(x).split(".")[0] ?? ""))].filter((w) => w.length > 2))],
        ...(otp ? { otp: otpOf(otp) } : {}),
      };
    }),
    codes: cs.map((c) => ({ id: c.id, issuer: nameOf(c), account: c.data.otp.account, words: [word(c.data.otp.issuer), word(nameOf(c))].filter((w) => w.length > 2), otp: otpOf(c.data.otp) })),
    passkeys: passkeys().map((p) => ({ id: p.id, rpId: p.data.rpId, credentialId: p.data.credentialId, userHandle: p.data.userHandle, username: p.data.username, displayName: p.data.displayName ?? "", privateKeyPkcs8: p.data.privateKeyPkcs8 })),
  });
}

/** Logins Android asked to save ("Save to Vault?") while signing in somewhere: kept when the vault is open. */
async function takeAndroidSaves() {
  if (!vault) return;
  const made = platform.takePasskeys();
  for (const p of made) {
    const item = p as unknown as PasskeyItem;
    if (item.type !== "passkey" || passkeys().some((x) => x.data.credentialId === item.credentialId)) continue;
    vault.add(item);
    toast(`Passkey saved · ${item.rpName || item.rpId}`);
  }
  if (made.length) { await save(); renderList(); }
  const saves = platform.takeSaves();
  for (const s of saves) {
    if (!s.password) continue;
    const site = s.url ? loginsFor(s.url, logins()) : logins().filter((l) => s.app && l.data.urls.includes(`androidapp://${s.app}`));
    const same = s.username ? site.find((l) => l.data.username.toLowerCase() === s.username.toLowerCase()) : site.length === 1 ? site[0] : undefined;
    if (same) {
      if (same.data.password !== s.password) { vault.update(same.id, { ...same.data, password: s.password }); toast(`Password updated · ${same.data.name}`); }
      continue;
    }
    const host = s.url ? hostOf(s.url) : "";
    const name = host ? (siteKey(host).split(".")[0] ?? host).replace(/^./, (c) => c.toUpperCase()) : (s.app.split(".").filter((p) => !/^(com|org|net|android|app)$/.test(p)).pop() ?? s.app).replace(/^./, (c) => c.toUpperCase());
    vault.add({ type: "login", name, urls: host ? [`https://${host}`] : [`androidapp://${s.app}`], username: s.username, password: s.password, notes: "" });
    toast(`Login saved · ${name}`);
  }
  if (saves.length) { await save(); renderList(); }
}

// ------------------------------------------------------------------ start
// An otpauth:// link opened while Vault runs (Windows: a second start; Android: MainActivity).
platform.on("link", (p) => { void platform.showWindow(); offerLink(String(p)); });
addEventListener("vault-link", async () => { const l = await platform.takeLaunchLink(); if (l) offerLink(l); });
if (platform.hasAutofill) { setInterval(() => void takeAndroidSaves(), 2000); addEventListener("focus", () => void takeAndroidSaves()); }
if (platform.isDesktopApp) void platform.setLinkHandler(linksOn).catch(() => {});

for (const ev of ["pointerdown", "keydown"]) addEventListener(ev, () => (lastActive = Date.now()));
// Back in the app while it's locked: the fingerprint prompt comes up by itself.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") $("#quick")?.click(); });
setInterval(() => {
  if (vault && lockAfterMin && Date.now() - lastActive > lockAfterMin * 60_000) signInScreen(`Locked after ${lockLabel(lockAfterMin).replace("After ", "")} without use.`, "signin", false);
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
    vault.add({ type: "totp", otp: normalizeEntry({ issuer: "Square Enix", account: "maro-alt", secret: "MFRGGZDFMZTWQ2LK" }) });
    vault.add({ type: "totp", otp: normalizeEntry({ issuer: "DigitalOcean", account: "someone.with.a.long.address@example.com", secret: "KRSXG5CTMVRXEZLU" }) });
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

