// Builds the Chrome / Edge extension into ./extension (load it with "Load unpacked").
import { execSync } from "node:child_process";
import { cpSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { build } from "esbuild";

const out = "extension";
execSync("npx ng build --configuration extension", { stdio: "inherit" });
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
cpSync("dist/extension-app/browser", out, { recursive: true });
// The web app's PWA files aren't needed inside an extension.
for (const f of [
  "ngsw-worker.js",
  "ngsw.json",
  "safety-worker.js",
  "worker-basic.min.js",
  "manifest.webmanifest",
])
  rmSync(`${out}/${f}`, { force: true });

await build({
  entryPoints: {
    background: "ext/background.ts",
    offscreen: "ext/offscreen.ts",
  },
  outdir: out,
  bundle: true,
  format: "esm",
  target: "chrome116",
  minify: true,
  legalComments: "none",
  logLevel: "info",
});
cpSync("ext/manifest.json", `${out}/manifest.json`);
cpSync("ext/offscreen.html", `${out}/offscreen.html`);
cpSync("ext/icons", `${out}/icons`, { recursive: true });
cpSync("ext/lib", `${out}/lib`, { recursive: true }); // Gemma's WebGPU engine code, bundled (no remote code)
// A store-ready zip with manifest.json at the top level.
rmSync("bookmark-buddy-extension.zip", { force: true });
try {
  execSync(`cd ${out} && zip -qr ../bookmark-buddy-extension.zip .`);
} catch {
  console.warn(
    "No zip command found: zip the files *inside* ./extension yourself for the stores.",
  );
}
if (!existsSync(`${out}/index.html`)) throw new Error("App build missing");
console.log(
  `\n🦥 Extension ready in ./${out} (and bookmark-buddy-extension.zip for the stores). In Chrome or Edge: Extensions → Developer mode → Load unpacked → pick that folder.`,
);
