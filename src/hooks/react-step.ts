import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseAssistantTurn } from "../format.js";
import { getTool, tools, type ToolResult } from "../tools.js";
import { readLastAssistantText } from "../transcript.js";
import { parseStdin, readStdin, writeOutput } from "./io.js";

/**
 * Stop hook — the engine of the ReAct loop.
 *
 * When a no-tool-calling model finishes a turn it produces plain text and the
 * agent tries to end the session. This hook intercepts that:
 *   - If the text contains a "Final Answer:", let the session stop.
 *   - If it contains a valid Action, execute the tool and return the result as an
 *     Observation via `{ decision: "block", reason }`, which forces the agent to
 *     continue. (`reason` is the only channel back to the model here: the Stop hook
 *     has no `additionalContext`.)
 *   - If the text is malformed, block with a corrective message instead of running
 *     anything.
 *
 * A per-session iteration counter caps the loop so a misbehaving model cannot spin
 * forever.
 */

const MAX_ITERATIONS = 15;

export interface StopInput {
  transcript_path?: string;
  session_id?: string;
  stop_hook_active?: boolean;
}

export type StopOutput = { decision: "block"; reason: string } | { continue: true };

function counterPath(sessionId: string): string {
  const dir = join(tmpdir(), "react-hook");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${sessionId.replace(/[^\w.-]/g, "_")}.count`);
}

function bumpIteration(sessionId: string): number {
  const p = counterPath(sessionId);
  let n = 0;
  try {
    n = parseInt(readFileSync(p, "utf8").trim(), 10) || 0;
  } catch {
    n = 0;
  }
  n += 1;
  writeFileSync(p, String(n));
  return n;
}

function clearCounter(sessionId: string): void {
  try {
    writeFileSync(counterPath(sessionId), "0");
  } catch {
    /* best effort */
  }
}

function formatObservation(toolName: string, r: ToolResult): string {
  const parts: string[] = [
    `Observation: result of ${toolName} (exit code ${r.exitCode}${r.timedOut ? ", TIMED OUT" : ""}):`,
  ];
  if (r.stdout.trim()) parts.push(`stdout:\n${r.stdout}`);
  if (r.stderr.trim()) parts.push(`stderr:\n${r.stderr}`);
  if (!r.stdout.trim() && !r.stderr.trim()) parts.push("(no output)");
  parts.push('Continue: take another Action, or give your "Final Answer:" if you have enough information.');
  return parts.join("\n");
}

export async function runStep(input: StopInput): Promise<StopOutput> {
  const sessionId = input.session_id ?? "default";

  // Safety valve: bound the number of automated continuations. Give exactly one
  // nudge to finalize, then force the session to end so the loop always terminates.
  // (The counter is intentionally NOT reset here, so the terminal state is stable.)
  const iter = bumpIteration(sessionId);
  if (iter === MAX_ITERATIONS + 1) {
    return {
      decision: "block",
      reason:
        `ReAct loop reached the maximum of ${MAX_ITERATIONS} steps. ` +
        'Stop using tools and respond now with a line starting "Final Answer:".',
    };
  }
  if (iter > MAX_ITERATIONS + 1) {
    return { continue: true };
  }

  if (!input.transcript_path) return { continue: true };
  const text = readLastAssistantText(input.transcript_path);
  if (!text) return { continue: true };

  const turn = parseAssistantTurn(text);

  if (turn.kind === "final") {
    clearCounter(sessionId);
    return { continue: true };
  }

  if (turn.kind === "error") {
    return { decision: "block", reason: turn.reason };
  }

  // turn.kind === "action"
  const tool = getTool(turn.action);
  if (!tool) {
    return {
      decision: "block",
      reason: `Unknown tool "${turn.action}". Available tools: ${tools
        .map((t) => t.name)
        .join(", ")}. Choose a valid Action.`,
    };
  }

  const missing = tool.inputSchema.required.filter(
    (k) => !(k in turn.input) || turn.input[k] === "" || turn.input[k] == null,
  );
  if (missing.length) {
    return {
      decision: "block",
      reason: `Action Input for "${tool.name}" is missing required field(s): ${missing.join(
        ", ",
      )}. Provide a complete single-line JSON object.`,
    };
  }

  const result = await tool.execute(turn.input);
  return { decision: "block", reason: formatObservation(tool.name, result) };
}

async function main(): Promise<void> {
  const input = parseStdin<StopInput>(await readStdin());
  writeOutput(await runStep(input));
}

// Run main() only when invoked directly (not when imported by tests).
if (require.main === module) {
  void main();
}
