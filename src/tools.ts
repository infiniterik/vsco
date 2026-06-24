import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { get as httpsGet } from "node:https";
import { dirname, resolve as resolvePath } from "node:path";

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

/** Minimal HTTPS GET returning the body as text (no external dependency). */
function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, { headers: { "User-Agent": "react-byok/0.1" } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        httpGet(new URL(res.headers.location, url).toString()).then(resolve, reject);
        return;
      }
      if (status >= 400) {
        res.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body));
    });
    req.setTimeout(DEFAULT_TIMEOUT_MS, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
  });
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

/** Parse arXiv Atom feed XML into readable plain text. Pure (testable) function. */
export function parseArxiv(xml: string, query: string): string {
  const entries = xml
    .split("<entry>")
    .slice(1)
    .map((e) => e.split("</entry>")[0]);
  if (!entries.length) return `No arXiv results for: ${query}`;
  const tag = (block: string, name: string): string => {
    const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(block);
    return m ? decodeXml(m[1]) : "";
  };
  const out = [`arXiv results for "${query}" (${entries.length}):`, ""];
  entries.forEach((e, i) => {
    const authors = [...e.matchAll(/<name[^>]*>([\s\S]*?)<\/name>/gi)]
      .map((m) => decodeXml(m[1]))
      .slice(0, 6)
      .join(", ");
    const summary = tag(e, "summary");
    out.push(
      `[${i + 1}] ${tag(e, "title")}`,
      `    Published: ${tag(e, "published").slice(0, 10)}  Authors: ${authors}`,
      `    Link: ${tag(e, "id")}`,
      `    Abstract: ${summary.length > 500 ? `${summary.slice(0, 500)}…` : summary}`,
      "",
    );
  });
  return out.join("\n");
}

// --- additional tools ----------------------------------------------------------

export const arxivSearch: Tool = {
  name: "arxiv_search",
  description: "Search arXiv for papers and return titles, authors, links, and abstracts.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search terms, e.g. 'speculative decoding'." },
      max_results: { type: "number", description: "How many results (default 6, max 25)." },
    },
    required: ["query"],
  },
  async execute(input) {
    const query = String(input.query ?? "").trim();
    if (!query) return fail("Provide a non-empty 'query'.");
    const max = Math.min(Math.max(parseInt(String(input.max_results ?? 6), 10) || 6, 1), 25);
    const url =
      "https://export.arxiv.org/api/query?search_query=" +
      encodeURIComponent(`all:${query}`) +
      `&start=0&max_results=${max}&sortBy=relevance&sortOrder=descending`;
    try {
      return ok(parseArxiv(await httpGet(url), query));
    } catch (err) {
      return fail(`arXiv request failed: ${String(err)}`);
    }
  },
};

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
      const t = truncate(readFileSync(resolvePath(process.cwd(), p), "utf8"), max);
      return { stdout: t.text, stderr: "", exitCode: 0, timedOut: false, truncated: t.truncated };
    } catch (err) {
      return fail(`Could not read ${p}: ${String(err)}`);
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

export const tools: Tool[] = [runCommand, arxivSearch, readFile, writeFile, listFiles];

export function getTool(name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}
