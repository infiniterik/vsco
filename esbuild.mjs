// Bundles the extension and the two hook scripts into self-contained CommonJS.
//
// - extension.js   : loaded by VS Code (vscode is external). pdf.js is marked
//                    external because the extension never parses PDFs — keeping it
//                    out of this bundle. (pdf.js is only ever imported lazily, inside
//                    docs.extractText, which the extension does not call.)
// - hooks/*.js     : run as standalone Node processes by the agent hooks; pdf.js IS
//                    bundled in so PDF reading works with no npm install in the
//                    target workspace.
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

rmSync("dist", { recursive: true, force: true });

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  legalComments: "none",
  logLevel: "info",
};

// VS Code extension entry — lean, no pdf.js.
await build({
  ...common,
  entryPoints: { extension: "src/extension.ts" },
  outdir: "dist",
  external: ["vscode", "pdfjs-dist", "pdfjs-dist/*"],
});

// Hook runtimes — self-contained, pdf.js bundled in.
await build({
  ...common,
  entryPoints: {
    "hooks/inject-catalog": "src/hooks/inject-catalog.ts",
    "hooks/react-step": "src/hooks/react-step.ts",
    "hooks/pre-compact": "src/hooks/pre-compact.ts",
  },
  outdir: "dist",
  external: ["canvas"], // optional native dep of pdf.js, not needed for text extraction
});

// Ship pdf.js's worker module next to the hooks. pdf.js loads it (as a fake worker,
// on the main thread) for text extraction; it resolves the file relative to the
// running script, i.e. .react-byok/hooks/pdf.worker.mjs.
const worker = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
mkdirSync("dist/hooks", { recursive: true });
copyFileSync(worker, "dist/hooks/pdf.worker.mjs");

console.log("esbuild: bundled extension + hooks (+ pdf worker)");
