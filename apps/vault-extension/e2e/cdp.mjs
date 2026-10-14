// Drives a browser over the DevTools protocol, one command per run, for checking the extension by hand:
//   node --experimental-websocket e2e/cdp.mjs <command> [args]
//   serve                      serve e2e/page.html at http://localhost:8643/page.html (stays running)
//   launch <browser.exe>       a throwaway profile with e2e/dist loaded, debugging on :9333 (stays running)
//   open <url>                 new tab
//   targets                    list tabs and workers
//   eval <match> <js>          evaluate in the first target whose url contains <match>
//   click <match> <x> <y>      a real (trusted) mouse click
//   key <match> <key>          a real key press (Enter, ArrowDown, Tab, Escape, or one character)
//   type <match> <text>        real typing
//   shot <match> <file.png>    screenshot
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

const PORT = 9333;
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const [cmd, ...args] = process.argv.slice(2);

async function targets() { return (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); }
async function target(match) {
  const t = (await targets()).find((x) => x.url.includes(match) && x.webSocketDebuggerUrl);
  if (!t) throw new Error(`no target matching ${match}`);
  return t;
}
async function session(match) {
  const t = await target(match);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const call = (method, params = {}) => new Promise((ok) => { const i = ++id; pending.set(i, ok); ws.send(JSON.stringify({ id: i, method, params })); });
  return { call, close: () => ws.close(), t };
}

const KEYS = { Backspace: [8, ""], Enter: [13, "\r"], ArrowDown: [40, ""], ArrowUp: [38, ""], Tab: [9, ""], Escape: [27, ""] };

switch (cmd) {
  case "serve":
    createServer((q, r) => { r.setHeader("content-type", "text/html"); r.end(readFileSync(here("./page.html"))); }).listen(8643, "127.0.0.1");
    createServer((q, r) => { r.setHeader("content-type", "text/html"); r.end(readFileSync(here("./page.html"))); }).listen(8643, "::1");
    console.log("serving http://localhost:8643/page.html");
    break;
  case "launch": {
    const profile = join(tmpdir(), `vault-e2e-${Date.now()}`);
    mkdirSync(profile, { recursive: true });
    const ext = here("./dist");
    spawn(args[0], [`--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, `--load-extension=${ext}`, `--disable-extensions-except=${ext}`,
      "--no-first-run", "--no-default-browser-check", "--window-size=1200,900", "about:blank"], { stdio: "ignore", detached: true }).unref();
    console.log(`launched with profile ${profile}`);
    break;
  }
  case "open": { const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(args[0])}`, { method: "PUT" }); console.log((await r.json()).id); break; }
  case "targets": for (const t of await targets()) console.log(t.type.padEnd(16), t.url); break;
  case "eval": {
    const s = await session(args[0]);
    const r = await s.call("Runtime.evaluate", { expression: args.slice(1).join(" "), awaitPromise: true, returnByValue: true });
    console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description ?? r.result, null, 1));
    s.close(); break;
  }
  case "click": {
    const s = await session(args[0]);
    const [x, y] = [Number(args[1]), Number(args[2])];
    await s.call("Page.bringToFront");
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await s.call("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    s.close(); break;
  }
  case "key": {
    const s = await session(args[0]);
    const [code, text] = KEYS[args[1]] ?? [args[1].toUpperCase().charCodeAt(0), args[1]];
    await s.call("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: args[1], windowsVirtualKeyCode: code, text });
    await s.call("Input.dispatchKeyEvent", { type: "keyUp", key: args[1], windowsVirtualKeyCode: code });
    s.close(); break;
  }
  case "type": { const s = await session(args[0]); await s.call("Input.insertText", { text: args.slice(1).join(" ") }); s.close(); break; }
  case "shot": {
    const s = await session(args[0]);
    const r = await s.call("Page.captureScreenshot", { format: "png" });
    writeFileSync(args[1], Buffer.from(r.result.data, "base64"));
    console.log(args[1]); s.close(); break;
  }
  default: console.log("commands: serve | launch <exe> | open <url> | targets | eval | click | key | type | shot");
}
