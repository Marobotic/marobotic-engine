// Vault's window: set up, unlock, and the 2FA codes. Everything secret is opened here, on the device;
// what the platform layer stores is the sealed file.
import { init, KDF_V1 } from "@marobotic/crypto";
import { totp, normalizeEntry, type OtpEntry } from "@marobotic/otp";
import { importText, type ImportResult } from "@marobotic/importers";
import { Vault, type VaultFile, type Item, type TotpItem } from "../src/vault.ts";
import { findFfxivEntry, sendWhenAsked } from "../src/xivlauncher.ts";
import jsQRModule from "jsqr";
// jsqr is CommonJS with a default export: bundlers and TypeScript disagree on which object that is.
const jsQR = ((jsQRModule as unknown as { default?: unknown }).default ?? jsQRModule) as unknown as typeof import("jsqr").default;
import * as platform from "./platform.ts";

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const app = $("#app");
const LOCK_AFTER_MS = 10 * 60_000;

let vault: Vault | null = null;
let file: VaultFile | null = null;
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
}

// ------------------------------------------------------------------ first run
function setupScreen() {
  app.replaceChildren(h(`
    <form class="gate">
      <div class="brand"><span class="logo"></span> Vault</div>
      <h1>Set up your vault</h1>
      <p>Use your marobotic account's email and password. They encrypt the vault here, on this PC; the server will only ever store it sealed.</p>
      <label class="lab" for="em">Email</label><input id="em" class="m-field" type="email" autocomplete="username" required>
      <label class="lab" for="pw">Password</label><input id="pw" class="m-field" type="password" autocomplete="new-password" required minlength="8">
      <label class="lab" for="pw2">Password again</label><input id="pw2" class="m-field" type="password" autocomplete="new-password" required>
      <div class="err" id="err"></div>
      <button class="m-btn primary" type="submit">Create vault</button>
    </form>`));
  const form = $<HTMLFormElement>("form", app);
  $("#em", form).focus();
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const email = $<HTMLInputElement>("#em").value.trim();
    const pw = $<HTMLInputElement>("#pw").value;
    if (pw !== $<HTMLInputElement>("#pw2").value) return void ($("#err").textContent = "The two passwords are different.");
    if (pw.length < 8) return void ($("#err").textContent = "Use at least 8 characters.");
    $("#err").textContent = "";
    const btn = $<HTMLButtonElement>("button", form);
    btn.disabled = true; btn.textContent = "Creating…";
    await new Promise((r) => setTimeout(r, 30)); // let the label paint before Argon2 runs
    const made = Vault.create(email, pw, { kdf: KDF_V1 });
    vault = made.vault;
    await save();
    recoveryScreen(made.recoveryCode);
  };
}

function recoveryScreen(code: string) {
  app.replaceChildren(h(`
    <div class="gate">
      <div class="brand"><span class="logo"></span> Vault</div>
      <h1>Your recovery kit</h1>
      <p>Write this down or print it, and keep it somewhere safe. It is the <b>only</b> way back into this vault if your account password is ever reset. It is shown once; nobody, including the server, can show it again.</p>
      <div class="kit">${esc(code)}</div>
      <button class="m-btn" id="copy"> Copy</button>
      <label class="check"><input type="checkbox" id="ok"> I have written it down</label>
      <button class="m-btn primary" id="go" disabled>Open my vault</button>
    </div>`));
  $("#copy").onclick = async () => { await navigator.clipboard.writeText(code); toast("Recovery kit copied - paste it somewhere safe, then clear it"); };
  $<HTMLInputElement>("#ok").onchange = (e) => ($<HTMLButtonElement>("#go").disabled = !(e.target as HTMLInputElement).checked);
  $("#go").onclick = () => codesScreen();
}

// ------------------------------------------------------------------ unlock
function unlockScreen(message = "") {
  vault = null;
  stopAutoXl();
  app.replaceChildren(h(`
    <form class="gate">
      <div class="brand"><span class="logo"></span> Vault</div>
      <h1>Unlock</h1>
      <p>${esc(file!.email)}</p>
      <input id="pw" class="m-field" type="password" autocomplete="current-password" placeholder="Password" required>
      <div class="err" id="err">${esc(message)}</div>
      <button class="m-btn primary" type="submit">Unlock</button>
      <button class="m-btn subtle" type="button" id="rec">Use the recovery kit instead</button>
    </form>`));
  const form = $<HTMLFormElement>("form", app);
  $("#pw", form).focus();
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = $<HTMLButtonElement>("button[type=submit]", form);
    btn.disabled = true; btn.textContent = "Unlocking…";
    await new Promise((r) => setTimeout(r, 30));
    try {
      vault = Vault.unlock(file!, $<HTMLInputElement>("#pw").value);
      codesScreen();
    } catch (e) {
      btn.disabled = false; btn.textContent = "Unlock";
      $("#err").textContent = (e as Error).message === "wrong password" ? "That password doesn't open this vault." : (e as Error).message;
    }
  };
  $("#rec").onclick = () => recoveryUnlockScreen();
}

function recoveryUnlockScreen() {
  app.replaceChildren(h(`
    <form class="gate">
      <div class="brand"><span class="logo"></span> Vault</div>
      <h1>Recovery kit</h1>
      <p>Type the 52 letters from your recovery kit (dashes and spaces don't matter), then choose the password the vault opens with from now on.</p>
      <textarea id="code" class="m-field" style="height:90px;padding:10px" required></textarea>
      <input id="pw" class="m-field" type="password" placeholder="New password" autocomplete="new-password" minlength="8" required>
      <div class="err" id="err"></div>
      <button class="m-btn primary" type="submit">Open and set the password</button>
      <button class="m-btn subtle" type="button" id="back">Back</button>
    </form>`));
  $("#back").onclick = () => unlockScreen();
  $<HTMLFormElement>("form", app).onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      vault = Vault.unlockWithRecovery(file!, $<HTMLTextAreaElement>("#code").value);
      vault.setPassword($<HTMLInputElement>("#pw").value);
      await save();
      codesScreen();
      toast("Opened with the recovery kit; the vault now opens with your new password");
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
    <input class="m-field search" id="q" placeholder="Search" value="${esc(query)}">
    <h2 class="m-section">2FA CODES <span class="detail" id="count"></span></h2>
    <div id="list"></div>`));
  $("#add").onclick = () => addModal();
  $("#lock").onclick = () => unlockScreen();
  $<HTMLInputElement>("#q").oninput = (e) => { query = (e.target as HTMLInputElement).value; renderList(); };
  renderList();
  if (autoXl) startAutoXl();
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
  if (vault && Date.now() - lastActive > LOCK_AFTER_MS) unlockScreen("Locked after 10 minutes without use.");
  else if (vault) tick();
}, 1000);

(async () => {
  await init();
  const text = await platform.loadVault();
  if (!text) return setupScreen();
  try {
    file = JSON.parse(text) as VaultFile;
    unlockScreen();
  } catch {
    app.replaceChildren(h(`<div class="center">The vault file couldn't be read. It has not been changed.<br><span class="faint">${esc(await platform.vaultPath())}</span></div>`));
  }
})();

