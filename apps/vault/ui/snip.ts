// Picking a QR code on screen, like a snipping tool. One of these covers each monitor while Vault is
// hidden: the monitor's picture, dimmed, and you drag a box around the QR code. The box is read here
// (jsQR), then natively (rqrr) when that finds nothing. Esc or a right click cancels.
import jsQRModule from "jsqr";
const jsQR = ((jsQRModule as unknown as { default?: unknown }).default ?? jsQRModule) as unknown as typeof import("jsqr").default;

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
const invoke = (globalThis as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__!.core!.invoke!;

const shot = document.getElementById("shot") as HTMLCanvasElement;
const veil = document.getElementById("veil") as HTMLCanvasElement;
const hint = document.getElementById("hint")!;
const g = shot.getContext("2d", { willReadFrequently: true })!;
const v = veil.getContext("2d")!;

let start: { x: number; y: number } | null = null;
let box = { x: 0, y: 0, w: 0, h: 0 };
let busy = false;

/** CSS pixels -> the picture's own pixels. */
const at = (e: MouseEvent) => ({ x: Math.round(e.clientX * (shot.width / innerWidth)), y: Math.round(e.clientY * (shot.height / innerHeight)) });

function paint() {
  v.clearRect(0, 0, veil.width, veil.height);
  v.fillStyle = "rgba(0,0,0,0.45)";
  v.fillRect(0, 0, veil.width, veil.height);
  if (box.w < 2 || box.h < 2) return;
  v.clearRect(box.x, box.y, box.w, box.h);
  v.strokeStyle = "#B14242";
  v.lineWidth = Math.max(2, Math.round(shot.width / innerWidth) * 2);
  v.strokeRect(box.x, box.y, box.w, box.h);
}

const say = (text: string) => (hint.textContent = text);
const cancel = () => void invoke("snip_done", { texts: null });

/** The box read by jsQR, as it is and blown up (a small code on a big screen), light and dark. */
function readHere(): string | null {
  for (const scale of [1, 2, 3]) {
    const c = document.createElement("canvas");
    c.width = box.w * scale;
    c.height = box.h * scale;
    const cg = c.getContext("2d")!;
    cg.imageSmoothingEnabled = false;
    cg.drawImage(shot, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
    const hit = jsQR(cg.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: "attemptBoth" });
    if (hit?.data) return hit.data;
  }
  return null;
}

async function pick() {
  if (box.w < 12 || box.h < 12) { box = { x: 0, y: 0, w: 0, h: 0 }; paint(); return say("Drag a box around the QR code · Esc to cancel"); }
  busy = true;
  say("Reading…");
  const here = readHere();
  const texts = here ? [here] : await invoke<string[]>("snip_decode", { ...box }).catch(() => [] as string[]);
  busy = false;
  if (texts.length) return void invoke("snip_done", { texts });
  say("No QR code in that box. Drag again around the whole code, white edge included · Esc to cancel");
}

addEventListener("mousedown", (e) => {
  if (busy) return;
  if (e.button === 2) return cancel();
  if (e.button !== 0) return;
  start = at(e);
  box = { ...start, w: 0, h: 0 };
  paint();
});
addEventListener("mousemove", (e) => {
  if (!start) return;
  const p = at(e);
  box = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
  paint();
});
addEventListener("mouseup", (e) => {
  if (!start || e.button !== 0) return;
  start = null;
  void pick();
});
addEventListener("contextmenu", (e) => e.preventDefault());
addEventListener("keydown", (e) => { if (e.key === "Escape") cancel(); });

(async () => {
  try {
    const buf = new Uint8Array(await invoke<ArrayBuffer>("snip_shot"));
    const dv = new DataView(buf.buffer, buf.byteOffset, 8);
    const w = dv.getUint32(0, true), h = dv.getUint32(4, true);
    shot.width = veil.width = w;
    shot.height = veil.height = h;
    g.putImageData(new ImageData(new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, w * h * 4), w, h), 0, 0);
    paint();
    await invoke("snip_show");
  } catch { cancel(); }
})();
