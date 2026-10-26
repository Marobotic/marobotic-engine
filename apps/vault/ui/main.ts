// Vault's window: sign in with the marobotic account, and the 2FA codes. Everything secret is opened
// here, on the device; the copy on this PC and the one on the server are both sealed.
import { init, KDF_V1 } from "@marobotic/crypto";
import { totp, normalizeEntry, base32Decode, type OtpEntry, type Algorithm } from "@marobotic/otp";
import { importText, importPasswordCsv, type ImportResult } from "@marobotic/importers";
import { Vault, type VaultFile, type Item, type TotpItem, type LoginItem, type PasskeyItem } from "../src/vault.ts";
import { ffxivEntries, sendWhenAsked } from "../src/xivlauncher.ts";
import { generatePassword, hostOf, matchTotp } from "../src/passwords.ts";
import { siteOf } from "../src/icons.ts";
import { MULTI, SAME_SIGN_IN, loginsFor, namedSite, siteKey } from "../src/domains.ts";
import { allCodes, mergeCodesIntoLogins } from "../src/merge.ts";
import { importLogins as importLoginsInto } from "../src/importLogins.ts";
import { byUse, recordUse, useCounts } from "../src/usage.ts";
import { editCode } from "../src/codes.ts";
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
const LOCK_CHOICES = platform.isAndroid ? [0] : [0, 5, 15, 30, 60, 240, 1440];   // Android stays open until restart; 0 = never

let vault: Vault | null = null;
let file: VaultFile | null = null;      // the sealed copy on this PC (null before the first sign-in here)
let session: string | null = null;      // the account session; null = offline, changes stay on this PC
let rev = 0;                            // the server version this vault is based on
let syncing: Promise<void> | null = null;
let query = "";
let lastActive = Date.now();
let lockAfterMin = platform.isAndroid ? 0 : Number(localStorage.getItem("vault.lockAfterMin")) || 0;
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

/** Yes or no. The iPhone's web view has no confirm() (it answers "no" without asking), so there it's
 *  Vault's own box. */
function ask(text: string, yes = "OK"): Promise<boolean> {
  if (!platform.isIos) return Promise.resolve(confirm(text));
  return new Promise((done) => {
    const back = h(`
      <div class="backdrop">
        <div class="m-modal modal settings">
          <div class="content">
            <div class="set"><div><span>${esc(text).replace(/\n/g, "<br>")}</span></div></div>
            <div class="set"><div></div><button class="m-btn subtle compact" data-no>Cancel</button><button class="m-btn compact" data-yes>${esc(yes)}</button></div>
          </div>
        </div>
      </div>`).firstElementChild as HTMLElement;
    document.body.append(back);
    const close = (v: boolean) => { back.remove(); done(v); };
    $("[data-yes]", back).onclick = () => close(true);
    $("[data-no]", back).onclick = () => close(false);
    back.onclick = (e) => { if (e.target === back) close(false); };
  });
}

async function save() {
  if (!vault) return;
  forgetMatches();
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
        if (vault.merge(r.conflict.file.items)) { forgetMatches(); file = vault.toFile(); await platform.saveVault(JSON.stringify(file)); renderList(); }
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
 *  Hourglass and Jukebox. On a phone with quick unlock on, offer an explicit biometric login button. */
function signInScreen(message = "", mode: "signin" | "create" | "forgot" = "signin") {
  vault = null;
  session = null;
  signedInWith = null;
  stopAutoXl();
  platform.setAutofill(null);
  const last = file?.email || localStorage.getItem("vault.email") || "";
  const quick = mode === "signin" && platform.quickUnlock.state() === "saved";
  const create = mode === "create", forgot = mode === "forgot";
  app.replaceChildren(h(`
    <div class="signin">
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
        ${quick ? `<button class="m-btn primary" type="button" id="quick">Login using biometrics</button>` : ""}
        <button class="m-btn ${quick ? "" : "primary"}" type="submit">${forgot ? "Send reset link" : create ? "Create account" : "Sign in"}</button>
      </form>
      <div class="other">${forgot ? "Remembered it? " : create ? "Already have an account? " : "New here? "}<a href="#" id="flip">${forgot || create ? "Sign in" : "Create an account"}</a></div>
    </div>`));
  const form = $<HTMLFormElement>("form", app);
  const err = (t: string) => { $("#err").textContent = t; $("#notice").textContent = ""; };
  app.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => (b.onclick = () => signInScreen("", b.dataset.mode as "signin" | "create")));
  $("#toForgot")?.addEventListener("click", (e) => { e.preventDefault(); signInScreen("", "forgot"); });
  $("#flip").onclick = (e) => { e.preventDefault(); signInScreen("", forgot || create ? "signin" : "create"); };
  if (!platform.isMobile) $<HTMLInputElement>(last && !forgot ? "#pw" : "#em").focus();

  const quickUnlock = async () => {
    const r = await platform.quickUnlock.open();
    if (!r.email || !r.password) {
      if (r.error === "changed") err("Your phone's fingerprints changed, so quick unlock was turned off. Sign in with your password to turn it on again.");
      else if (r.error && r.error !== "cancelled") err(r.error);
      return;
    }
    const b = $<HTMLButtonElement>("#quick");
    if (b) { b.disabled = true; b.textContent = "Waiting for biometric…"; }
    try { await openAccount(r.email, r.password); }
    catch (e) {
      if (e instanceof account.SignInError) { platform.quickUnlock.clear(); signInScreen("Your password changed. Sign in with the new one to turn quick unlock on again."); }
      else { if (b) { b.disabled = false; b.textContent = "Login using biometrics"; } err((e as Error).message); }
    }
  };
  $("#quick")?.addEventListener("click", () => void quickUnlock());

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
  if (!(await ask(`Unlock Vault with ${platform.quickUnlock.label} from now on, instead of typing your password?`))) return;
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

// Worked out from the items and kept until they change (save() or a sync calls forgetMatches()): with
// hundreds of logins and codes, matching them on every tick and every keystroke made Vault crawl.
let matched = new WeakMap<LoginItem, OtpEntry | null>();   // a login without a code of its own -> the code that matches it
let owners: Map<string, LoginRow> | null = null;           // a separate 2FA code's id -> the login it belongs to
const rowCache = new Map<string, { key: string; row: HTMLElement }>();
let matchedFor: Vault | null = null;
function forgetMatches() {
  matched = new WeakMap();
  owners = null;
  rowCache.clear();
  matchedFor = vault;
}
const fresh = () => { if (matchedFor !== vault) forgetMatches(); };

/** A login's one-time code: its own, else (older vaults) the code it is linked to or that matches it. */
function codeFor(login: LoginItem): OtpEntry | undefined {
  if (login.otp) return login.otp;
  if (login.totpId) { const it = vault?.get(login.totpId); if (it?.data.type === "totp") return it.data.otp; }
  fresh();
  if (!matched.has(login)) matched.set(login, matchTotp(login, standaloneCodes().map((i) => i.data))?.otp ?? null);
  return matched.get(login) ?? undefined;
}

/** The login a separate 2FA code belongs to: the one linked to it, else the first whose site matches it. */
function ownerOf(code: TotpRow): LoginRow | undefined {
  fresh();
  if (!owners) {
    owners = new Map();
    const ls = logins();
    for (const l of ls) if (l.data.totpId && !owners.has(l.data.totpId)) owners.set(l.data.totpId, l);
    const loose = ls.filter((l) => !l.data.totpId);
    for (const c of standaloneCodes()) {
      if (owners.has(c.id)) continue;
      const l = loose.find((x) => matchTotp(x.data, [c.data]));
      if (l) owners.set(c.id, l);
    }
  }
  return owners.get(code.id);
}

// A code only changes once a period, so each is worked out once per step rather than on every tick.
const codeMemo = new Map<string, { step: number; code: Promise<string> }>();
async function codeAt(otp: OtpEntry, now: number): Promise<{ code: string; remaining: number }> {
  const step = Math.floor(now / 1000 / otp.period);
  const k = `${otp.secret}|${otp.algorithm}|${otp.digits}|${otp.period}`;
  let m = codeMemo.get(k);
  if (!m || m.step !== step) { m = { step, code: totp(otp, now).then((r) => r.code) }; codeMemo.set(k, m); }
  return { code: await m.code, remaining: otp.period - (Math.floor(now / 1000) % otp.period) };
}

/** Logins picked on this device (copied here, or filled by Android autofill): +1 each, synced, so the
 *  most picked comes first everywhere (src/usage.ts). Never shown. */
async function used(ids: string[]) {
  if (!vault || !ids.length) return;
  const mine = localStorage.getItem("vault.usageId") ?? "";
  const now = recordUse(vault, mine, ids);
  if (now === mine && !ids.some((id) => vault!.get(id))) return;
  localStorage.setItem("vault.usageId", now);
  await save();
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
      <button class="m-btn subtle compact" id="settings" title="Settings" aria-label="Settings"><svg class="ecosystem-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19.43 12.98 c0.04 -0.32 0.07 -0.64 0.07 -0.98 c0 -0.34 -0.03 -0.66 -0.07 -0.98 l2.11 -1.65 c0.19 -0.15 0.24 -0.42 0.12 -0.64 l-2.0 -3.46 c-0.09 -0.16 -0.26 -0.25 -0.44 -0.25 c-0.06 0 -0.12 0.01 -0.17 0.03 l-2.49 1 c-0.52 -0.4 -1.08 -0.73 -1.69 -0.98 l-0.38 -2.65 C14.46 2.18 14.25 2 14.0 2 h-4.0 c-0.25 0 -0.46 0.18 -0.49 0.42 l-0.38 2.65 c-0.61 0.25 -1.17 0.59 -1.69 0.98 l-2.49 -1.0 c-0.06 -0.02 -0.12 -0.03 -0.18 -0.03 c-0.17 0 -0.34 0.09 -0.43 0.25 l-2.0 3.46 c-0.13 0.22 -0.07 0.49 0.12 0.64 l2.11 1.65 c-0.04 0.32 -0.07 0.65 -0.07 0.98 c0 0.33 0.03 0.66 0.07 0.98 l-2.11 1.65 c-0.19 0.15 -0.24 0.42 -0.12 0.64 l2 3.46 c0.09 0.16 0.26 0.25 0.44 0.25 c0.06 0 0.12 -0.01 0.17 -0.03 l2.49 -1.0 c0.52 0.4 1.08 0.73 1.69 0.98 l0.38 2.65 c0.03 0.24 0.24 0.42 0.49 0.42 h4.0 c0.25 0 0.46 -0.18 0.49 -0.42 l0.38 -2.65 c0.61 -0.25 1.17 -0.59 1.69 -0.98 l2.49 1 c0.06 0.02 0.12 0.03 0.18 0.03 c0.17 0 0.34 -0.09 0.43 -0.25 l2 -3.46 c0.12 -0.22 0.07 -0.49 -0.12 -0.64 l-2.11 -1.65 z M17.45 11.27 c0.04 0.31 0.05 0.52 0.05 0.73 c0 0.21 -0.02 0.43 -0.05 0.73 l-0.14 1.13 l0.89 0.7 l1.08 0.84 l-0.7 1.21 l-1.27 -0.51 l-1.04 -0.42 l-0.9 0.68 c-0.43 0.32 -0.84 0.56 -1.25 0.73 l-1.06 0.43 l-0.16 1.13 l-0.2 1.35 h-1.4 l-0.19 -1.35 l-0.16 -1.13 l-1.06 -0.43 c-0.43 -0.18 -0.83 -0.41 -1.23 -0.71 l-0.91 -0.7 l-1.06 0.43 l-1.27 0.51 l-0.7 -1.21 l1.08 -0.84 l0.89 -0.7 l-0.14 -1.13 c-0.03 -0.31 -0.05 -0.54 -0.05 -0.74 s0.02 -0.43 0.05 -0.73 l0.14 -1.13 l-0.89 -0.7 l-1.08 -0.84 l0.7 -1.21 l1.27 0.51 l1.04 0.42 l0.9 -0.68 c0.43 -0.32 0.84 -0.56 1.25 -0.73 l1.06 -0.43 l0.16 -1.13 l0.2 -1.35 h1.39 l0.19 1.35 l0.16 1.13 l1.06 0.43 c0.43 0.18 0.83 0.41 1.23 0.71 l0.91 0.7 l1.06 -0.43 l1.27 -0.51 l0.7 1.21 l-1.07 0.85 l-0.89 0.7 l0.14 1.13 z M12.0 8.0 c-2.21 0 -4.0 1.79 -4.0 4.0 s1.79 4.0 4.0 4.0 s4.0 -1.79 4.0 -4.0 s-1.79 -4.0 -4.0 -4.0 z M12.0 14.0 c-1.1 0 -2.0 -0.9 -2.0 -2.0 s0.9 -2.0 2 -2.0 s2 0.9 2 2 s-0.9 2 -2.0 2 z"/></svg><span class="lbl"> Settings</span></button>
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
  let typed = 0;
  $<HTMLInputElement>("#q").oninput = (e) => {
    query = (e.target as HTMLInputElement).value;
    if (!typed) typed = requestAnimationFrame(() => { typed = 0; renderList(); });
  };
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
  offerSetup();
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

// ------------------------------------------------------------------ Android: setting up autofill
// Everything Vault needs from the phone is asked here, by the person, never changed behind their back:
// Vault as the autofill service, no battery pause, its own list for apps like Discord, and browsers that
// keep their own autofill until told to use the phone's.
type SetupStep = { id: string; title: string; text: string; done: boolean; button: string; act: () => void };

function setupSteps(): SetupStep[] {
  if (!platform.hasAutofill) return [];
  let st = "unsupported", who = "";
  try { st = platform.autofillState(); who = platform.autofillProvider(); } catch { /* shown as not done */ }
  if (st === "unsupported") return [];
  const steps: SetupStep[] = [
    { id: "service", title: "Vault fills your passwords", done: st === "on" && who === "Vault", button: "Choose Vault", act: () => platform.openAutofillSettings(),
      text: `${who && who !== "Vault" ? `${who} fills passwords now. ` : ""}Pick Vault under Passwords, passkeys & autofill (as the preferred service too, for passkeys).` },
    { id: "ready", title: "Keep Vault ready", done: platform.keptReady(), button: "Allow", act: () => platform.keepReady(),
      text: "Android pauses Vault in the background, and suggestions then come late or not at all. Allow it to run without battery restrictions." },
    { id: "overlay", title: "Fill in apps like Discord", done: platform.overlayOn(), button: "Turn on", act: () => platform.openOverlaySettings(),
      text: "Some apps hide Android's list as soon as the keyboard opens. Vault then shows its own list under the field. In the next screen, turn on \"Vault autofill in apps like Discord\". If Android says the setting is restricted: open Vault's App info, tap \u22ee, Allow restricted settings, and try again." },
  ];
  for (const b of platform.browsers()) {
    const can = b.pkg !== "com.sec.android.app.sbrowser";   // Samsung Internet fills only with its own passwords and partners
    steps.push({ id: `browser:${b.pkg}`, title: can ? `${b.name} uses Vault` : b.name, done: can && localStorage.getItem(`vault.setup.${b.pkg}`) === "done",
      button: can ? `Open ${b.name}` : "", act: () => { localStorage.setItem(`vault.setup.${b.pkg}`, "done"); platform.openApp(b.pkg); }, text: b.how });
  }
  return steps;
}

/** After unlocking on a phone: the setup guide, while something is missing (until "Don't ask again"). */
function offerSetup() {
  if (platform.isDesktopApp && localStorage.getItem("vault.extensionDismissed") !== "1" && !document.querySelector(".extensionSetup")) {
    void platform.extensionBrowsers().then((bs) => { if (bs.length && !bs.some((b) => b.installed) && localStorage.getItem("vault.extensionDone") !== "1" && localStorage.getItem("vault.extensionDismissed") !== "1") extensionSetup(); });
  }
  if (localStorage.getItem("vault.setupDismissed") === "1" || document.querySelector(".setup")) return;
  if (setupSteps().some((s) => !s.done && !s.id.startsWith("browser:"))) setupModal();
}

async function extensionSetup() {
  const browsers = await platform.extensionBrowsers();
  if (!platform.isDesktopApp || !browsers.length) return;
  let pick = browsers.find((b) => b.installed)?.id || browsers[0]!.id;
  const back = h(`<div class="backdrop extensionSetup"><div class="m-modal modal settings setup"><header>Set up the browser extension <button class="m-btn subtle compact" data-close>&#xf00d;</button></header><div class="content"><div class="set"><div><b>Browser</b></div><select class="m-field" id="extBrowser">${browsers.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join("")}</select></div><div id="extSteps"></div><div class="set"><div><span>You can come back to this in Settings.</span></div><button class="m-btn subtle compact" id="extNever">Don't ask again</button><button class="m-btn compact" data-close>Done</button></div></div></div></div>`).firstElementChild as HTMLElement;
  document.body.append(back);
  const paint = () => {
    pick = $<HTMLSelectElement>("#extBrowser", back).value || pick;
    const b = browsers.find((x) => x.id === pick)!;
    const done = b.installed || localStorage.getItem(`vault.extension.${pick}`) === "done";
    $("#extSteps", back).innerHTML = done ? `<div class="set"><div><b>&#xf00c; Added to ${esc(b.name)}</b><span>Vault is ready in this browser.</span></div></div>` : `
      <div class="set"><div><b>1. Open ${esc(b.name)} extensions</b><span>Then turn on Developer mode.</span></div><button class="m-btn compact" id="extOpen">Open</button></div>
      <div class="set"><div><b>2. Load unpacked</b><span>Choose this folder:</span><span class="selectable" id="extPath">${esc(b.folder)}</span></div><span><button class="m-btn compact" id="extCopy">Copy path</button> <button class="m-btn compact" id="extFolder">Open folder</button></span></div>
      <div class="set"><div><b>3. Confirm</b><span>Load the folder in the browser.</span></div><button class="m-btn compact" id="extDone">I've added it</button></div>`;
    $("#extOpen", back)?.addEventListener("click", () => { void platform.openExtensions(pick); });
    $("#extCopy", back)?.addEventListener("click", () => { void navigator.clipboard.writeText(b.folder).then(() => toast("Folder path copied")); });
    $("#extFolder", back)?.addEventListener("click", () => { void platform.openExtensionFolder(); });
    $("#extDone", back)?.addEventListener("click", () => { localStorage.setItem(`vault.extension.${pick}`, "done"); localStorage.setItem("vault.extensionDone", "1"); paint(); });
  };
  $<HTMLSelectElement>("#extBrowser", back).value = pick;
  $("#extBrowser", back).addEventListener("change", paint);
  paint();
  const close = () => back.remove();
  back.querySelectorAll<HTMLElement>("[data-close]").forEach((x) => x.onclick = close);
  back.onclick = (e) => { if (e.target === back) close(); };
  $("#extNever", back).onclick = () => { localStorage.setItem("vault.extensionDismissed", "1"); close(); };
}

function setupModal() {
  const back = h(`
    <div class="backdrop">
      <div class="m-modal modal settings setup">
        <header>Set up autofill <button class="m-btn subtle compact" type="button" data-close title="Close">&#xf00d;</button></header>
        <div class="content"><div id="steps"></div>
          <div class="set"><div><span>You can come back to this any time: Settings, Set up autofill.</span></div>
            <button class="m-btn subtle compact" id="never">Don't ask again</button><button class="m-btn compact" data-close>Done</button></div>
        </div>
      </div>
    </div>`).firstElementChild as HTMLElement;
  document.body.append(back);
  const paint = () => {
    const box = $("#steps", back);
    box.innerHTML = setupSteps().map((s) => `
      <div class="set"><div><b>${s.done ? "&#xf00c; " : ""}${esc(s.title)}</b><span>${esc(s.text)}</span></div>
        ${s.button ? `<button class="m-btn compact ${s.done ? "subtle" : ""}" data-step="${esc(s.id)}">${s.done ? "Change" : esc(s.button)}</button>` : ""}</div>`).join("");
    box.querySelectorAll<HTMLElement>("[data-step]").forEach((b) => (b.onclick = () => setupSteps().find((s) => s.id === b.dataset.step)?.act()));
  };
  paint();
  // Back from Android's settings: show what changed.
  const onFocus = () => paint();
  addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onFocus);
  const close = () => { removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); back.remove(); };
  back.querySelectorAll<HTMLElement>("[data-close]").forEach((b) => (b.onclick = close));
  back.onclick = (e) => { if (e.target === back) close(); };
  $("#never", back).onclick = () => { localStorage.setItem("vault.setupDismissed", "1"); close(); };
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
            <div><b>Lock automatically</b><span>${platform.isAndroid ? "On Android, Vault stays unlocked until the app process ends or you lock it manually." : `Sign out of Vault after this long without use.${platform.isMobile ? "" : " Closing the window keeps Vault open in the tray; Quit from the tray icon locks it."}`}</span></div>
            <select class="m-field" id="lockAfter">${LOCK_CHOICES.map((m) => `<option value="${m}" ${m === lockAfterMin ? "selected" : ""}>${lockLabel(m)}</option>`).join("")}</select>
          </div>
          <div class="set">
            <div><b>Recovery kit</b><span>The only way back into your vault if your account password is reset. Making a new one stops the old one working.</span></div>
            <button class="m-btn compact" id="kit">New kit</button>
          </div>
          <div class="set" ${platform.isMobile ? "hidden" : ""}>
            <div><b>Browser extension</b><span>Vault for Chrome, Brave and Edge signs in with this same account and syncs on its own (this app doesn't need to be open). It fills logins and 2FA codes, saves new logins and passkeys, and signs in with passkeys; they show up here too.</span></div>
            ${platform.isDesktopApp ? `<button class="m-btn compact" id="extensionSetup">Set up</button>` : ""}
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
          </div>
          <div class="set">
            <div><b>Set up autofill</b><span>Everything Vault needs from this phone to fill logins and 2FA codes in apps and browsers, step by step.</span></div>
            <button class="m-btn compact" id="setupOpen">Open</button>
          </div>
          <div class="set" id="readyRow" ${platform.keptReady() ? "hidden" : ""}>
            <div><b>Keep Vault ready</b><span>Android pauses Vault in the background, so suggestions come late or not at all. Allow it to run without battery restrictions.</span></div>
            <button class="m-btn compact" id="ready">Allow</button>
          </div>` : ""}
          ${platform.quickUnlock.state() !== "unavailable" ? `
          <div class="set">
            <div><b>Biometric login</b><span>Your password is sealed by the phone and only opens after your fingerprint, face or the phone's PIN.</span></div>
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
  $("#extensionSetup", back)?.addEventListener("click", () => { close(); void extensionSetup(); });
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
    $("#setupOpen", back).onclick = () => { close(); setupModal(); };
    $("#ready", back)?.addEventListener("click", () => { platform.keepReady(); addEventListener("focus", () => ($("#readyRow", back).hidden = platform.keptReady()), { once: true }); });
    showAf();
    addEventListener("focus", showAf, { once: true });
  }
  $<HTMLSelectElement>("#lockAfter", back).onchange = (e) => {
    lockAfterMin = Number((e.target as HTMLSelectElement).value) || 0;
    localStorage.setItem("vault.lockAfterMin", String(lockAfterMin));
    toast(lockAfterMin ? `Vault locks after ${lockLabel(lockAfterMin).replace("After ", "")} without use` : "Vault stays open until you quit or lock it");
  };
  $("#lockNow", back).onclick = () => { close(); signInScreen("", "signin"); };
  $("#kit", back).onclick = async () => {
    if (!(await ask("Make a new recovery kit? Your current one stops working, so write the new one down right away."))) return;
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
  const uses = useCounts(vault!);
  const n = (i: LoginRow) => uses.get(i.id) ?? 0;
  const ls = logins().sort((a, b) => pinFirst(!!a.data.favorite, !!b.data.favorite) || (query.trim() ? n(b) - n(a) : 0) || a.data.name.localeCompare(b.data.name) || n(b) - n(a));
  const ts = otps().sort((a, b) => pinFirst(!!a.data.favorite, !!b.data.favorite) || nameOf(a).localeCompare(nameOf(b)));
  const rows: HTMLElement[] = [];
  fresh();
  // A row is made once per version of its item and reused (searching only picks which rows show).
  const cached = (id: string, key: string, make: () => HTMLElement) => {
    const c = rowCache.get(id);
    if (c && c.key === key) return c.row;
    const row = make();
    rowCache.set(id, { key, row });
    return row;
  };
  if (filter === "login") for (const i of ls) if (matchesQuery(`${i.data.name} ${i.data.email ?? ""} ${i.data.username} ${i.data.urls.join(" ")}`)) rows.push(cached("l" + i.id, String(i.updated), () => loginRow(i)));
  const ps = passkeys().sort((a, b) => (a.data.rpName || a.data.rpId).localeCompare(b.data.rpName || b.data.rpId));
  if (filter === "login") for (const i of ps) if (matchesQuery(`${i.data.rpName ?? ""} ${i.data.rpId} ${i.data.username}`)) rows.push(cached("p" + i.id, String(i.updated), () => passkeyRow(i)));
  const ff = new Set(platform.isDesktopApp ? ffxivEntries(ts.map((i) => i.data.otp)) : []);   // sending to XIVLauncher is desktop only
  if (filter === "totp") for (const i of ts) if (matchesQuery(`${nameOf(i)} ${i.data.otp.issuer} ${i.data.otp.account}`)) {
    const isFf = ff.has(i.data.otp);
    rows.push(cached("c" + i.id, `${i.updated}|${isFf}|${isFf && autoXlId === i.id}`, () => codeRow(i, isFf)));
  }

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
    if (!(await ask(`Delete the passkey for ${d.rpId} (${d.username})? Make sure you can still sign in there another way.`))) return;
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
      if (!(await ask(`Delete ${name}? Make sure you can still sign in another way.`))) return;
      vault!.remove(i.id); await save(); renderList();
    },
  };
  if (i.data.type === "login") {
    const d = i.data, linked = codeFor(d), who = d.username || d.name;
    const copies: MenuSection["items"] = [];
    if (d.password) copies.push({ label: "Copy password", icon: "&#xf084;", onClick: () => { void copy(d.password, `Password copied · ${who} (clears in 30s)`, 30_000); void used([i.id]); } });
    if (d.email) copies.push({ label: "Copy email", icon: "&#xf0e0;", onClick: () => void copy(d.email!, `Email copied · ${d.name}`) });
    if (d.username) copies.push({ label: "Copy username", icon: "&#xf007;", onClick: () => void copy(d.username, `Username copied · ${d.name}`) });
    if (linked) copies.push({ label: "Copy 2FA code", icon: "&#xf023;", onClick: () => void copyCode(i.id, linked, who) });
    openMenu(x, y, [{ title: d.name, items: copies }, { items: [pin, { label: "Edit", icon: "&#xf044;", onClick: () => loginEditor(i as LoginRow) }] }, { items: [del] }]);
  } else if (i.data.inLogin) {
    const t = i as TotpRow, owner = vault!.get(t.id) as LoginRow;
    openMenu(x, y, [{ title: nameOf(t), items: [{ label: "Copy code", icon: "&#xf0c5;", onClick: () => void copyCode(t.id, t.data.otp, t.data.otp.account || nameOf(t)) }] },
      { items: [pin, { label: "Edit code", icon: "&#xf044;", onClick: () => codeEditor(t) }, { label: "Edit login", icon: "&#xf084;", onClick: () => loginEditor(owner) }] },
      { items: [{ label: "Remove the code from this login", icon: "&#xf1f8;", danger: true, onClick: async () => {
        if (!(await ask(`Remove the 2FA code from ${owner.data.name}? Make sure you can still sign in another way.`))) return;
        const { otp: _gone, ...rest } = owner.data;
        vault!.update(owner.id, rest); await save(); renderList();
      } }] }]);
  } else {
    const t = i as TotpRow;
    openMenu(x, y, [{ title: nameOf(t), items: [{ label: "Copy code", icon: "&#xf0c5;", onClick: () => void copyCode(t.id, t.data.otp, t.data.otp.account || nameOf(t)) }] },
      { items: [pin, { label: "Edit", icon: "&#xf044;", onClick: () => codeEditor(t) }] }, { items: [del] }]);
  }
}

/** The two lines next to an icon: the account big, the service under it. */
const whoLines = (big: string, small: string, pinned: boolean) =>
  `<div class="txt"><b>${pinned ? '<span class="pin">&#xf08d;</span> ' : ""}${esc(big || small)}</b>${big && small ? `<span>${esc(small)}</span>` : ""}</div>`;

function loginRow(i: LoginRow): HTMLElement {
  const d = i.data;
  const host = d.urls[0] ? hostOf(d.urls[0]) : "";
  const linked = codeFor(d);
  const site = host && host !== d.name.toLowerCase() ? `${d.name} · ${host}` : d.name;
  // The email big when there is one (most sites sign in with it), the username under it.
  const small = d.email && d.username ? `${d.username} · ${site}` : site;
  const row = h(`
    <div class="item login" data-login="${i.id}">
      <span class="tileslot"></span>
      ${whoLines(d.email || d.username, small, !!d.favorite)}
      <div class="tools">
        <button class="m-btn subtle compact" data-edit title="Edit">&#xf044;</button>
        <button class="m-btn subtle compact" data-menu title="More">&#xf142;</button>
      </div>
      <div class="actions">
        ${d.email ? `<button class="m-btn subtle compact" data-cemail>&#xf0e0; Email</button>` : ""}
        ${d.username ? `<button class="m-btn subtle compact" data-cuser>&#xf007; User</button>` : ""}
        ${d.password ? `<button class="m-btn subtle compact" data-cpass>&#xf084; Password</button>` : ""}
        ${linked ? `<button class="mini" title="Copy the 2FA code" data-ccode><span class="mono" data-code>······</span><span class="m-level mini-bar"><i data-bar></i></span></button>` : ""}
      </div>
    </div>`).firstElementChild as HTMLElement;
  row.querySelector(".tileslot")!.replaceWith(entryIcon(d.name, siteOf({ urls: d.urls, name: d.name })));
  const who = d.email || d.username || d.name;
  row.querySelector<HTMLElement>("[data-cemail]")?.addEventListener("click", () => void copy(d.email!, `Email copied · ${d.name}`));
  row.querySelector<HTMLElement>("[data-cuser]")?.addEventListener("click", () => void copy(d.username, `Username copied · ${d.name}`));
  row.querySelector<HTMLElement>("[data-cpass]")?.addEventListener("click", () => { void copy(d.password, `Password copied · ${who} (clears in 30s)`, 30_000); void used([i.id]); });
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
  const login = ownerOf(i);
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
  if (document.hidden) return;   // in the tray or minimized: nothing to paint
  const now = Date.now();
  for (const row of document.querySelectorAll<HTMLElement>(".code-row")) {
    const item = vault?.get(row.dataset.id!);
    const otp = item?.data.type === "totp" ? item.data.otp : item?.data.type === "login" ? item.data.otp : undefined;
    if (!otp) continue;
    paintCode(row, await codeAt(otp, now), otp.period, (copiedUntil.get(row.dataset.id!) ?? 0) > now);
  }
  // Only logins with a code have somewhere to paint it.
  for (const row of document.querySelectorAll<HTMLElement>(".login[data-login]:has([data-code])")) {
    const item = vault?.get(row.dataset.login!);
    if (!item || item.data.type !== "login") continue;
    const otp = codeFor(item.data);
    if (otp) paintCode(row, await codeAt(otp, now), otp.period, (copiedUntil.get(row.dataset.login!) ?? 0) > now);
  }
}
function paintCode(row: HTMLElement, r: { code: string; remaining: number }, period: number, copied: boolean) {
  const el = row.querySelector<HTMLElement>("[data-code]");
  if (!el) return;
  const text = copied ? "Copied" : groupCode(r.code);
  if (el.textContent !== text) el.textContent = text;
  el.classList.toggle("copied", copied);
  el.classList.toggle("low", !copied && r.remaining <= 5);
  const bar = row.querySelector<HTMLElement>("[data-bar]");
  if (bar) { bar.style.setProperty("--s", String(r.remaining / period)); bar.parentElement!.classList.toggle("full", r.remaining <= 5); }
}

// ------------------------------------------------------------------ login editor
/** Edit a 2FA code: its name, service, account, and (under More) its setup key and settings. A login's
 *  own code keeps the login's name; its other details are edited here too. */
function codeEditor(t: TotpRow) {
  const inLogin = !!t.data.inLogin;
  const o = t.data.otp;
  const sel = (id: string, values: (string | number)[], cur: string | number, label = (v: string | number) => String(v)) =>
    `<select class="m-field" id="${id}">${values.map((v) => `<option value="${v}" ${v === cur ? "selected" : ""}>${label(v)}</option>`).join("")}</select>`;
  const back = h(`
    <div class="backdrop">
      <form class="m-modal modal">
        <header>Edit 2FA code <button class="m-btn subtle compact" type="button" data-close title="Close">&#xf00d;</button></header>
        <div class="content">
          <div class="pw"><span class="grow otpnow" id="now"></span><span class="faint" id="left"></span></div>
          ${inLogin ? `<div class="faint hint">The 2FA code of the login ${esc(t.data.label ?? "")}: the list shows it under the login's name.</div>`
            : `<label class="lab">Name</label><input class="m-field" id="name" value="${esc(t.data.label ?? "")}" placeholder="${esc(o.issuer || "e.g. Discord")}">`}
          <label class="lab">Service</label><input class="m-field" id="issuer" value="${esc(o.issuer)}" placeholder="e.g. Discord" autocapitalize="off">
          <label class="lab">Account</label><input class="m-field" id="account" value="${esc(o.account)}" placeholder="the email or username it's for" autocomplete="off" autocapitalize="off">
          <details class="more"><summary>Setup key and settings</summary>
            <label class="lab">Setup key</label>
            <div class="pw"><input class="m-field grow key" id="secret" placeholder="Empty keeps the current key" autocomplete="off" autocapitalize="characters" spellcheck="false"><button class="m-btn subtle compact" type="button" id="showKey">Show current</button></div>
            <div class="keystate" id="keyState"></div>
            <label class="lab">Digits</label>${sel("digits", [6, 7, 8], o.digits)}
            <label class="lab">New code every</label>${sel("period", [30, 60], o.period, (v) => `${v} seconds`)}
            <label class="lab">Algorithm</label>${sel("algorithm", ["SHA1", "SHA256", "SHA512"], o.algorithm)}
            <div class="faint hint">Only change these if the site says so: a wrong setting gives wrong codes.</div>
          </details>
          ${inLogin ? "" : `<label class="lab">Notes</label><textarea id="notes">${esc(t.data.notes ?? "")}</textarea>`}
          <div class="result" id="result"></div>
        </div>
        <footer>
          ${inLogin ? "" : `<button class="m-btn danger" type="button" id="del">&#xf1f8; Delete</button>`}
          <span class="grow"></span>
          <button class="m-btn" type="button" data-close>Cancel</button>
          <button class="m-btn primary" type="submit">Save</button>
        </footer>
      </form>
    </div>`).firstElementChild as HTMLElement;
  document.body.append(back);
  const val = (id: string) => $<HTMLInputElement>(`#${id}`, back)?.value ?? "";
  // The code as it will be with what's typed, so a wrong key or setting shows before saving.
  const preview = (): OtpEntry | null => {
    try {
      const k = val("secret").trim() ? checkKey(val("secret")) : { ok: true, clean: o.secret };
      if (!k.ok) return null;
      return normalizeEntry({ ...o, secret: k.clean, digits: Number(val("digits")), period: Number(val("period")), algorithm: val("algorithm") as Algorithm });
    } catch { return null; }
  };
  const paint = async () => {
    if (!back.isConnected) return clearInterval(timer);
    const p = preview();
    if (!p) { $("#now", back).textContent = "------"; $("#left", back).textContent = ""; return; }
    const r = await totp(p);
    $("#now", back).textContent = groupCode(r.code);
    $("#left", back).textContent = `${r.remaining}s`;
  };
  const timer = setInterval(() => void paint(), 1000);
  void paint();
  $("#secret", back).oninput = () => {
    const v = val("secret").trim();
    const k = v ? checkKey(v) : { ok: true, message: "" };
    $("#keyState", back).textContent = k.message;
    $("#keyState", back).className = `keystate ${k.ok ? "ok" : k.message ? "bad" : ""}`;
    void paint();
  };
  for (const id of ["digits", "period", "algorithm"]) $(`#${id}`, back).onchange = () => void paint();
  $("#showKey", back).onclick = (e) => {
    const b = e.currentTarget as HTMLButtonElement;
    const ks = $("#keyState", back);
    const on = b.dataset.on !== "1";
    b.dataset.on = on ? "1" : "";
    b.textContent = on ? "Hide" : "Show current";
    ks.className = "keystate";
    ks.textContent = on ? o.secret.replace(/(.{4})/g, "$1 ").trim() : "";
  };
  const close = () => { clearInterval(timer); back.remove(); renderList(); };
  back.querySelectorAll<HTMLElement>("[data-close]").forEach((b) => (b.onclick = close));
  back.onclick = (e) => { if (e.target === back) close(); };
  $("#del", back)?.addEventListener("click", async () => {
    if (!(await ask(`Delete ${nameOf(t)}? Make sure you can still sign in another way.`))) return;
    vault!.remove(t.id); await save(); close();
  });
  $<HTMLFormElement>("form", back).onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      editCode(vault!, t.id, {
        ...(inLogin ? {} : { name: val("name"), notes: $<HTMLTextAreaElement>("#notes", back).value }),
        issuer: val("issuer"), account: val("account"), secret: val("secret"),
        digits: Number(val("digits")), period: Number(val("period")), algorithm: val("algorithm") as Algorithm,
      });
    } catch (e) { $("#result", back).textContent = (e as Error).message; return; }
    await save();
    toast(`Saved · ${val("name") || val("issuer") || "2FA code"}`);
    close();
  };
}

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
          <label class="lab">Email</label><input class="m-field" id="email" type="email" value="${esc(d.email ?? "")}" autocomplete="off" autocapitalize="off">
          <label class="lab">Username</label><input class="m-field" id="user" value="${esc(d.username)}" autocomplete="off" autocapitalize="off" placeholder="only if the site has one besides the email">
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
    key.oninput = (ev) => {
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
    if (!existing || !(await ask(`Delete ${existing.data.name}? This can't be undone.`))) return;
    vault!.remove(existing.id);
    await save();
    close();
  });
  $<HTMLFormElement>("form", back).onsubmit = async (ev) => {
    ev.preventDefault();
    const name = $<HTMLInputElement>("#name", back).value.trim();
    if (!name) return void ($("#result", back).textContent = "Give it a name.");
    const username = $<HTMLInputElement>("#user", back).value.trim();
    const email = $<HTMLInputElement>("#email", back).value.trim();
    const typed = back.querySelector<HTMLInputElement>("#otpKey")?.value.trim() ?? "";
    if (typed) {
      try {
        if (/^otpauth/i.test(typed)) { const r = importText(typed); if (!r.entries[0]) throw new Error(r.skipped[0] ?? "that link has no 2FA code"); otp = r.entries[0]; }
        else { const k = checkKey(typed); if (!k.ok) throw new Error(k.message); otp = normalizeEntry({ issuer: name, account: email || username, secret: k.clean }); }
      } catch (e) { return void ($("#result", back).textContent = `One-time code: ${(e as Error).message}`); }
    }
    const data: LoginItem = {
      type: "login",
      name,
      urls: $<HTMLInputElement>("#url", back).value.split(/[\s,]+/).filter(Boolean),
      username,
      ...(email ? { email } : {}),
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
  if (!platform.isDesktopApp) return toast("Sending to XIVLauncher works in the Windows app");
  stopAutoXl();
  toast(`Waiting for XIVLauncher's OTP box (${who})…`);
  const r = await sendWhenAsked(entry, { untilMs: 60_000, send: platform.xlSend });
  toast(r.sent ? `Code sent to XIVLauncher · ${who}` : "XIVLauncher didn't ask within a minute - is its OTP box open, with app support on?");
  if (autoXlId) startAutoXl();
}

/** Auto-send: whenever XIVLauncher asks, it gets the code of the one account chosen for it. */
function startAutoXl() {
  if (xlRun || !platform.isDesktopApp || !vault) return;
  const run = (xlRun = new AbortController());
  (async () => {
    while (!run.signal.aborted && vault) {
      const item = otps().find((t) => t.id === autoXlId);   // a login's own code has the login's id
      if (!item) break;
      const who = item.data.otp.account || nameOf(item);
      const r = await sendWhenAsked(item.data.otp, { untilMs: 60 * 60_000, everyMs: 1500, send: platform.xlSend, signal: run.signal });
      if (r.sent) { toast(`FFXIV code sent to XIVLauncher · ${who}`); await new Promise((ok) => setTimeout(ok, 45_000)); }
    }
    if (xlRun === run) xlRun = null;   // ended by itself: the next start mustn't think it's still running
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
            ${platform.isDesktopApp ? `<button class="m-btn primary" type="button" id="screen">&#xf125; Pick the QR code on screen</button>` : ""}
            ${platform.isMobile ? `<button class="m-btn primary" type="button" id="camera">&#xf030; Scan with the camera</button>` : ""}
            <button class="m-btn" type="button" id="pick">&#xf03e; From an image</button>
          </div>
          <div class="faint hint">${platform.isDesktopApp ? "Open the site's QR code, then Pick: Vault steps aside and you drag a box around the code (Esc cancels). A screenshot works too (choose it, or paste it here with Ctrl+V)." : platform.isMobile ? "Point the camera at the QR code on the other screen, or choose a screenshot of it." : "Choose a screenshot of the QR code, or paste one here."}</div>
          <input type="file" id="files" accept="image/*" multiple hidden>
          <div class="m-section">or paste the setup key</div>
          <label class="lab" for="key">Setup key <span class="faint">("copy code for manual entry" on the site)</span></label>
          <input class="m-field key" id="key" placeholder="e.g. GHBE AHFH ADJA 7KQ2 … or an otpauth:// link" autocomplete="off" autocapitalize="characters" spellcheck="false">
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
    if (!img) {
      // Ctrl+V with no field picked: a link imports, a setup key goes in its box.
      const text = e.clipboardData?.getData("text")?.trim() ?? "";
      if (!text || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      if (/^otpauth(-migration)?:\/\//i.test(text)) return void fromTexts([text]);
      key.value = text;
      key.dispatchEvent(new Event("input"));
      return;
    }
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
    report(["Drag a box around the QR code (Esc cancels)…"]);
    try {
      const texts = await platform.scanScreen();
      if (!texts) return report([]);
      if (!texts.length) return report(["No QR code found there. Try again around the whole code, or paste its setup key below."]);
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
  key.oninput = (ev) => {
    if (/^otpauth(-migration)?:\/\//i.test(key.value.trim())) { const link = key.value.trim(); key.value = ""; return void fromTexts([link]); }
    const k = checkKey(key.value), st = $("#keystate", back);
    // A pasted key: name it next (the site's name, e.g. DigitalOcean).
    if (k.ok && !$<HTMLInputElement>("#iss", back).value && (ev as InputEvent).inputType === "insertFromPaste") $<HTMLInputElement>("#iss", back).focus();
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
          ${platform.isDesktopApp ? `<button class="m-btn" type="button" id="screen">&#xf125; Pick transfer QR codes on screen</button>` : ""}
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
    if (texts) texts.length ? await fromTexts(texts) : report(["No QR code found there."]);
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
async function offerLink(link: string) {
  if (!vault) { pendingLink = link; return; }
  const r = importText(link);
  if (!r.entries.length) return toast(`That link isn't a 2FA code${r.skipped[0] ? ` (${r.skipped[0]})` : ""}`);
  const names = r.entries.map((e) => [e.issuer, e.account].filter(Boolean).join(" · ")).join(", ");
  if (!(await ask(`Add this 2FA code to Vault?\n\n${names}`))) return;
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
  const { added, already, withCode, filled } = importLoginsInto(vault!, res);
  if (added || withCode || filled) await save();
  return [`From ${res.source}: added ${added} login${added === 1 ? "" : "s"}${withCode ? ` (${withCode} with a 2FA code)` : ""}${filled ? `, filled in the email of ${filled} you already had` : ""}${already ? `, ${already} already here` : ""}.`, ...res.skipped.map((s) => `Skipped - ${s}`)];
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
  const counts = useCounts(vault);
  const ls = byUse(logins(), counts), cs = otps();
  platform.setAutofill({
    rules: { multi: [...MULTI], groups: SAME_SIGN_IN },
    logins: ls.map((l) => {
      const otp = codeFor(l.data);
      // No address saved: the site its name names (the same exact rule the extension uses).
      const hosts = l.data.urls.length ? l.data.urls.map(hostOf).filter((x) => x && !x.includes(" ")) : [namedSite(l.data.name)].filter(Boolean);
      return {
        id: l.id, name: l.data.name, username: l.data.username, email: l.data.email ?? "", password: l.data.password, hosts,
        words: [...new Set([word(l.data.name), ...hosts.map((x) => word(siteKey(x).split(".")[0] ?? ""))].filter((w) => w.length > 2))],
        ...(otp ? { otp: otpOf(otp) } : {}),
        uses: counts.get(l.id) ?? 0,
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
    const who = s.username.toLowerCase();
    const same = s.username ? site.find((l) => l.data.username.toLowerCase() === who || (l.data.email ?? "").toLowerCase() === who) : site.length === 1 ? site[0] : undefined;
    if (same) {
      if (same.data.password !== s.password) { vault.update(same.id, { ...same.data, password: s.password }); toast(`Password updated · ${same.data.name}`); }
      continue;
    }
    const host = s.url ? hostOf(s.url) : "";
    const name = host ? (siteKey(host).split(".")[0] ?? host).replace(/^./, (c) => c.toUpperCase()) : (s.app.split(".").filter((p) => !/^(com|org|net|android|app)$/.test(p)).pop() ?? s.app).replace(/^./, (c) => c.toUpperCase());
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.username);
    vault.add({ type: "login", name, urls: host ? [`https://${host}`] : [`androidapp://${s.app}`], username: isEmail ? "" : s.username, ...(isEmail ? { email: s.username } : {}), password: s.password, notes: "" });
    toast(`Login saved · ${name}`);
  }
  if (saves.length) { await save(); renderList(); }
  const picked = platform.takeUses();
  if (picked.length) { await used(picked); renderList(); }
}

// ------------------------------------------------------------------ start
// An otpauth:// link opened while Vault runs (Windows: a second start; Android: MainActivity).
platform.on("link", (p) => { void platform.showWindow(); offerLink(String(p)); });
addEventListener("vault-link", async () => { const l = await platform.takeLaunchLink(); if (l) offerLink(l); });
if (platform.hasAutofill) { setInterval(() => void takeAndroidSaves(), 2000); addEventListener("focus", () => void takeAndroidSaves()); }
if (platform.isDesktopApp) void platform.setLinkHandler(linksOn).catch(() => {});

for (const ev of ["pointerdown", "keydown"]) addEventListener(ev, () => (lastActive = Date.now()));
// A user explicitly starts biometric sign-in. Do not pop a prompt on each Android foreground event.
setInterval(() => {
  if (!platform.isAndroid && vault && lockAfterMin && Date.now() - lastActive > lockAfterMin * 60_000) signInScreen(`Locked after ${lockLabel(lockAfterMin).replace("After ", "")} without use.`, "signin");
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
    vault.add({ type: "login", name: "Discord - Talk, Play, Hang Out with Friends", urls: [], username: "", email: "someone.with.a.long.address@example.com", password: "demo-pw-3", notes: "" });
    vault.add({ type: "totp", otp: normalizeEntry({ issuer: "GitHub", account: "mi@marobotic.dev", secret: "JBSWY3DPEHPK3PXP" }) });
    vault.add({ type: "totp", otp: normalizeEntry({ issuer: "Square Enix", account: "maro", secret: "GEZDGNBVGY3TQOJQ" }) });
    vault.add({ type: "totp", otp: normalizeEntry({ issuer: "Square Enix", account: "maro-alt", secret: "MFRGGZDFMZTWQ2LK" }) });
    vault.add({ type: "totp", otp: normalizeEntry({ issuer: "DigitalOcean", account: "someone.with.a.long.address@example.com", secret: "KRSXG5CTMVRXEZLU" }) });
    // ?dev&many: a big vault, to check Vault stays quick with hundreds of entries.
    if (location.search.includes("many")) for (let n = 0; n < 300; n++) {
      vault.add({ type: "login", name: `Site ${n}`, urls: [`https://site${n}.example`], username: `me${n}`, password: `pw-${n}`, notes: "" });
      if (n < 120) vault.add({ type: "totp", otp: normalizeEntry({ issuer: `Site ${n * 2}`, account: `me${n}@example.com`, secret: "JBSWY3DPEHPK3PXP" }) });
    }
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

