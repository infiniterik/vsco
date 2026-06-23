import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseAssistantTurn, renderPreamble } from "../src/format.js";
import { runStep } from "../src/hooks/react-step.js";

test("parser extracts an action and its JSON input", () => {
  const t = parseAssistantTurn('Thought: list files\nAction: run_command\nAction Input: {"cmd":"ls"}');
  assert.equal(t.kind, "action");
  if (t.kind === "action") {
    assert.equal(t.action, "run_command");
    assert.equal(t.input.cmd, "ls");
  }
});

test("parser tolerates code fences around the input", () => {
  const t = parseAssistantTurn('Action: run_command\nAction Input: ```json\n{"cmd":"echo hi"}\n```');
  assert.equal(t.kind, "action");
});

test("parser recognizes a Final Answer", () => {
  const t = parseAssistantTurn("Thought: done\nFinal Answer: All set.");
  assert.equal(t.kind, "final");
  if (t.kind === "final") assert.match(t.answer, /All set/);
});

test("parser reports an error on malformed input", () => {
  const t = parseAssistantTurn("Action: run_command\nAction Input: not json");
  assert.equal(t.kind, "error");
});

test("preamble lists the available tool", () => {
  assert.match(renderPreamble(), /run_command/);
});

function writeTranscript(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "react-test-"));
  const p = join(dir, "transcript.jsonl");
  writeFileSync(p, `${JSON.stringify({ role: "assistant", content: text })}\n`);
  return p;
}

test("Stop step executes a command and blocks with the observation", async () => {
  const tp = writeTranscript('Thought: greet\nAction: run_command\nAction Input: {"cmd":"echo hello-from-react"}');
  const out = await runStep({ transcript_path: tp, session_id: randomUUID() });
  assert.ok("decision" in out && out.decision === "block");
  if ("decision" in out) assert.match(out.reason, /hello-from-react/);
});

test("Stop step allows termination on a Final Answer", async () => {
  const tp = writeTranscript("Final Answer: done.");
  const out = await runStep({ transcript_path: tp, session_id: randomUUID() });
  assert.deepEqual(out, { continue: true });
});

test("Stop step caps the loop, then forces termination", async () => {
  const tp = writeTranscript('Action: run_command\nAction Input: {"cmd":"echo x"}');
  const session = randomUUID();
  const outputs: Awaited<ReturnType<typeof runStep>>[] = [];
  for (let i = 0; i < 20; i++) {
    outputs.push(await runStep({ transcript_path: tp, session_id: session }));
  }
  // A "finalize" nudge is emitted once when the cap is hit...
  assert.ok(
    outputs.some((o) => "decision" in o && o.decision === "block" && /maximum/.test(o.reason)),
    "expected a maximum-steps nudge",
  );
  // ...and the loop is guaranteed to terminate afterwards.
  assert.deepEqual(outputs.at(-1), { continue: true });
});
