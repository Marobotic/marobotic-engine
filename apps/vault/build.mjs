// Builds Vault's window into dist/: one bundled script (and the QR picker's, snip.html), the Marochy kit and the shared font.
// The Tauri shell loads dist/ as its frontend; `node build.mjs` is all it needs.
import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const dist = here("./dist/");
// Empty dist/ rather than delete it: a window or server holding the folder open must not break a build.
mkdirSync(dist, { recursive: true });
for (const f of readdirSync(dist)) rmSync(`${dist}${f}`, { recursive: true, force: true });
for (const name of ["main", "snip"]) await build({
  entryPoints: [here(`./ui/${name}.ts`)],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  outfile: here(`./dist/${name}.js`),
  logLevel: "warning",
  // The shared packages straight from packages/: some shells can't follow node_modules' junctions.
  alias: Object.fromEntries(["crypto", "otp", "importers"].map((p) => [`@marobotic/${p}`, here(`../../packages/${p}/src/index.ts`)])),
});
for (const f of ["index.html", "snip.html", "vault.css"]) cpSync(here(`./ui/${f}`), here(`./dist/${f}`));
for (const f of ["marochy.css", "engine.css", "fonts"]) cpSync(here(`../../packages/ui/${f}`), here(`./dist/${f}`), { recursive: true });
console.log("built apps/vault/dist");
