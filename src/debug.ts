import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolve a path inside the workspace's `.react-byok/` directory. VS Code runs hook
 * commands with the working directory set to the workspace root, so `process.cwd()`
 * is the reliable anchor (the scripts are bundled, so `__dirname` is not).
 */
export function reactDir(...parts: string[]): string {
  const dir = join(process.cwd(), ".react-byok");
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
