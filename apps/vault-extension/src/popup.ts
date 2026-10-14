/// <reference types="chrome" />
// The toolbar popup: connect this browser to Vault, see this site's logins and 2FA codes, search
// everything, and generate a password.
import { generatePassword } from "../../vault/src/passwords.ts";
import { send, type CodeHit, type LoginHit, type Matches } from "./messages.ts";

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const main = $("#main");
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
type Status = { offline: boolean; paired: boolean; locked: boolean; takeover: boolean };

function setState(text: string, color: string) {
  $("#state").textContent = text;
  $("#state").style.setProperty("--st", color);
}

async function copy(text: string, el?: HTMLElement, label = "Copied") {
  await navigator.clipboard.writeText(text);
  if (el) { const old = el.innerHTML; el.textContent = label; el.classList.add("ok"); setTimeout(() => { el.innerHTML = old; el.classList.remove("ok"); }, 1200); }
}

async function start() {
  const st = await send<Status>({ t: "status" });
  $("#takeover").classList.toggle("on", st.takeover);
  if (st.offline) {
    setState("Vault isn't running", "var(--orange)");
    main.innerHTML = `<div class="msg">Open the Vault app on this PC: the extension fills from it.<br><span style="color:var(--faint)">Vault keeps running in the tray when you close its window.</span></div>`;
    return;
  }
  if (!st.paired) return pairScreen();
  $("#foot").hidden = false;
  if (st.locked) {
    setState("Locked", "var(--orange)");
    main.innerHTML = `<div class="msg">Vault is locked.<button class="primary" id="unlock">Open Vault to sign in</button></div>`;
    $("#unlock").onclick = () => { void send({ t: "open" }); window.close(); };
    return;
  }
  setState("Connected", "var(--teal)");
  main.innerHTML = `<input class="search" id="q" placeholder="Search Vault" autofocus><div id="list"></div>`;
  const q = $<HTMLInputElement>("#q");
  let timer = 0;
  q.oninput = () => { clearTimeout(timer); timer = window.setTimeout(() => void render(q.value.trim()), 150); };
  await render("");
}

function pairScreen() {
  setState("Not connected", "var(--faint)");
  main.innerHTML = `<div class="msg">Connect this browser to the Vault app on this PC, so it can fill your logins and 2FA codes.
    <button class="primary" id="pair">Connect</button></div>`;
  $("#pair").onclick = async () => {
    const code = String(1000 + (crypto.getRandomValues(new Uint16Array(1))[0]! % 9000));
    main.innerHTML = `<div class="msg">Vault asks you to allow this browser. Click <b>Allow</b> there if it shows:<div class="pair">${code}</div><span style="color:var(--faint)">Waiting for Vault…</span></div>`;
    const r = await send<{ ok?: boolean; error?: string }>({ t: "pair", code });
    if (r.ok) return void start();
    main.innerHTML = `<div class="msg">${r.error === "locked" ? "Vault is locked. Sign in to Vault first, then connect." : r.error === "denied" ? "Vault didn't allow it." : "Vault didn't answer in time."}
      <button class="primary" id="again">Try again</button></div>`;
    $("#again").onclick = () => pairScreen();
    if (r.error === "locked") void send({ t: "open" });
  };
}

function loginRow(l: LoginHit, here: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `<div class="txt"><b>${esc(l.username || l.name)}</b><span>${esc(l.name)}${l.site ? ` · ${esc(l.site)}` : ""}</span></div>
    <div class="acts">${here ? `<button class="primary" data-fill>Fill</button>` : ""}<button data-u title="Copy username">&#xf007;</button><button data-p title="Copy password">&#xf084;</button></div>`;
  row.querySelector<HTMLElement>("[data-fill]")?.addEventListener("click", async () => { await send({ t: "fillTab", id: l.id }); window.close(); });
  const secret = () => send<{ username?: string; password?: string }>({ t: "secret", id: l.id });
  row.querySelector<HTMLElement>("[data-u]")!.onclick = async (e) => { const s = await secret(); await copy(s.username ?? "", e.currentTarget as HTMLElement, "✓"); };
  row.querySelector<HTMLElement>("[data-p]")!.onclick = async (e) => { const s = await secret(); await copy(s.password ?? "", e.currentTarget as HTMLElement, "✓"); };
  return row;
}

function codeRow(c: CodeHit): HTMLElement {
  const row = document.createElement("div");
  row.className = "row code";
  row.title = "Copy the code";
  const show = c.code.length === 6 ? `${c.code.slice(0, 3)} ${c.code.slice(3)}` : c.code;
  row.innerHTML = `<div class="txt"><b>${esc(c.account || c.issuer)}</b><span>${esc(c.issuer)} · ${c.remaining}s</span></div><div class="otp ${c.remaining <= 5 ? "low" : ""}">${esc(show)}</div>`;
  row.onclick = async () => { const s = await send<{ code?: string }>({ t: "secret", id: c.id }); if (s.code) await copy(s.code, row.querySelector<HTMLElement>(".otp")!); };
  return row;
}

async function render(q: string) {
  const list = $("#list");
  const parts: HTMLElement[] = [];
  const h2 = (t: string) => { const e = document.createElement("h2"); e.textContent = t; return e; };
  if (!q) {
    const m = await send<Matches>({ t: "tabMatch" });
    if (m.locked) return void start();
    if (m.logins?.length || m.codes?.length) {
      parts.push(h2(m.site ? `On ${m.site}` : "This site"));
      for (const l of m.logins ?? []) parts.push(loginRow(l, true));
      for (const c of m.codes ?? []) parts.push(codeRow(c));
    } else {
      const p = document.createElement("div");
      p.className = "msg";
      p.textContent = m.site ? `Nothing saved for ${m.site}. Search for anything in Vault above.` : "Search for anything in Vault above.";
      parts.push(p);
    }
  } else {
    const r = await send<Matches>({ t: "search", q });
    if (r.logins?.length) { parts.push(h2("Logins")); for (const l of r.logins) parts.push(loginRow(l, false)); }
    if (r.codes?.length) { parts.push(h2("2FA codes")); for (const c of r.codes) parts.push(codeRow(c)); }
    if (!parts.length) { const p = document.createElement("div"); p.className = "msg"; p.textContent = "Nothing matches."; parts.push(p); }
  }
  if (!q) {
    const { sites } = await send<{ sites: string[] }>({ t: "never" });
    if (sites.length) {
      const p = document.createElement("div");
      p.className = "never";
      p.innerHTML = `Never saving logins on ${sites.length} site${sites.length === 1 ? "" : "s"}. <button>Ask again</button>`;
      p.querySelector("button")!.onclick = async () => { for (const site of sites) await send({ t: "unnever", site }); p.remove(); };
      parts.push(p);
    }
  }
  list.replaceChildren(...parts);
}

$("#openApp").onclick = () => { void send({ t: "open" }); window.close(); };
$("#takeover").onclick = async () => {
  const on = !$("#takeover").classList.contains("on");
  $("#takeover").classList.toggle("on", on);
  await send({ t: "takeover", on });
};
$("#gen").onclick = async (e) => {
  const b = e.currentTarget as HTMLElement;
  await copy(generatePassword({ length: 20 }), b, "Copied a new password");
};
void start();
