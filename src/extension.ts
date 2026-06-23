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

    // 2. Hook configuration — relative commands, committable, no deps to install.
    const hooks = {
      hooks: {
        SessionStart: [
          { type: "command", command: "node ./.react-byok/hooks/inject-catalog.js", timeout: 15 },
        ],
        Stop: [
          { type: "command", command: "node ./.react-byok/hooks/react-step.js", timeout: 60 },
        ],
      },
    };
    await writeText(
      path.join(root, ".github", "hooks", "react.json"),
      `${JSON.stringify(hooks, null, 2)}\n`,
    );

    // 3. Custom agent definition.
    await writeText(
      path.join(root, ".github", "agents", "react-byok.agent.md"),
      agentMarkdown(model),
    );

    const choice = await vscode.window.showInformationMessage(
      'ReAct BYOK is set up. Enable "chat.useCustomAgentHooks", then pick the “ReAct BYOK” agent.',
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
hooks:
  SessionStart:
    - type: command
      command: node ./.react-byok/hooks/inject-catalog.js
      timeout: 15
  Stop:
    - type: command
      command: node ./.react-byok/hooks/react-step.js
      timeout: 60
---

This agent makes a model that cannot receive tool specifications behave like a
ReAct agent. The tool catalog is injected as text at SessionStart; the Stop hook
parses the model's textual actions, executes them, and feeds results back as
observations until the model emits a Final Answer.
`;
}
