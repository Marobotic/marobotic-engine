// Builds Letterbox's web client into dist/: one bundled script, the Marochy kit and the shared font.
// The server (server/server.ts) serves dist/; `node build.mjs` is all it needs.
import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const dist = here("./dist/");
// Empty dist/ rather than delete it: a server holding the folder open must not break a build.
mkdirSync(dist, { recursive: true });
for (const f of readdirSync(dist)) rmSync(`${dist}${f}`, { recursive: true, force: true });
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
for (const f of ["index.html", "letterbox.css", "icon.svg"]) cpSync(here(`./ui/${f}`), here(`./dist/${f}`));
for (const f of ["marochy.css", "engine.css", "fonts"]) cpSync(here(`../../packages/ui/${f}`), here(`./dist/${f}`), { recursive: true });
console.log("built apps/letterbox/dist");
