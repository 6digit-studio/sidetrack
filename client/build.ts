/**
 * Build script for sidetrack-client
 * Outputs: ESM, CJS, and IIFE (browser) bundles
 */

import { $ } from "bun";

const entrypoint = "./src/index.ts";
const outdir = "./dist";

console.log("Building sidetrack-client...\n");

// ESM build
await Bun.build({
  entrypoints: [entrypoint],
  outdir,
  naming: "index.mjs",
  format: "esm",
  target: "browser", // broadest compatibility
  minify: false,     // keep readable for debugging
});
console.log("  ESM build complete");

// CJS build (for Node require())
await Bun.build({
  entrypoints: [entrypoint],
  outdir,
  naming: "index.cjs",
  format: "cjs",
  target: "node",
  minify: false,
});
console.log("  CJS build complete");

// IIFE build for <script> tag (auto-initializes)
await Bun.build({
  entrypoints: ["./src/browser.ts"],
  outdir,
  naming: "sidetrack.js",
  format: "iife",
  target: "browser",
  minify: false,
});
console.log("  IIFE (browser) build complete");

// Generate .d.ts files
await $`bunx tsc --emitDeclarationOnly --declaration --declarationDir ${outdir}`.quiet();
console.log("  TypeScript declarations complete");

console.log("\nBuild complete!");
