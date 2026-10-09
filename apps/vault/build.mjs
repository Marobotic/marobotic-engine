// Builds Vault's window into dist/: one bundled script, the Marochy kit and the shared font.
// The Tauri shell loads dist/ as its frontend; `node build.mjs` is all it needs.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const dist = here("./dist/");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
await build({
  entryPoints: [here("./ui/main.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  outfile: here("./dist/main.js"),
  logLevel: "warning",
});
for (const f of ["index.html", "vault.css"]) cpSync(here(`./ui/${f}`), here(`./dist/${f}`));
for (const f of ["marochy.css", "engine.css", "fonts"]) cpSync(here(`../../packages/ui/${f}`), here(`./dist/${f}`), { recursive: true });
console.log("built apps/vault/dist");
