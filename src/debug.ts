import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The workspace root the hook should operate on.
 *
 * The generated hook config sets the process `cwd` to a LOCAL directory (never the
 * OneDrive-synced workspace, whose placeholder folders make Windows fail process
 * creation with "spawn UNKNOWN") and passes the real workspace path in
 * REACT_BYOK_WORKSPACE. So we anchor on that env var, falling back to `process.cwd()`
 * for direct/test invocations where it isn't set.
 */
export function workspaceRoot(): string {
  return process.env.REACT_BYOK_WORKSPACE || process.cwd();
}

/** Resolve a path inside the workspace's `.react-byok/` directory. */
export function reactDir(...parts: string[]): string {
  const dir = join(workspaceRoot(), ".react-byok");
  return parts.length ? join(dir, ...parts) : dir;
}

/**
 * Append-only debug log for the hooks, so we can tell — on a machine we can't
 * observe — whether the Stop hook fired and what it read. Enabled only when
 * REACT_BYOK_DEBUG is set (the generated hook config sets it). Never throws.
 */
export function logDebug(event: string, data: Record<string, unknown>): void {
  if (!process.env.REACT_BYOK_DEBUG) return;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
    appendFileSync(reactDir("hook.log"), `${line}\n`);
  } catch {
    /* logging must never break the hook */
  }
}

/** Trim long strings so the log stays readable. */
export function snippet(s: string | null | undefined, max = 400): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}…(+${s.length - max})` : s;
}

/**
 * Append a human-readable record of a tool invocation to `.react-byok/commands.log`.
 * The VS Code extension tails this file into an Output channel so the user can watch
 * what the agent actually ran. Always on (this is a feature, not debug). Never throws.
 */
export function recordCommandOutput(
  toolName: string,
  input: Record<string, unknown>,
  result: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean },
): void {
  try {
    mkdirSync(reactDir(), { recursive: true });
    const head = `\n[${new Date().toLocaleTimeString()}] ${toolName} ${JSON.stringify(input)}`;
    const body = [
      result.stdout.trim() ? result.stdout.replace(/\s+$/, "") : "",
      result.stderr.trim() ? `stderr: ${result.stderr.trim()}` : "",
      `(exit ${result.exitCode}${result.timedOut ? ", TIMED OUT" : ""})`,
    ]
      .filter(Boolean)
      .join("\n");
    appendFileSync(reactDir("commands.log"), `${head}\n${body}\n`);
  } catch {
    /* never break the hook */
  }
}
