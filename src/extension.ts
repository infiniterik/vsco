import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

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
  "hooks/io.js",
  "hooks/inject-catalog.js",
  "hooks/react-step.js",
];

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("react-byok.setup", () => setupWorkspace(context)),
  );
}

export function deactivate(): void {
  /* nothing to clean up */
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
    const injectCmd = nodeCommand(path.join(root, ".react-byok", "hooks", "inject-catalog.js"));
    const stepCmd = nodeCommand(path.join(root, ".react-byok", "hooks", "react-step.js"));
    const hooks = {
      hooks: {
        SessionStart: [
          { type: "command", command: injectCmd, env: { ELECTRON_RUN_AS_NODE: "1" }, timeout: 15 },
        ],
        Stop: [
          { type: "command", command: stepCmd, env: { ELECTRON_RUN_AS_NODE: "1" }, timeout: 60 },
        ],
      },
    };
    await writeText(
      path.join(root, ".github", "hooks", "react.json"),
      `${JSON.stringify(hooks, null, 2)}\n`,
    );

    // 3. Custom agent definition. The hooks live in .github/hooks/react.json above
    //    (workspace-scoped); the agent only needs to select the no-tool model. Declaring
    //    the same hooks here too would double-fire them.
    await writeText(
      path.join(root, ".github", "agents", "react-byok.agent.md"),
      agentMarkdown(model),
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
 * Build a hook command that runs `scriptPath` with VS Code's own Node runtime.
 * `process.execPath` is the VS Code/Electron executable; paired with
 * ELECTRON_RUN_AS_NODE=1 (set in the hook's env) it runs as plain Node, so no
 * separate Node installation is required. Both paths are absolute and quoted to
 * tolerate spaces (e.g. "C:\\Program Files\\...").
 */
function nodeCommand(scriptPath: string): string {
  return `"${process.execPath}" "${scriptPath}"`;
}

async function writeText(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

function agentMarkdown(model: string): string {
  return `---
name: ReAct BYOK
description: Runs a model without native tool-calling as a ReAct agent, driven by SessionStart + Stop hooks.
model: ${model}
tools: []
---

This agent makes a model that cannot receive tool specifications behave like a
ReAct agent. The hooks that drive the loop are configured in
\`.github/hooks/react.json\`: the tool catalog is injected as text at SessionStart;
the Stop hook parses the model's textual actions, executes them, and feeds results
back as observations until the model emits a Final Answer.
`;
}
