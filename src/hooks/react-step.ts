import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { logDebug, recordCommandOutput, snippet } from "../debug.js";
import { parseAssistantTurn } from "../format.js";
import { getTool, tools, type ToolResult } from "../tools.js";
import { readLastAssistantText, sampleTranscript } from "../transcript.js";
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
// Consecutive malformed actions to tolerate (with escalating guidance) before
// giving up and asking for a Final Answer. Reset whenever a valid step occurs.
const MAX_INVALID_RETRIES = 3;

export interface StopInput {
  transcript_path?: string;
  session_id?: string;
  stop_hook_active?: boolean;
}

export type StopOutput =
  | { hookSpecificOutput: { hookEventName: "Stop"; decision: "block"; reason: string } }
  | { continue: true };

/**
 * Block the agent from stopping so it takes another turn. VS Code requires the
 * decision/reason to be nested under `hookSpecificOutput` (top-level fields are
 * ignored), and `reason` is what the model sees next — we put the Observation there.
 */
function block(reason: string): StopOutput {
  return { hookSpecificOutput: { hookEventName: "Stop", decision: "block", reason } };
}

/** Let the agent finish its turn / end the session. */
function allowStop(): StopOutput {
  return { continue: true };
}

function counterPath(sessionId: string, kind: "step" | "invalid"): string {
  const dir = join(tmpdir(), "react-hook");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${sessionId.replace(/[^\w.-]/g, "_")}.${kind}`);
}

function bumpCounter(sessionId: string, kind: "step" | "invalid"): number {
  const p = counterPath(sessionId, kind);
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

function clearCounter(sessionId: string, kind: "step" | "invalid"): void {
  try {
    writeFileSync(counterPath(sessionId, kind), "0");
  } catch {
    /* best effort */
  }
}

/**
 * The model produced something we can't run (unparseable, unknown tool, or missing
 * fields). Ask it to regenerate the action, escalating the guidance, but bound the
 * number of consecutive malformed attempts so a confused model can't burn the whole
 * step budget on garbage. Returns a corrective block, a one-time "just answer" nudge,
 * then lets the session end.
 *
 * The counter resets on any valid step (see runStep), so this only caps *consecutive*
 * invalid attempts.
 */
function regenerate(sessionId: string, reason: string): StopOutput {
  const tries = bumpCounter(sessionId, "invalid");
  if (tries <= MAX_INVALID_RETRIES) {
    const escalation =
      tries >= 2
        ? `\n(Attempt ${tries} of ${MAX_INVALID_RETRIES}. Re-read the required format and output exactly ONE valid step: either an Action with a single-line JSON "Action Input", or a "Final Answer:".)`
        : "";
    return block(reason + escalation);
  }
  if (tries === MAX_INVALID_RETRIES + 1) {
    return block(
      `Could not parse a valid Action after ${MAX_INVALID_RETRIES} attempts. ` +
        'Do not use a tool. Respond now with a line starting "Final Answer:" using what you already know.',
    );
  }
  // Still malformed after the finalize nudge — end the session to guarantee termination.
  return allowStop();
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
  const iter = bumpCounter(sessionId, "step");
  if (iter === MAX_ITERATIONS + 1) {
    return block(
      `ReAct loop reached the maximum of ${MAX_ITERATIONS} steps. ` +
        'Stop using tools and respond now with a line starting "Final Answer:".',
    );
  }
  if (iter > MAX_ITERATIONS + 1) {
    return allowStop();
  }

  if (!input.transcript_path) {
    logDebug("stop.no_transcript_path", { sessionId });
    return allowStop();
  }
  const text = readLastAssistantText(input.transcript_path);
  logDebug("stop.invoke", {
    sessionId,
    iter,
    stop_hook_active: input.stop_hook_active ?? null,
    transcript_path: input.transcript_path,
    hasText: Boolean(text),
    text: snippet(text),
  });
  if (!text) {
    // Parsing found nothing — dump a sample so an unexpected format reveals itself.
    logDebug("stop.no_text", { sample: sampleTranscript(input.transcript_path) });
    return allowStop();
  }

  const turn = parseAssistantTurn(text);
  logDebug("stop.parsed", {
    kind: turn.kind,
    detail: snippet(
      turn.kind === "action"
        ? `${turn.action} ${JSON.stringify(turn.input)}`
        : turn.kind === "final"
          ? turn.answer
          : turn.reason,
    ),
  });

  if (turn.kind === "final") {
    clearCounter(sessionId, "step");
    clearCounter(sessionId, "invalid");
    return allowStop();
  }

  if (turn.kind === "error") {
    return regenerate(sessionId, turn.reason);
  }

  // turn.kind === "action"
  const tool = getTool(turn.action);
  if (!tool) {
    return regenerate(
      sessionId,
      `Unknown tool "${turn.action}". Available tools: ${tools
        .map((t) => t.name)
        .join(", ")}. Choose a valid Action.`,
    );
  }

  const missing = tool.inputSchema.required.filter(
    (k) => !(k in turn.input) || turn.input[k] === "" || turn.input[k] == null,
  );
  if (missing.length) {
    return regenerate(
      sessionId,
      `Action Input for "${tool.name}" is missing required field(s): ${missing.join(
        ", ",
      )}. Provide a complete single-line JSON object.`,
    );
  }

  // A valid, runnable action — the model recovered, so reset the invalid streak.
  clearCounter(sessionId, "invalid");
  const result = await tool.execute(turn.input);
  recordCommandOutput(tool.name, turn.input, result);
  return block(formatObservation(tool.name, result));
}

async function main(): Promise<void> {
  const raw = await readStdin();
  logDebug("stop.stdin", { raw: snippet(raw) });
  const input = parseStdin<StopInput>(raw);
  const output = await runStep(input);
  logDebug("stop.output", { output });
  writeOutput(output);
}

// Run main() only when invoked directly (not when imported by tests).
if (require.main === module) {
  void main();
}
