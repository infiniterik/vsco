import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { get as httpsGet, type RequestOptions } from "node:https";
import { dirname, extname, join, resolve as resolvePath } from "node:path";

import { runSearch } from "./context.js";
import { extractText, gatherDocuments, loadContextConfig } from "./docs.js";

/**
 * Single source of truth for the agent's tools.
 *
 * The same definitions are used in two places:
 *   1. `format.ts` renders these into the *text* catalog injected at SessionStart,
 *      because a no-tool-calling model cannot be handed JSON tool schemas over the API.
 *   2. `hooks/react-step.ts` (the Stop hook) dispatches a parsed Action to `execute()`.
 *
 * Because both paths read from here, the model's instructions can never drift from
 * what actually runs.
 */

export interface ToolInputSchema {
  type: "object";
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

export interface ToolResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}

const MAX_OUTPUT = 8_000; // max chars per stream carried back in an Observation
const DEFAULT_TIMEOUT_MS = 30_000;

function truncate(s: string, max = MAX_OUTPUT): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`, truncated: true };
}

/**
 * The single shell-backed tool. Per the chosen design the agent's whole tool
 * surface is "run a command", which keeps the executor inside the Stop hook
 * trivial and avoids a separate tool server.
 */
export const runCommand: Tool = {
  name: "run_command",
  description:
    "Run a shell command in the workspace and return its stdout, stderr, and exit code. " +
    "Use it to read files (cat), list (ls), search (grep/rg), run tests, etc.",
  inputSchema: {
    type: "object",
    properties: {
      cmd: { type: "string", description: "The shell command to execute." },
      cwd: {
        type: "string",
        description: "Optional working directory (defaults to the workspace root).",
      },
    },
    required: ["cmd"],
  },
  async execute(input) {
    const cmd = String(input.cmd ?? "");
    const cwd = input.cwd ? String(input.cwd) : process.cwd();
    if (!cmd.trim()) {
      return { stdout: "", stderr: "Empty command.", exitCode: 1, timedOut: false, truncated: false };
    }
    return await new Promise<ToolResult>((resolve) => {
      const child = spawn(cmd, { shell: true, cwd });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, DEFAULT_TIMEOUT_MS);
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("close", (code) => {
        clearTimeout(timer);
        const o = truncate(stdout);
        const e = truncate(stderr);
        resolve({
          stdout: o.text,
          stderr: e.text,
          exitCode: code,
          timedOut,
          truncated: o.truncated || e.truncated,
        });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ stdout: "", stderr: String(err), exitCode: 1, timedOut, truncated: false });
      });
    });
  },
};

// --- helpers for the dependency-free tools -------------------------------------

function ok(text: string): ToolResult {
  const t = truncate(text);
  return { stdout: t.text, stderr: "", exitCode: 0, timedOut: false, truncated: t.truncated };
}

function fail(message: string): ToolResult {
  return { stdout: "", stderr: message, exitCode: 1, timedOut: false, truncated: false };
}

/** TLS/cert verification failures we are willing to retry without verification. */
export function isCertError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  const code = e?.code ?? "";
  return (
    /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|ALTNAME|TLS/i.test(code) ||
    /certificate|self[- ]signed|unable to (get|verify)/i.test(e?.message ?? "")
  );
}

interface GetOpts {
  /** Retry once with TLS verification disabled if the first attempt hits a cert error. */
  allowInsecure?: boolean;
}

/** One HTTPS GET; `rejectUnauthorized` toggles TLS verification. Collects body bytes. */
function rawGet(url: string, rejectUnauthorized: boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const opts: RequestOptions = {
      headers: { "User-Agent": "react-byok/0.1" },
      rejectUnauthorized,
    };
    const req = httpsGet(url, opts, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        rawGet(new URL(res.headers.location, url).toString(), rejectUnauthorized).then(resolve, reject);
        return;
      }
      if (status >= 400) {
        res.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(DEFAULT_TIMEOUT_MS, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
  });
}

/** HTTPS GET (bytes) with an opt-in insecure retry when the CA chain can't be verified. */
export async function httpGetBuffer(url: string, { allowInsecure = false }: GetOpts = {}): Promise<Buffer> {
  try {
    return await rawGet(url, true);
  } catch (err) {
    if (allowInsecure && isCertError(err)) return rawGet(url, false);
    throw err;
  }
}

/** HTTPS GET returning text, with the same insecure-on-cert-error fallback. */
async function httpGet(url: string, opts: GetOpts = {}): Promise<string> {
  return (await httpGetBuffer(url, opts)).toString("utf8");
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ArxivEntry {
  id: string;
  pdfUrl: string;
  title: string;
  authors: string;
  published: string;
  summary: string;
}

/** Parse an arXiv Atom feed into structured entries. Pure (testable) function. */
export function parseArxivEntries(xml: string): ArxivEntry[] {
  const blocks = xml
    .split("<entry>")
    .slice(1)
    .map((e) => e.split("</entry>")[0]);
  const tag = (block: string, name: string): string => {
    const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(block);
    return m ? decodeXml(m[1]) : "";
  };
  return blocks.map((e) => {
    const id = tag(e, "id");
    const linkPdf = /<link[^>]*title="pdf"[^>]*href="([^"]+)"/i.exec(e)?.[1];
    const pdfUrl = (linkPdf ?? id.replace("/abs/", "/pdf/")).replace(/^http:/, "https:");
    return {
      id,
      pdfUrl: /\.pdf$/.test(pdfUrl) ? pdfUrl : `${pdfUrl}.pdf`,
      title: tag(e, "title"),
      authors: [...e.matchAll(/<name[^>]*>([\s\S]*?)<\/name>/gi)]
        .map((m) => decodeXml(m[1]))
        .slice(0, 8)
        .join(", "),
      published: tag(e, "published").slice(0, 10),
      summary: tag(e, "summary"),
    };
  });
}

/** Render structured entries as the readable text result. */
export function parseArxiv(xml: string, query: string): string {
  const entries = parseArxivEntries(xml);
  if (!entries.length) return `No arXiv results for: ${query}`;
  const out = [`arXiv results for "${query}" (${entries.length}):`, ""];
  entries.forEach((e, i) => {
    out.push(
      `[${i + 1}] ${e.title}`,
      `    Published: ${e.published}  Authors: ${e.authors}`,
      `    Link: ${e.id}`,
      `    Abstract: ${e.summary.length > 500 ? `${e.summary.slice(0, 500)}…` : e.summary}`,
      "",
    );
  });
  return out.join("\n");
}

/** arXiv id URL → a filesystem-safe basename, e.g. ".../abs/2506.06962v3" → "2506.06962v3". */
export function safeArxivId(id: string): string {
  return (id.split("/").pop() || id).replace(/[^\w.-]/g, "_");
}

// --- additional tools ----------------------------------------------------------

export const arxivSearch: Tool = {
  name: "arxiv_search",
  description:
    "Search arXiv and AUTOMATICALLY download every result's PDF into the papers/ folder, " +
    "recording metadata in papers/notes.md. Returns titles, authors, links, and abstracts.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search terms, e.g. 'speculative decoding'." },
      max_results: { type: "number", description: "How many results to fetch+download (default 6, max 25)." },
    },
    required: ["query"],
  },
  async execute(input) {
    const query = String(input.query ?? "").trim();
    if (!query) return fail("Provide a non-empty 'query'.");
    const max = Math.min(Math.max(parseInt(String(input.max_results ?? 6), 10) || 6, 1), 25);
    const cfg = loadContextConfig();
    const url =
      "https://export.arxiv.org/api/query?search_query=" +
      encodeURIComponent(`all:${query}`) +
      `&start=0&max_results=${max}&sortBy=relevance&sortOrder=descending`;

    let xml: string;
    try {
      xml = await httpGet(url, { allowInsecure: cfg.allowInsecureTls });
    } catch (err) {
      return fail(`arXiv request failed: ${String(err)}`);
    }
    const entries = parseArxivEntries(xml);
    const summary = await downloadAndNote(entries, cfg);
    return ok(`${parseArxiv(xml, query)}\n${summary}`);
  },
};

/** Download each paper's PDF into papers/ (skip existing) and append metadata to notes.md. */
async function downloadAndNote(entries: ArxivEntry[], cfg: { arxivDir: string; allowInsecureTls: boolean }): Promise<string> {
  if (!entries.length) return "(no papers to download)";
  const dir = resolvePath(process.cwd(), cfg.arxivDir);
  mkdirSync(dir, { recursive: true });
  const notesPath = join(dir, "notes.md");
  let notes = "";
  try {
    notes = readFileSync(notesPath, "utf8");
  } catch {
    notes = "# arXiv papers\n";
  }

  let downloaded = 0;
  let skipped = 0;
  const failures: string[] = [];
  for (const e of entries) {
    const sid = safeArxivId(e.id);
    const pdfPath = join(dir, `${sid}.pdf`);
    if (existsSync(pdfPath)) {
      skipped++;
    } else {
      try {
        const buf = await httpGetBuffer(e.pdfUrl, { allowInsecure: cfg.allowInsecureTls });
        writeFileSync(pdfPath, buf);
        downloaded++;
      } catch (err) {
        failures.push(`${sid} (${String(err)})`);
      }
    }
    if (!notes.includes(`(${e.id})`)) {
      notes +=
        `\n## ${e.title}\n` +
        `- Authors: ${e.authors}\n- Published: ${e.published}\n- Link: ${e.id} (${e.id})\n` +
        `- PDF: ${cfg.arxivDir}/${sid}.pdf\n\n${e.summary}\n`;
    }
  }
  try {
    writeFileSync(notesPath, notes);
  } catch {
    /* best effort */
  }

  const parts = [
    `(downloaded ${downloaded} PDF(s)` + (skipped ? `, ${skipped} already present` : "") +
      ` to ${cfg.arxivDir}/; notes: ${cfg.arxivDir}/notes.md.`,
  ];
  if (failures.length) parts.push(` Failed: ${failures.join("; ")}.`);
  parts.push(" Use read_doc to read any saved PDF.)");
  return parts.join("");
}

export const readFile: Tool = {
  name: "read_file",
  description: "Read a UTF-8 text file from the workspace and return its contents.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the workspace root." },
      max_chars: { type: "number", description: "Max characters to return (default 8000)." },
    },
    required: ["path"],
  },
  async execute(input) {
    const p = String(input.path ?? "");
    if (!p) return fail("Provide a 'path'.");
    const max = parseInt(String(input.max_chars ?? MAX_OUTPUT), 10) || MAX_OUTPUT;
    try {
      // PDFs are extracted to text; everything else is read as UTF-8.
      const raw =
        extname(p).toLowerCase() === ".pdf"
          ? await extractText(resolvePath(process.cwd(), p))
          : readFileSync(resolvePath(process.cwd(), p), "utf8");
      const t = truncate(raw, max);
      return { stdout: t.text, stderr: "", exitCode: 0, timedOut: false, truncated: t.truncated };
    } catch (err) {
      return fail(`Could not read ${p}: ${String(err)}`);
    }
  },
};

export const readDoc: Tool = {
  name: "read_doc",
  description:
    "Read one full document from the local corpus (text or PDF) by its manifest path. " +
    "Prefer search_docs for finding relevant passages; use this for a whole document.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Document path (as shown in the document manifest)." },
      max_chars: { type: "number", description: "Max characters to return (default 8000)." },
    },
    required: ["path"],
  },
  async execute(input) {
    const p = String(input.path ?? "");
    if (!p) return fail("Provide a 'path'.");
    const max = parseInt(String(input.max_chars ?? MAX_OUTPUT), 10) || MAX_OUTPUT;
    try {
      const t = truncate(await extractText(resolvePath(process.cwd(), p)), max);
      return { stdout: t.text, stderr: "", exitCode: 0, timedOut: false, truncated: t.truncated };
    } catch (err) {
      return fail(`Could not read ${p}: ${String(err)}`);
    }
  },
};

export const searchDocs: Tool = {
  name: "search_docs",
  description:
    "Search ALL local documents (text and PDFs) and return the passages most relevant to " +
    "your query, in one call. Use this instead of reading many files individually.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look for, e.g. 'evaluation metrics'." },
    },
    required: ["query"],
  },
  async execute(input) {
    const query = String(input.query ?? "").trim();
    if (!query) return fail("Provide a non-empty 'query'.");
    try {
      const cfg = loadContextConfig();
      const docs = await gatherDocuments(cfg);
      if (!docs.length) return ok(`No local documents found under '${cfg.dir}'.`);
      return ok(runSearch(docs, query, cfg.searchBudgetTokens));
    } catch (err) {
      return fail(`search_docs failed: ${String(err)}`);
    }
  },
};

export const writeFile: Tool = {
  name: "write_file",
  description:
    "Create or overwrite a UTF-8 text file in the workspace. Use this to actually " +
    "create files — do not claim a file exists unless you wrote it with this tool.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the workspace root." },
      content: { type: "string", description: "Full file contents to write." },
    },
    required: ["path", "content"],
  },
  async execute(input) {
    const p = String(input.path ?? "");
    if (!p) return fail("Provide a 'path'.");
    const content = typeof input.content === "string" ? input.content : String(input.content ?? "");
    try {
      const abs = resolvePath(process.cwd(), p);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
      return ok(`Wrote ${content.length} bytes to ${p}.`);
    } catch (err) {
      return fail(`Could not write ${p}: ${String(err)}`);
    }
  },
};

export const listFiles: Tool = {
  name: "list_files",
  description: "List files and folders in a workspace directory (non-recursive).",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path relative to the workspace root (default '.')." },
    },
    required: [],
  },
  async execute(input) {
    const p = String(input.path ?? ".");
    try {
      const abs = resolvePath(process.cwd(), p);
      const entries = readdirSync(abs)
        .sort()
        .map((name) => {
          let isDir = false;
          try {
            isDir = statSync(resolvePath(abs, name)).isDirectory();
          } catch {
            /* ignore */
          }
          return isDir ? `${name}/` : name;
        });
      return ok(entries.length ? entries.join("\n") : "(empty directory)");
    } catch (err) {
      return fail(`Could not list ${p}: ${String(err)}`);
    }
  },
};

export const tools: Tool[] = [
  runCommand,
  arxivSearch,
  searchDocs,
  readDoc,
  readFile,
  writeFile,
  listFiles,
];

export function getTool(name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}
