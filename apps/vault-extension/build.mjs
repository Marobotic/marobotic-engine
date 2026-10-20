// Builds the extension into dist/ (load it unpacked in Chrome, Brave or Edge, or zip it for the store).
import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
// --e2e: the same extension against an in-memory account (e2e/mock-account.ts), into e2e/dist/.
const e2e = process.argv.includes("--e2e");
const dist = here(e2e ? "./e2e/dist/" : "./dist/");
const mockAccount = {
  name: "mock-account",
  setup(b) { b.onResolve({ filter: /ui[\/]account\.ts$/ }, () => ({ path: here("./e2e/mock-account.ts") })); },
};
mkdirSync(dist, { recursive: true });
for (const f of readdirSync(dist)) rmSync(`${dist}${f}`, { recursive: true, force: true });
await build({
  entryPoints: { background: here("./src/background.ts"), content: here("./src/content.ts"), popup: here("./src/popup.ts"), inject: here("./src/inject.ts") },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome116",
  minify: true,
  outdir: dist,
  logLevel: "warning",
  plugins: e2e ? [mockAccount] : [],
  // The shared packages straight from packages/: some shells can't follow node_modules' junctions.
  alias: Object.fromEntries(["crypto", "otp", "importers"].map((p) => [`@marobotic/${p}`, here(`../../packages/${p}/src/index.ts`)])),
});
cpSync(here("./static/"), dist, { recursive: true });
cpSync(here("../../packages/ui/fonts"), `${dist}fonts`, { recursive: true });
mkdirSync(`${dist}icons`, { recursive: true });
cpSync(here("../vault/src-tauri/icons/32x32.png"), `${dist}icons/32.png`);
cpSync(here("../vault/src-tauri/icons/128x128.png"), `${dist}icons/128.png`);
console.log(`built ${dist}`);
