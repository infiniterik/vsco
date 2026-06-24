import { promises as fs, readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { renderPreamble } from "./format.js";

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

const RUNTIME_FILES = [
  "tools.js",
  "format.js",
  "transcript.js",
  "debug.js",
  "hooks/io.js",
  "hooks/inject-catalog.js",
  "hooks/react-step.js",
];

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("react-byok.setup", () => setupWorkspace(context)),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("react-byok.showOutput", () => reactOutput().show(true)),
  );
  watchCommandOutput(context);
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

async function setupWorkspace(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage("ReAct BYOK: open a folder or workspace first.");
    return;
  }
  const root = folder.uri.fsPath;

  const model =
    (await vscode.window.showInputBox({
      title: "ReAct BYOK — model id",
      prompt: "A BYOK/local model WITHOUT native tool-calling (e.g. ollama/llama3.1).",
      value: "ollama/llama3.1",
      ignoreFocusOut: true,
    })) ?? "ollama/llama3.1";

  try {
    // 1. Copy the self-contained hook runtime into the workspace.
    for (const rel of RUNTIME_FILES) {
      const from = path.join(context.extensionPath, "dist", rel);
      const to = path.join(root, ".react-byok", rel);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to);
    }

    // 2. Hook configuration. Run the scripts with the Node runtime that VS Code
    //    already ships (process.execPath) rather than a system `node`, so this works
    //    on machines with no Node/dev setup installed. ELECTRON_RUN_AS_NODE makes the
    //    VS Code executable behave as plain Node instead of launching the UI.
    const hooks = {
      hooks: {
        SessionStart: [
          hookEntry(path.join(root, ".react-byok", "hooks", "inject-catalog.js"), 15),
        ],
        Stop: [
          hookEntry(path.join(root, ".react-byok", "hooks", "react-step.js"), 60),
        ],
      },
    };
    await writeText(
      path.join(root, ".github", "hooks", "react.json"),
      `${JSON.stringify(hooks, null, 2)}\n`,
    );

    // 3. Custom agent definitions. The hooks live in .github/hooks/react.json above
    //    (workspace-scoped), so every agent shares the same tool runtime; each agent
    //    file just supplies a task-specific prompt. Declaring hooks in the agent
    //    frontmatter too would double-fire them.
    await writeText(
      path.join(root, ".github", "agents", "react-byok.agent.md"),
      agentMarkdown(model),
    );
    await writeText(
      path.join(root, ".github", "agents", "arxiv-researcher.agent.md"),
      arxivAgentMarkdown(model),
    );

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

function agentMarkdown(model: string): string {
  // The body of a custom agent file is prepended to every prompt, so it is the
  // de-facto system prompt. We put the full ReAct protocol here (the same text the
  // SessionStart hook injects) so the model is instructed how to respond even if the
  // injected context is summarized away.
  return `---
name: ReAct BYOK
description: Runs a model without native tool-calling as a ReAct agent, driven by SessionStart + Stop hooks.
model: ${model}
tools: []
---

${renderPreamble()}

---
(The loop is driven by hooks in \`.github/hooks/react.json\`: SessionStart injects the
catalog above; the Stop hook runs your Action and returns its Observation, repeating
until you give a Final Answer.)
`;
}

function arxivAgentMarkdown(model: string): string {
  // A second agent that shares the same hooks/tools but with a literature-review
  // task prompt — demonstrates how to add more agents on top of one tool runtime.
  return `---
name: ArXiv Researcher
description: Literature-review agent — searches arXiv and writes a review, via the ReAct hook tools.
model: ${model}
tools: []
---

${renderPreamble()}

# Your task: literature reviews
Use the tools above to research a topic and produce a written review:
1. \`arxiv_search\` for the topic (and refined sub-queries) to find relevant papers.
2. \`read_file\` to read any local notes or source files the user points you to.
3. Synthesize findings, then \`write_file\` to save a Markdown review (e.g. \`REVIEW.md\`)
   with sections: Overview, Key papers (Title — Authors, year — link), Themes, and Gaps.
4. Cite only papers that \`arxiv_search\` actually returned; never invent citations.
Finish with a \`Final Answer:\` summarizing what you found and where you saved the review.

---
(Tools and the loop are provided by the shared hooks in \`.github/hooks/react.json\`.)
`;
}
