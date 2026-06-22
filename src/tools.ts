import { spawn } from "node:child_process";

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

export const tools: Tool[] = [runCommand];

export function getTool(name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}
