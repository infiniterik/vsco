import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseAssistantTurn, renderPreamble } from "../src/format.js";
import { runStep } from "../src/hooks/react-step.js";
import { getTool, parseArxiv } from "../src/tools.js";
import { readLastAssistantText } from "../src/transcript.js";

test("write_file then read_file round-trips, and list_files sees it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "react-tools-"));
  const prev = process.cwd();
  process.chdir(dir);
  try {
    const w = await getTool("write_file")!.execute({ path: "sub/hello.txt", content: "hi there" });
    assert.equal(w.exitCode, 0);
    const r = await getTool("read_file")!.execute({ path: "sub/hello.txt" });
    assert.match(r.stdout, /hi there/);
    const l = await getTool("list_files")!.execute({ path: "sub" });
    assert.match(l.stdout, /hello\.txt/);
  } finally {
    process.chdir(prev);
  }
});

test("arxiv parser turns Atom XML into readable text", () => {
  const xml = `<feed><entry><title>A Great Paper</title><published>2025-01-02T00:00:00Z</published>`
    + `<id>http://arxiv.org/abs/1234.5678</id><author><name>Ada Lovelace</name></author>`
    + `<summary>We did something.</summary></entry></feed>`;
  const out = parseArxiv(xml, "test");
  assert.match(out, /A Great Paper/);
  assert.match(out, /Ada Lovelace/);
  assert.match(out, /1234\.5678/);
});

test("preamble advertises the new tools", () => {
  const p = renderPreamble();
  for (const name of ["run_command", "arxiv_search", "read_file", "write_file", "list_files"]) {
    assert.match(p, new RegExp(name));
  }
});

test("reads the last assistant.message from a real Copilot transcript", () => {
  // Real schema captured from VS Code / Copilot agent (GitHub.copilot-chat transcript).
  const jsonl = [
    JSON.stringify({ type: "session.start", data: { sessionId: "s" }, id: "a", parentId: null }),
    JSON.stringify({ type: "user.message", data: { content: "do a thing" }, id: "b" }),
    JSON.stringify({ type: "assistant.turn_start", data: { turnId: "0" }, id: "c" }),
    JSON.stringify({
      type: "assistant.message",
      data: { messageId: "m1", content: "Action: run_command\nAction Input: {\"cmd\":\"ls\"}", toolRequests: [] },
      id: "d",
    }),
    JSON.stringify({ type: "assistant.turn_end", data: { turnId: "0" }, id: "e" }),
  ].join("\n");
  const dir = mkdtempSync(join(tmpdir(), "react-tx-"));
  const p = join(dir, "t.jsonl");
  writeFileSync(p, jsonl);
  const text = readLastAssistantText(p);
  assert.ok(text, "expected to read assistant text");
  assert.match(text ?? "", /Action: run_command/);
  // It must NOT pick the user message.
  assert.doesNotMatch(text ?? "", /do a thing/);
});

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

test("preamble gives strict no-native-tools instructions and a worked example", () => {
  const p = renderPreamble();
  assert.match(p, /do NOT have native tool-calling/i);
  assert.match(p, /Action Input:/);
  assert.match(p, /Final Answer:/);
  assert.match(p, /Observation:/); // worked example shows the host's reply
});

function writeTranscript(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "react-test-"));
  const p = join(dir, "transcript.jsonl");
  writeFileSync(p, `${JSON.stringify({ role: "assistant", content: text })}\n`);
  return p;
}

// Pull the block reason out of the wire shape VS Code expects, or undefined.
function blockReason(out: Awaited<ReturnType<typeof runStep>>): string | undefined {
  return "hookSpecificOutput" in out && out.hookSpecificOutput.decision === "block"
    ? out.hookSpecificOutput.reason
    : undefined;
}

test("Stop step executes a command and blocks with the observation", async () => {
  const tp = writeTranscript('Thought: greet\nAction: run_command\nAction Input: {"cmd":"echo hello-from-react"}');
  const out = await runStep({ transcript_path: tp, session_id: randomUUID() });
  assert.match(blockReason(out) ?? "", /hello-from-react/);
});

test("a blocking Stop output nests decision/reason under hookSpecificOutput", async () => {
  // Regression guard: VS Code ignores top-level decision/reason.
  const tp = writeTranscript('Action: run_command\nAction Input: {"cmd":"echo x"}');
  const out = await runStep({ transcript_path: tp, session_id: randomUUID() });
  assert.ok("hookSpecificOutput" in out, "block output must use hookSpecificOutput");
  if ("hookSpecificOutput" in out) {
    assert.equal(out.hookSpecificOutput.hookEventName, "Stop");
    assert.equal(out.hookSpecificOutput.decision, "block");
    assert.ok(typeof out.hookSpecificOutput.reason === "string");
  }
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
    outputs.some((o) => /maximum/.test(blockReason(o) ?? "")),
    "expected a maximum-steps nudge",
  );
  // ...and the loop is guaranteed to terminate afterwards.
  assert.deepEqual(outputs.at(-1), { continue: true });
});

test("invalid actions are re-prompted, bounded, then terminated", async () => {
  const tp = writeTranscript("Action: run_command\nAction Input: not json");
  const session = randomUUID();
  const outs: Awaited<ReturnType<typeof runStep>>[] = [];
  for (let i = 0; i < 6; i++) {
    outs.push(await runStep({ transcript_path: tp, session_id: session }));
  }
  // First attempt asks the model to regenerate a valid action.
  assert.match(blockReason(outs[0]) ?? "", /JSON/);
  // After the retry budget, it stops correcting and asks for a Final Answer...
  assert.ok(
    outs.some((o) => /Could not parse a valid Action after/.test(blockReason(o) ?? "")),
    "expected a give-up / finalize nudge",
  );
  // ...and ultimately terminates.
  assert.deepEqual(outs.at(-1), { continue: true });
});

test("a valid action resets the invalid-retry streak", async () => {
  const session = randomUUID();
  const bad = writeTranscript("Action: run_command\nAction Input: not json");
  const good = writeTranscript('Action: run_command\nAction Input: {"cmd":"echo ok"}');
  await runStep({ transcript_path: bad, session_id: session }); // invalid #1
  await runStep({ transcript_path: bad, session_id: session }); // invalid #2
  await runStep({ transcript_path: good, session_id: session }); // valid -> streak reset
  const out = await runStep({ transcript_path: bad, session_id: session }); // back to a plain regenerate
  const reason = blockReason(out) ?? "";
  assert.match(reason, /JSON/);
  assert.doesNotMatch(reason, /Could not parse a valid Action after/);
});
