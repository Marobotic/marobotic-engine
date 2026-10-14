// Builds the extension into dist/ (load it unpacked in Chrome, Brave or Edge, or zip it for the store).
import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const dist = here("./dist/");
mkdirSync(dist, { recursive: true });
for (const f of readdirSync(dist)) rmSync(`${dist}${f}`, { recursive: true, force: true });
await build({
  entryPoints: { background: here("./src/background.ts"), content: here("./src/content.ts"), popup: here("./src/popup.ts") },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome116",
  minify: true,
  outdir: dist,
  logLevel: "warning",
});
cpSync(here("./static/"), dist, { recursive: true });
cpSync(here("../../packages/ui/fonts"), `${dist}fonts`, { recursive: true });
mkdirSync(`${dist}icons`, { recursive: true });
cpSync(here("../vault/src-tauri/icons/32x32.png"), `${dist}icons/32.png`);
cpSync(here("../vault/src-tauri/icons/128x128.png"), `${dist}icons/128.png`);
console.log("built apps/vault-extension/dist");
