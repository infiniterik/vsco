import { spawn } from "node:child_process";
import { promises as fs, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { DEFAULT_COUNCIL_CONFIG } from "./council.js";
import { DEFAULT_CONTEXT_CONFIG } from "./docs.js";
import { renderPreamble } from "./format.js";

const DEFAULT_MODEL = "ollama/llama3.1";

/**
 * VS Code extension entry point.
 *
 * The extension bundles the self-contained ReAct hook runtime (compiled JS with no
 * external dependencies) and contributes a single command that wires it into the
 * open workspace: it copies the runtime into `.react-byok/`, writes the hook
 * configuration under `.github/hooks/`, and drops in a custom agent definition.
 * Everything it writes uses relative paths, so the result is committable and needs
 * no `npm install` in the target project.
 */

// The bundled (esbuild) hook runtimes — self-contained (pdf.js + all logic bundled in).
// Staged into LOCAL global storage by stageRuntime(), not the workspace, so OneDrive
// online-only placeholders can't break process creation.
const RUNTIME_FILES = [
  "hooks/inject-catalog.js",
  "hooks/react-step.js",
  "hooks/pre-compact.js",
  "hooks/council.js",
  "hooks/pdf.worker.mjs",
];

export function activate(context: vscode.ExtensionContext): void {
  const version = String(context.extension.packageJSON.version ?? "0.0.0");
  context.subscriptions.push(
    vscode.commands.registerCommand("react-byok.setup", () => setupWorkspace(context)),
    vscode.commands.registerCommand("react-byok.showOutput", () => reactOutput().show(true)),
    vscode.commands.registerCommand("react-byok.regatherContext", regatherContext),
    vscode.commands.registerCommand("react-byok.convene", () => conveneCouncil(context)),
  );
  watchCommandOutput(context);
  watchApprovalRequests(context);
  // Stage the executable runtime into LOCAL global storage now, so an extension update
  // refreshes the scripts that the generated react.json already points at (no re-setup).
  void stageRuntime(context).catch(() => undefined);
  // Make the bundled agents appear on install/reload without running setup.
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    void writeAgents(folder.uri.fsPath, version).catch(() => undefined);
  }
}

/** Local (never-OneDrive) directory holding the staged hook runtime. */
function runtimeRoot(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "runtime");
}

/**
 * Copy the bundled hook runtime into the extension's global storage and return that dir.
 *
 * Global storage lives under %APPDATA% / ~/.config — a LOCAL path that OneDrive never
 * redirects — and is keyed by extension id (stable across version updates). The generated
 * hook command points here instead of at the workspace copy, because a workspace under
 * OneDrive can hold the scripts as online-only placeholders, and the OS then fails process
 * creation with "spawn UNKNOWN" before the script runs. Data/config still lives in the
 * workspace `.react-byok/` (read via normal file I/O, which OneDrive hydrates on demand).
 *
 * Falls back to the (also-local) extension install dir if staging fails.
 */
async function stageRuntime(context: vscode.ExtensionContext): Promise<string> {
  const dest = runtimeRoot(context);
  try {
    for (const rel of RUNTIME_FILES) {
      const from = path.join(context.extensionPath, "dist", rel);
      const to = path.join(dest, rel);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to);
    }
    return dest;
  } catch {
    return path.join(context.extensionPath, "dist");
  }
}

export function deactivate(): void {
  /* nothing to clean up */
}

// --- live command-output buffer ------------------------------------------------

let channel: vscode.OutputChannel | undefined;
function reactOutput(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel("ReAct Tools");
  return channel;
}

/**
 * Tail `.react-byok/commands.log` (written by the hook runtime each time a tool runs)
 * into the "ReAct Tools" Output channel, so the user can watch what the agent runs.
 */
function watchCommandOutput(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  const logPath = path.join(folder.uri.fsPath, ".react-byok", "commands.log");
  let offset = 0;

  const flush = (): void => {
    try {
      const buf = readFileSync(logPath, "utf8");
      if (buf.length < offset) offset = 0; // file was truncated/rotated
      if (buf.length > offset) {
        reactOutput().append(buf.slice(offset));
        offset = buf.length;
        reactOutput().show(true);
      }
    } catch {
      /* file may not exist yet */
    }
  };

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, ".react-byok/commands.log"),
  );
  watcher.onDidCreate(flush);
  watcher.onDidChange(flush);
  context.subscriptions.push(watcher);
  flush(); // surface anything already there
}

/**
 * Watch `.react-byok/.pending/*.json` (written by the Stop hook when a gated tool needs
 * authorization), prompt the user with a modal, and write back the decision file the hook
 * is polling for. This is the interactive half of the approval handshake.
 */
function watchApprovalRequests(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  const handled = new Set<string>();

  const handle = async (uri: vscode.Uri): Promise<void> => {
    if (!uri.fsPath.endsWith(".json") || handled.has(uri.fsPath)) return;
    handled.add(uri.fsPath);
    let req: { id: string; tool: string; summary: string };
    try {
      req = JSON.parse(readFileSync(uri.fsPath, "utf8"));
    } catch {
      return; // file mid-write or already cleaned up
    }
    const choice = await vscode.window.showWarningMessage(
      `ReAct agent requests permission to run: ${req.tool}`,
      { modal: true, detail: req.summary },
      "Allow",
      "Allow for session",
      "Deny",
    );
    const decision = choice === "Allow" ? "allow" : choice === "Allow for session" ? "session" : "deny";
    try {
      writeFileSync(uri.fsPath.replace(/\.json$/, ".decision"), JSON.stringify({ id: req.id, decision }));
    } catch {
      /* hook will fail safe (deny) on timeout */
    }
  };

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, ".react-byok/.pending/*.json"),
  );
  watcher.onDidCreate((u) => void handle(u));
  watcher.onDidChange((u) => void handle(u));
  context.subscriptions.push(watcher);
}

/** Clear the document-extraction cache so the next session re-reads all documents. */
async function regatherContext(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage("ReAct BYOK: open a folder first.");
    return;
  }
  await fs.rm(path.join(folder.uri.fsPath, ".react-byok", ".cache"), {
    recursive: true,
    force: true,
  });
  void vscode.window.showInformationMessage(
    "ReAct BYOK: document cache cleared — context will be re-gathered next session.",
  );
}

/**
 * Convene the council of experts: prompt for a question, then spawn the bundled council
 * runner with VS Code's Node (cwd = workspace root, like the hooks), so document gathering
 * and the read-only tools resolve against the workspace. Progress streams into the
 * "ReAct Tools" output channel (the runner appends to commands.log, which we tail).
 */
async function conveneCouncil(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage("ReAct BYOK: open a folder first.");
    return;
  }
  const root = folder.uri.fsPath;
  const question = await vscode.window.showInputBox({
    title: "Convene council of experts",
    prompt: "What should the council deliberate on? (It reasons over the documents in your context.)",
    ignoreFocusOut: true,
  });
  if (!question) return;

  // Run the locally-staged runner (never the OneDrive workspace copy) to avoid spawn UNKNOWN.
  const runtime = await stageRuntime(context);
  const script = path.join(runtime, "hooks", "council.js");
  if (!(await exists(script))) {
    void vscode.window.showErrorMessage("ReAct BYOK: council runner not found — reinstall the extension.");
    return;
  }

  reactOutput().show(true);
  reactOutput().appendLine(`[council] convening on: ${question}`);
  const child = spawn(process.execPath, [script, question], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    windowsHide: true,
  });
  child.on("error", (err) => void vscode.window.showErrorMessage(`Council failed to start: ${String(err)}`));
  child.on("close", async (code) => {
    if (code !== 0) {
      void vscode.window.showWarningMessage(`Council exited with code ${code}. See the "ReAct Tools" output.`);
      return;
    }
    const report = path.join(root, "COUNCIL.md");
    if (await exists(report)) {
      const choice = await vscode.window.showInformationMessage("Council finished — wrote COUNCIL.md.", "Open");
      if (choice === "Open") {
        const doc = await vscode.workspace.openTextDocument(report);
        await vscode.window.showTextDocument(doc);
      }
    }
  });
  context.subscriptions.push({ dispose: () => child.kill() });
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function setupWorkspace(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage("ReAct BYOK: open a folder or workspace first.");
    return;
  }
  const root = folder.uri.fsPath;
  const version = String(context.extension.packageJSON.version ?? "0.0.0");

  const model =
    (await vscode.window.showInputBox({
      title: "ReAct BYOK — model id",
      prompt: "A BYOK/local model WITHOUT native tool-calling (e.g. ollama/llama3.1).",
      value: DEFAULT_MODEL,
      ignoreFocusOut: true,
    })) ?? DEFAULT_MODEL;

  try {
    // 1. Stage the self-contained hook runtime in LOCAL global storage (never OneDrive),
    //    so the executed scripts are always real local files — a workspace under OneDrive
    //    can hold them as online-only placeholders, which makes the OS fail process
    //    creation with "spawn UNKNOWN". Workspace `.react-byok/` keeps only config/state.
    const runtime = await stageRuntime(context);

    // 2. Hook configuration. Run the scripts with the Node runtime that VS Code
    //    already ships (process.execPath) rather than a system `node`, so this works
    //    on machines with no Node/dev setup installed. ELECTRON_RUN_AS_NODE makes the
    //    VS Code executable behave as plain Node instead of launching the UI. Generous
    //    timeouts: SessionStart/Stop may extract PDFs for context gathering.
    const hookScript = (name: string): string => path.join(runtime, "hooks", name);
    const hooks = {
      hooks: {
        SessionStart: [hookEntry(hookScript("inject-catalog.js"), 60)],
        // Generous Stop timeout: the hook may block waiting for the user's approval modal.
        Stop: [hookEntry(hookScript("react-step.js"), 600)],
        PreCompact: [hookEntry(hookScript("pre-compact.js"), 15)],
      },
    };
    await writeText(
      path.join(root, ".github", "hooks", "react.json"),
      `${JSON.stringify(hooks, null, 2)}\n`,
    );

    // 3. Document-context config + docs/papers folders (created if missing).
    const ctxPath = path.join(root, ".react-byok", "context.json");
    if (!(await exists(ctxPath))) {
      await writeText(ctxPath, `${JSON.stringify(DEFAULT_CONTEXT_CONFIG, null, 2)}\n`);
    }
    await fs.mkdir(path.join(root, DEFAULT_CONTEXT_CONFIG.dir), { recursive: true });
    await fs.mkdir(path.join(root, DEFAULT_CONTEXT_CONFIG.arxivDir), { recursive: true });

    // Council-of-experts config (kept separate; holds the OpenAI-compatible endpoint).
    const councilPath = path.join(root, ".react-byok", "council.json");
    if (!(await exists(councilPath))) {
      const council = {
        ...DEFAULT_COUNCIL_CONFIG,
        llm: {
          baseUrl: "http://localhost:11434/v1",
          apiKey: "env:OPENAI_API_KEY",
          model,
        },
      };
      await writeText(councilPath, `${JSON.stringify(council, null, 2)}\n`);
    }

    // 4. Custom agent definitions (shared tool runtime; per-agent task prompt).
    await writeAgents(root, version, model);

    const choice = await vscode.window.showInformationMessage(
      'ReAct BYOK is set up (using VS Code’s bundled Node — no Node install needed). Enable "chat.useCustomAgentHooks", then pick the “ReAct BYOK” agent.',
      "Open setting",
    );
    if (choice === "Open setting") {
      void vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "chat.useCustomAgentHooks",
      );
    }
  } catch (err) {
    void vscode.window.showErrorMessage(`ReAct BYOK setup failed: ${String(err)}`);
  }
}

/**
 * Build a hook entry that runs `scriptPath` with VS Code's own Node runtime.
 *
 * `process.execPath` is the VS Code/Electron executable; paired with
 * ELECTRON_RUN_AS_NODE=1 (set in the hook's env) it runs as plain Node, so no
 * separate Node installation is required.
 *
 * Two command forms are emitted because the host runs hook commands in the OS
 * default shell:
 *  - `command` (macOS/Linux, POSIX shells): a leading quoted path is executed fine.
 *  - `windows` (PowerShell, VS Code's default on Windows): PowerShell parses a
 *    leading quoted string as a string literal, NOT a command, so it needs the call
 *    operator `&`. Single-quoted literals avoid backslash/space escaping problems.
 */
function hookEntry(scriptPath: string, timeout: number) {
  const exe = process.execPath;
  return {
    type: "command",
    command: `"${exe}" "${scriptPath}"`,
    windows: `& '${exe}' '${scriptPath}'`,
    // ELECTRON_RUN_AS_NODE: run the VS Code executable as plain Node.
    // REACT_BYOK_DEBUG: append a diagnostic line to .react-byok/hook.log each call.
    env: { ELECTRON_RUN_AS_NODE: "1", REACT_BYOK_DEBUG: "1" },
    timeout,
  };
}

async function writeText(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

// --- bundled agents ------------------------------------------------------------

/** Every agent shipped in the VSIX. Add an entry to ship + auto-install a new one. */
const AGENTS: { file: string; build: (model: string, version: string) => string }[] = [
  { file: "react-byok.agent.md", build: agentMarkdown },
  { file: "arxiv-researcher.agent.md", build: arxivAgentMarkdown },
];

function stampOf(md: string): string | undefined {
  return /react-byok:\s*v?([\d.]+)/.exec(md)?.[1];
}
function modelOf(md: string): string | undefined {
  return /^model:\s*(.+)$/m.exec(md)?.[1]?.trim();
}

/**
 * Write the bundled agent files into `.github/agents/`. With `modelOverride` (setup),
 * always (re)writes with that model. Without it (activation), creates missing files
 * and refreshes ones stamped with an older version, preserving the user's model.
 */
async function writeAgents(root: string, version: string, modelOverride?: string): Promise<void> {
  for (const a of AGENTS) {
    const dest = path.join(root, ".github", "agents", a.file);
    let existing = "";
    try {
      existing = await fs.readFile(dest, "utf8");
    } catch {
      /* missing */
    }
    const model = modelOverride ?? modelOf(existing) ?? DEFAULT_MODEL;
    if (modelOverride || !existing || stampOf(existing) !== version) {
      await writeText(dest, a.build(model, version));
    }
  }
}

function agentFrontmatter(name: string, description: string, model: string, version: string): string {
  // The body of a custom agent file is prepended to every prompt, so it is the
  // de-facto system prompt. The leading comment is a version stamp used by writeAgents.
  return `---
name: ${name}
description: ${description}
model: ${model}
tools: []
---

<!-- react-byok: v${version} -->
`;
}

function agentMarkdown(model: string, version: string): string {
  return `${agentFrontmatter(
    "ReAct BYOK",
    "Runs a model without native tool-calling as a ReAct agent, driven by SessionStart + Stop hooks.",
    model,
    version,
  )}
${renderPreamble()}

---
(The loop is driven by hooks in \`.github/hooks/react.json\`: SessionStart injects the
catalog above; the Stop hook runs your Action and returns its Observation, repeating
until you give a Final Answer.)
`;
}

function arxivAgentMarkdown(model: string, version: string): string {
  return `${agentFrontmatter(
    "ArXiv Researcher",
    "Literature-review agent — reads local papers and arXiv via the ReAct hook tools.",
    model,
    version,
  )}
${renderPreamble()}

# Your task: literature reviews
Local documents (PDFs/notes in the configured folder) are gathered into your context at
the start of each session — check the "Local document context" manifest above. Then:
1. Use \`arxiv_search\` {query} to find related published work. It AUTOMATICALLY downloads
   every result's PDF into \`papers/\` and records metadata in \`papers/notes.md\` — you do
   not download anything yourself.
2. Use \`search_docs\` {query} to pull the most relevant passages from the gathered corpus in
   one call; \`read_doc\` {path} to read a full document — including a downloaded paper, e.g.
   \`read_doc {"path":"papers/2506.06962v3.pdf"}\` (see \`papers/notes.md\` for paths).
3. For non-arXiv web sources (author pages, project sites, HTTP APIs) use \`fetch_url\`
   {url} — do not write Python/curl scripts to scrape the web.
4. Synthesize across the local corpus and the downloaded arXiv papers. Keep running notes in
   \`NOTES.md\` via \`write_file\` so progress survives context compaction; \`read_file\` them
   back if the conversation is compacted.
5. Save a Markdown review with \`write_file\` (e.g. \`REVIEW.md\`): Overview, Key papers
   (Title — Authors, year — link), Themes, Gaps. Cite only papers you actually read or that
   \`arxiv_search\` returned.
Finish with a \`Final Answer:\` summarizing findings and where you saved the review.

---
(Tools and the loop are provided by the shared hooks in \`.github/hooks/react.json\`.)
`;
}
