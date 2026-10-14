/// <reference types="chrome" />
// Vault on a web page: finds the sign-in, new-password and 2FA fields, offers the matching logins,
// a strong new password or the current 2FA code under the field, fills what you pick, and offers to
// save a login after you sign in with one Vault doesn't know yet. Everything is drawn in a closed
// shadow root, so the page can neither style nor read it.
import { generatePassword } from "../../vault/src/passwords.ts";
import { send, type CodeHit, type LoginHit, type Matches, type Offer } from "./messages.ts";

type Kind = "username" | "password" | "newPassword" | "otp";

const OTP_RE = /one.?time|\botp\b|totp|2fa|mfa|two.?factor|two.?step|verification.?code|verify|security.?code|auth\w*.?code|passcode|\bcode\b|\btoken\b|\bpin\b/i;
const NOT_OTP_RE = /zip|postal|promo|coupon|discount|country|area.?code|captcha|gift|referral|invite|voucher|search/i;
const USER_RE = /user|e-?mail|login|account|identifier|\bident|member|\bid\b|phone|mobile/i;
const SIGNUP_RE = /sign.?up|register|registration|create.?account|join|new.?pass|confirm|change.?pass|reset|repeat|retype|again/i;
const SUBMIT_RE = /log.?in|sign.?in|next|continue|submit|verify|save|register|sign.?up|create|update|change|weiter|anmelden|connexion/i;

const visible = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  const s = getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
};
const labelOf = (el: HTMLInputElement) => [...(el.labels ?? [])].map((l) => l.textContent ?? "").join(" ");
const attrs = (el: HTMLInputElement) => [el.name, el.id, el.placeholder, el.getAttribute("aria-label"), el.getAttribute("autocomplete"), el.getAttribute("data-testid"), labelOf(el)].join(" ");
const inputs = (scope: ParentNode) => [...scope.querySelectorAll<HTMLInputElement>("input")].filter((i) => !i.disabled && visible(i));
const scopeOf = (el: Element) => (el as HTMLInputElement).form ?? el.closest("form") ?? document;

function isSignup(el: HTMLInputElement): boolean {
  const pws = inputs(scopeOf(el)).filter((i) => i.type === "password");
  if (pws.length >= 2) return true;
  const form = el.form;
  return SIGNUP_RE.test(attrs(el)) || SIGNUP_RE.test(form?.getAttribute("action") ?? "") || /sign.?up|register|join|create/i.test(location.pathname);
}

/** Single-digit boxes of a 2FA code ("_ _ _ _ _ _"), or [] when the field is a whole code. */
function digitBoxes(el: HTMLInputElement): HTMLInputElement[] {
  if (el.maxLength !== 1) return [];
  for (let p: HTMLElement | null = el.parentElement, depth = 0; p && depth < 4; p = p.parentElement, depth++) {
    const boxes = inputs(p).filter((i) => i.maxLength === 1 && i.type !== "password" && i.type !== "hidden");
    if (boxes.length >= 4 && boxes.length <= 8) return boxes;
  }
  return [];
}

function kindOf(el: EventTarget | null): Kind | null {
  if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly) return null;
  const type = el.type.toLowerCase();
  const ac = (el.getAttribute("autocomplete") ?? "").toLowerCase();
  if (type === "password") return ac.includes("current-password") ? "password" : ac.includes("new-password") || isSignup(el) ? "newPassword" : "password";
  if (!["text", "email", "tel", "number", ""].includes(type)) return null;
  const a = attrs(el);
  if (ac.includes("one-time-code") || digitBoxes(el).length) return "otp";
  if (OTP_RE.test(a) && !NOT_OTP_RE.test(a) && !/e-?mail|user/i.test(a)) return "otp";
  if (ac.includes("username") || ac.startsWith("email") || type === "email" || USER_RE.test(a)) return "username";
  // A plain text box right before a password box is the name for it.
  const all = inputs(scopeOf(el));
  const next = all[all.indexOf(el) + 1];
  return next?.type === "password" ? "username" : null;
}

/** The name field that goes with a password field (or the one focused). */
function userFieldFor(scope: ParentNode, pw?: HTMLInputElement): HTMLInputElement | undefined {
  const all = inputs(scope);
  const before = pw ? all.slice(0, all.indexOf(pw)) : all;
  return [...before].reverse().find((i) => kindOf(i) === "username") ?? before.reverse().find((i) => ["text", "email", "tel"].includes(i.type));
}

/** Typed, the way a person would: frameworks (React, Vue, Angular) see the change. */
function setValue(el: HTMLInputElement, value: string) {
  el.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function fillLogin(username: string, password: string, anchor?: HTMLInputElement) {
  const scope = anchor ? scopeOf(anchor) : document;
  const pw = inputs(scope).find((i) => i.type === "password");
  const user = anchor && kindOf(anchor) === "username" ? anchor : userFieldFor(scope, pw);
  if (user && username) setValue(user, username);
  if (pw && password) setValue(pw, password);
  (pw ?? user)?.focus();
}

function fillCode(code: string, anchor?: HTMLInputElement) {
  const field = anchor ?? inputs(document).find((i) => kindOf(i) === "otp");
  if (!field) return;
  const boxes = digitBoxes(field);
  if (boxes.length) boxes.forEach((b, i) => code[i] !== undefined && setValue(b, code[i]!));
  else setValue(field, code);
}

function fillNewPassword(pw: string, anchor: HTMLInputElement) {
  for (const i of inputs(scopeOf(anchor))) if (i.type === "password" && kindOf(i) === "newPassword") setValue(i, pw);
  anchor.focus();
}

// ------------------------------------------------------------------ the dropdown under a field
const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.box, .bar { font: 13px/1.35 ui-monospace, "JetBrainsMono Nerd Font", "Cascadia Mono", Consolas, monospace; color: #f5f5f5; background: #1c1c1c;
  border: 1px solid #3a3a3a; box-shadow: 0 10px 28px rgba(0,0,0,.45); }
.box { position: fixed; min-width: 260px; max-width: 380px; max-height: 340px; overflow-y: auto; }
.head { display: flex; align-items: center; gap: 8px; padding: 7px 10px; color: #969696; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; border-bottom: 1px solid #2d2d2d; }
.head b { color: #B14242; font-size: 13px; letter-spacing: 0; }
.it { display: flex; align-items: center; gap: 10px; padding: 8px 10px; cursor: pointer; border-left: 3px solid transparent; }
.it:hover, .it.sel { background: #252525; border-left-color: #B14242; }
.txt { min-width: 0; flex: 1; }
.txt b { display: block; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.txt span { display: block; color: #969696; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.code { font: 700 17px ui-monospace, Consolas, monospace; letter-spacing: 2px; }
.code.low { color: #e07a7a; }
.ring { width: 3px; align-self: stretch; background: #323232; position: relative; }
.ring i { position: absolute; left: 0; right: 0; bottom: 0; background: #4A8B8B; }
.pw { color: #F0BE66; font-size: 12px; }
.msg { padding: 10px; color: #969696; }
.bar { position: fixed; top: 14px; right: 14px; width: 340px; padding: 14px; display: grid; gap: 10px; border-left: 3px solid #B14242; }
.bar .t { font-weight: 700; font-size: 14px; }
.bar .s { color: #969696; font-size: 12px; overflow-wrap: anywhere; }
.row { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
button { font: inherit; font-size: 12px; height: 28px; padding: 0 12px; border: 1px solid #3a3a3a; background: transparent; color: #f5f5f5; cursor: pointer; }
button:hover { background: #2a2a2a; }
button.primary { background: #B14242; border-color: #B14242; color: #fff; font-weight: 700; }
button.primary:hover { background: #c05555; }
button.quiet { border: 0; color: #969696; }
`;

let host: HTMLElement | null = null;
let root: ShadowRoot;
function shadow(): ShadowRoot {
  if (!host || !host.isConnected) {
    host = document.createElement("vault-ui");
    host.style.cssText = "all: initial; position: fixed; inset: 0 auto auto 0; width: 0; height: 0; z-index: 2147483647;";
    root = host.attachShadow({ mode: "closed" });
    const st = document.createElement("style");
    st.textContent = CSS;
    root.append(st);
    document.documentElement.append(host);
  }
  return root;
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let box: HTMLElement | null = null;
let boxFor: HTMLInputElement | null = null;
let items: { el: HTMLElement; run: () => void }[] = [];
let sel = -1;

function closeBox() { box?.remove(); box = null; boxFor = null; items = []; sel = -1; }

function place() {
  if (!box || !boxFor) return;
  if (!boxFor.isConnected || !visible(boxFor)) return closeBox();
  const r = boxFor.getBoundingClientRect();
  const below = innerHeight - r.bottom > 220 || r.top < 220;
  box.style.left = `${Math.max(4, Math.min(r.left, innerWidth - box.offsetWidth - 4))}px`;
  box.style.top = below ? `${r.bottom + 4}px` : `${Math.max(4, r.top - box.offsetHeight - 4)}px`;
  box.style.width = `${Math.max(260, Math.min(380, r.width))}px`;
}
addEventListener("scroll", place, true);
addEventListener("resize", place);

function openBox(field: HTMLInputElement, head: string, build: (add: (html: string, run: () => void) => void, msg: (text: string) => void) => void) {
  closeBox();
  const r = shadow();
  box = document.createElement("div");
  box.className = "box";
  box.innerHTML = `<div class="head"><b>&#x1F512;&#xFE0E;</b> Vault · ${esc(head)}</div>`;
  box.addEventListener("mousedown", (e) => e.preventDefault());   // keep the page field focused
  build(
    (html, run) => {
      const el = document.createElement("div");
      el.className = "it";
      el.innerHTML = html;
      el.onclick = () => { closeBox(); run(); };
      box!.append(el);
      items.push({ el, run });
    },
    (text) => { const m = document.createElement("div"); m.className = "msg"; m.textContent = text; box!.append(m); },
  );
  r.append(box);
  boxFor = field;
  place();
}

// ------------------------------------------------------------------ what to offer
let cache: { at: number; data: Matches } | null = null;
async function matches(fresh = false): Promise<Matches> {
  if (!fresh && cache && Date.now() - cache.at < 15_000) return cache.data;
  const data = await send<Matches>({ t: "match" }).catch(() => ({ error: "offline" }) as Matches);
  cache = { at: Date.now(), data };
  return data;
}

const loginHtml = (l: LoginHit) => `<div class="txt"><b>${esc(l.username || l.name)}</b><span>${esc(l.name)}${l.site ? ` · ${esc(l.site)}` : ""}</span></div>`;
const codeHtml = (c: CodeHit) => `<div class="txt"><b>${esc(c.account || c.issuer)}</b><span>${esc(c.issuer)}</span></div>
  <div class="code ${c.remaining <= 5 ? "low" : ""}">${esc(c.code.length === 6 ? `${c.code.slice(0, 3)} ${c.code.slice(3)}` : c.code)}</div>
  <div class="ring"><i style="height:${Math.round((c.remaining / c.period) * 100)}%"></i></div>`;

function problem(m: Matches, msg: (t: string) => void, add: (h: string, run: () => void) => void): boolean {
  if (m.locked) { add(`<div class="txt"><b>Vault is locked</b><span>Open Vault and sign in, then come back</span></div>`, () => void send({ t: "open" })); return true; }
  if (m.error === "unpaired") { msg("Connect this browser: click the Vault icon in the toolbar."); return true; }
  if (m.error) return true;
  return false;
}

async function offerFor(field: HTMLInputElement, why: "focus" | "click") {
  const kind = kindOf(field);
  if (!kind) return;
  const m = await matches(kind === "otp");
  if (document.activeElement !== field) return;
  const logins = m.logins ?? [], codes = m.codes ?? [];

  if (kind === "otp") {
    if (!codes.length && !m.locked && why === "focus") return;
    return openBox(field, "2FA code", (add, msg) => {
      if (problem(m, msg, add)) return;
      if (!codes.length) return msg("No 2FA code saved for this site.");
      for (const c of codes) add(codeHtml(c), async () => { const r = await send<{ code?: string }>({ t: "code", id: c.id }); if (r.code) fillCode(r.code, field); });
    });
  }

  if (kind === "newPassword") {
    const pw = generatePassword({ length: 20 });
    return openBox(field, "new password", (add) => {
      add(`<div class="txt"><b>Use a strong password</b><span class="pw">${esc(pw)}</span></div>`, () => fillNewPassword(pw, field));
      if (!m.error && !m.locked) for (const l of logins) add(loginHtml(l), () => void fillFrom(l.id, field));
    });
  }

  // username / password
  if (!logins.length && !m.locked && !(m.error === "unpaired" && kind === "password")) return;
  if (m.error && m.error !== "unpaired") return;
  openBox(field, "sign in", (add, msg) => {
    if (problem(m, msg, add)) return;
    for (const l of logins) add(loginHtml(l), () => void fillFrom(l.id, field));
  });
}

async function fillFrom(id: string, field?: HTMLInputElement) {
  const r = await send<{ username?: string; password?: string; error?: string }>({ t: "fill", id });
  if (r.error) return;
  fillLogin(r.username ?? "", r.password ?? "", field);
}

document.addEventListener("focusin", (e) => { const t = e.target; if (t instanceof HTMLInputElement && t !== boxFor) void offerFor(t, "focus"); }, true);
document.addEventListener("click", (e) => { const t = e.target; if (t instanceof HTMLInputElement && t !== boxFor && kindOf(t)) void offerFor(t, "click"); }, true);
document.addEventListener("focusout", () => setTimeout(() => { if (box && document.activeElement !== boxFor) closeBox(); }, 150), true);
document.addEventListener("keydown", (e) => {
  if (!box || e.target !== boxFor) return;
  if (e.key === "Escape") return closeBox();
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(1, items.length);
    items.forEach((it, i) => it.el.classList.toggle("sel", i === sel));
  } else if (e.key === "Enter" && sel >= 0 && items[sel]) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const run = items[sel]!.run;
    closeBox();
    run();
  }
}, true);

// ------------------------------------------------------------------ noticing a sign-in, to save it
let lastSent = { key: "", at: 0 };
function captured(scope: ParentNode) {
  const pws = inputs(scope).filter((i) => i.type === "password" && i.value);
  if (!pws.length) {
    const user = inputs(scope).find((i) => kindOf(i) === "username" && i.value);
    if (user) void send({ t: "lastUser", username: user.value.trim() });
    return;
  }
  // A change-password form (current, new, confirm): the new one is the one typed twice.
  let pw = pws[0]!;
  for (let i = pws.length - 1; i > 0; i--) if (pws[i]!.value === pws[i - 1]!.value) { pw = pws[i]!; break; }
  const username = userFieldFor(scope, pws[0])?.value.trim() ?? "";
  const key = `${username}\u0000${pw.value}`;
  if (lastSent.key === key && Date.now() - lastSent.at < 4000) return;
  lastSent = { key, at: Date.now() };
  void send({ t: "submitted", username, password: pw.value });
}
document.addEventListener("submit", (e) => captured(e.target as HTMLFormElement), true);
document.addEventListener("click", (e) => {
  const b = (e.target as Element | null)?.closest?.("button, input[type=submit], input[type=button], [role=button], a");
  if (!b) return;
  const text = `${b.textContent ?? ""} ${(b as HTMLInputElement).value ?? ""} ${b.getAttribute("aria-label") ?? ""} ${b.id}`;
  if ((b as HTMLButtonElement).type === "submit" || SUBMIT_RE.test(text)) captured(scopeOf(b));
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target instanceof HTMLInputElement) captured(scopeOf(e.target));   // a picked suggestion never gets here
}, true);

// ------------------------------------------------------------------ "Save this login?"
let barEl: HTMLElement | null = null;
function offerSave(o: Offer) {
  barEl?.remove();
  const r = shadow();
  barEl = document.createElement("div");
  barEl.className = "bar";
  const update = o.state === "changed";
  barEl.innerHTML = `<div class="t">${update ? "Update the password in Vault?" : "Save this login to Vault?"}</div>
    <div class="s">${esc(o.username || "(no username)")} · ${esc(o.name ?? o.site)}</div>
    <div class="row"><button class="quiet" data-x>Not now</button>${update ? "" : `<button data-never>Never for this site</button>`}<button class="primary" data-save>${update ? "Update" : "Save"}</button></div>`;
  const done = () => { barEl?.remove(); barEl = null; };
  barEl.querySelector<HTMLElement>("[data-x]")!.onclick = done;
  barEl.querySelector<HTMLElement>("[data-never]")?.addEventListener("click", () => { void send({ t: "save", id: o.id, decision: "never" }); done(); });
  barEl.querySelector<HTMLElement>("[data-save]")!.onclick = async () => {
    const res = await send<{ saved?: string; error?: string; locked?: boolean }>({ t: "save", id: o.id, decision: "save" });
    const s = barEl?.querySelector(".s");
    if (res.saved) { done(); cache = null; }
    else if (s) s.textContent = res.locked ? "Vault is locked: open it and sign in, then sign in here again." : `Couldn't save: ${res.error ?? "Vault isn't running"}`;
  };
  r.append(barEl);
  setTimeout(() => barEl?.isConnected && done(), 45_000);
}

// ------------------------------------------------------------------ from the toolbar and the shortcut
chrome.runtime.onMessage.addListener((m: { t: string } & Record<string, string>) => {
  if (m.t === "offerSave" && window === top) offerSave(m as unknown as Offer);
  if (m.t === "doFill") {
    const focused = document.activeElement instanceof HTMLInputElement ? document.activeElement : undefined;
    if (focused && kindOf(focused) === "otp" && m.code) fillCode(m.code, focused);
    else fillLogin(m.username ?? "", m.password ?? "", focused && kindOf(focused) ? focused : undefined);
  }
  if (m.t === "fillBest") void fillBest();
});

async function fillBest() {
  const focused = document.activeElement instanceof HTMLInputElement ? document.activeElement : undefined;
  const m = await matches(true);
  if (focused && kindOf(focused) === "otp") {
    const c = m.codes?.[0];
    if (c) { const r = await send<{ code?: string }>({ t: "code", id: c.id }); if (r.code) fillCode(r.code, focused); }
    return;
  }
  const l = m.logins?.[0];
  if (l) await fillFrom(l.id, focused && kindOf(focused) ? focused : undefined);
}

if (window === top) void send<Offer | null>({ t: "pending" }).then((o) => o && offerSave(o)).catch(() => {});
