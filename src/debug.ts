import { appendFileSync } from "node:fs";
import { join } from "node:path";

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
    const head = `\n[${new Date().toLocaleTimeString()}] ${toolName} ${JSON.stringify(input)}`;
    const body = [
      result.stdout.trim() ? result.stdout.replace(/\s+$/, "") : "",
      result.stderr.trim() ? `stderr: ${result.stderr.trim()}` : "",
      `(exit ${result.exitCode}${result.timedOut ? ", TIMED OUT" : ""})`,
    ]
      .filter(Boolean)
      .join("\n");
    appendFileSync(join(__dirname, "commands.log"), `${head}\n${body}\n`);
  } catch {
    /* never break the hook */
  }
}

/**
 * Append-only debug log for the hooks, so we can tell — on a machine we can't
 * observe — whether the Stop hook actually fired and what it read.
 *
 * Enabled only when REACT_BYOK_DEBUG is set (the generated hook config sets it).
 * Writes next to the runtime, i.e. `.react-byok/hook.log`. Never throws.
 */
export function logDebug(event: string, data: Record<string, unknown>): void {
  if (!process.env.REACT_BYOK_DEBUG) return;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
    // This module lives at `.react-byok/debug.js`, so __dirname is `.react-byok/`.
    appendFileSync(join(__dirname, "hook.log"), `${line}\n`);
  } catch {
    /* logging must never break the hook */
  }
}

/** Trim long strings so the log stays readable. */
export function snippet(s: string | null | undefined, max = 400): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}…(+${s.length - max})` : s;
}
