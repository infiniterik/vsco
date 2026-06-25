import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

import { estimateTokens, type GatheredDoc } from "./context.js";
import { reactDir } from "./debug.js";

export interface ContextConfig {
  enabled: boolean;
  dir: string;
  include: string[];
  exclude: string[];
  budgetTokens: number;
  searchBudgetTokens: number;
  previewChars: number;
  maxFileBytes: number;
  /** Retry HTTPS with TLS verification disabled on a certificate error. */
  allowInsecureTls: boolean;
  /** Folder (relative to workspace root) where arxiv_search saves PDFs + notes. */
  arxivDir: string;
}

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  enabled: true,
  dir: "docs",
  include: [".pdf", ".md", ".txt", ".json", ".tex"],
  exclude: ["node_modules", ".git", "dist", ".react-byok"],
  budgetTokens: 28_000,
  searchBudgetTokens: 6_000,
  previewChars: 600,
  maxFileBytes: 5_000_000,
  allowInsecureTls: true,
  arxivDir: "papers",
};

export function loadContextConfig(): ContextConfig {
  try {
    const raw = readFileSync(reactDir("context.json"), "utf8");
    return { ...DEFAULT_CONTEXT_CONFIG, ...(JSON.parse(raw) as Partial<ContextConfig>) };
  } catch {
    return DEFAULT_CONTEXT_CONFIG;
  }
}

export interface DocEntry {
  /** Absolute path. */
  path: string;
  /** Path relative to the workspace root, used as a stable label. */
  label: string;
  bytes: number;
}

/** Recursively list documents under the configured directory. */
export function listDocuments(cfg: ContextConfig, root = process.cwd()): DocEntry[] {
  const base = resolve(root, cfg.dir);
  const out: DocEntry[] = [];
  const include = new Set(cfg.include.map((e) => e.toLowerCase()));

  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (cfg.exclude.includes(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (include.has(extname(name).toLowerCase()) && st.size <= cfg.maxFileBytes) {
        out.push({ path: full, label: relative(root, full).replace(/\\/g, "/"), bytes: st.size });
      }
    }
  };

  walk(base);
  return out.sort((a, b) => a.bytes - b.bytes); // smallest first (maximize coverage)
}

/** Extract UTF-8/PDF text, cached by path+mtime so PDFs are parsed at most once. */
export async function extractText(path: string): Promise<string> {
  let mtime = 0;
  try {
    mtime = Math.floor(statSync(path).mtimeMs);
  } catch {
    /* fall through to read attempt */
  }
  const key = createHash("sha1").update(`${path}:${mtime}`).digest("hex");
  const cacheFile = reactDir(".cache", `${key}.txt`);
  if (existsSync(cacheFile)) {
    try {
      return readFileSync(cacheFile, "utf8");
    } catch {
      /* re-extract */
    }
  }

  let text: string;
  try {
    text = extname(path).toLowerCase() === ".pdf" ? await extractPdf(path) : readFileSync(path, "utf8");
  } catch (err) {
    return `[could not read ${path}: ${String(err)}]`;
  }

  try {
    mkdirSync(reactDir(".cache"), { recursive: true });
    writeFileSync(cacheFile, text, "utf8");
  } catch {
    /* cache is best-effort */
  }
  return text;
}

/** Extract text from a PDF using pdf.js. Imported lazily so it bundles only into hooks. */
async function extractPdf(path: string): Promise<string> {
  const data = new Uint8Array(readFileSync(path));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // The worker module is shipped next to the bundled hook (see esbuild.mjs). pdf.js
  // loads it on the main thread for text extraction. (__dirname = .react-byok/hooks.)
  try {
    pdfjs.GlobalWorkerOptions.workerSrc = join(__dirname, "pdf.worker.mjs");
  } catch {
    /* fall back to pdf.js default resolution */
  }
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true, verbosity: 0 })
    .promise;
  const parts: string[] = [];
  let total = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pageText = content.items.map((it: any) => ("str" in it ? it.str : "")).join(" ");
    parts.push(pageText);
    total += pageText.length;
    if (total > 2_000_000) break; // safety cap for huge PDFs
  }
  try {
    await doc.cleanup?.();
  } catch {
    /* ignore */
  }
  return parts.join("\n");
}

/** List, extract, and token-count every configured document. */
export async function gatherDocuments(cfg: ContextConfig, root = process.cwd()): Promise<GatheredDoc[]> {
  const entries = listDocuments(cfg, root);
  const out: GatheredDoc[] = [];
  for (const e of entries) {
    const text = await extractText(e.path);
    if (text.trim()) out.push({ label: e.label, text, tokens: estimateTokens(text) });
  }
  return out;
}

/** Clear the extraction cache (used by the "Re-gather context" command). */
export function clearCache(): void {
  try {
    rmSync(reactDir(".cache"), { recursive: true, force: true });
  } catch {
    /* no cache yet */
  }
}
