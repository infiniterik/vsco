import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { requireApproval } from "./approval.js";
import { buildInjection } from "./context.js";
import { DEFAULT_COUNCIL_CONFIG, resolveApiKey, runReactAgent } from "./council.js";
import { reactDir, workspaceRoot } from "./debug.js";
import { gatherDocuments, loadContextConfig } from "./docs.js";
import { protectStdout } from "./hooks/io.js";
import { type LlmConfig, makeLlm } from "./llm.js";
import { tools } from "./tools.js";

/**
 * Hook-free single-agent runner.
 *
 * VS Code's agent hooks launch via spawn(shell:true) → cmd.exe on Windows, which is a
 * dead end on locked-down machines with no cmd. This runner is launched by the extension
 * with spawn(execPath, …) DIRECTLY (no shell, like the council), so it never touches cmd.
 * It drives the SAME ReAct loop against the configured OpenAI-compatible endpoint with the
 * full toolset, gated by the same user-approval handshake. Output streams to commands.log
 * (tailed by the "ReAct Tools" channel); the final answer is written to ANSWER.md.
 *
 * Usage: node agent.js "<task>"
 */

function progress(line: string): void {
  try {
    appendFileSync(reactDir("commands.log"), `[agent] ${line}\n`);
  } catch {
    /* best effort */
  }
}

function loadLlm(): LlmConfig {
  let user: { llm?: Partial<LlmConfig> } = {};
  try {
    user = JSON.parse(readFileSync(reactDir("council.json"), "utf8")) as { llm?: Partial<LlmConfig> };
  } catch {
    /* defaults */
  }
  const llm = { ...DEFAULT_COUNCIL_CONFIG.llm, ...(user.llm ?? {}) };
  return { ...llm, apiKey: resolveApiKey(llm.apiKey), allowInsecureTls: loadContextConfig().allowInsecureTls };
}

async function main(): Promise<void> {
  protectStdout();
  const task = process.argv.slice(2).join(" ").trim();
  if (!task) {
    progress("No task provided; aborting.");
    process.exit(1);
  }

  const llmCfg = loadLlm();
  if (!llmCfg.baseUrl) {
    progress("No llm.baseUrl in .react-byok/council.json — set it to your OpenAI-compatible URL.");
    process.exit(1);
  }
  const ctxCfg = loadContextConfig();
  const sessionId = `agent-${Date.now()}`;

  // Same query-agnostic document context the SessionStart hook would inject.
  let docContext = "";
  try {
    const docs = await gatherDocuments(ctxCfg);
    docContext = buildInjection(docs, ctxCfg);
    progress(`Gathered ${docs.length} document(s).`);
  } catch (err) {
    progress(`Document gathering skipped: ${String(err)}`);
  }

  // State-changing tools (run_command/write_file) are authorized via the same modal the
  // hooks use — the extension watches .react-byok/.pending while this runs.
  const approvalCfg = ctxCfg.approval;
  const gate = async (toolName: string, input: Record<string, unknown>): Promise<boolean> => {
    if (!approvalCfg.requireFor.includes(toolName)) return true;
    const command = toolName === "run_command" ? String(input.cmd ?? "") : undefined;
    const summary =
      toolName === "run_command"
        ? String(input.cmd ?? "")
        : toolName === "write_file"
          ? `write ${String(input.path ?? "")}`
          : `${toolName} ${JSON.stringify(input)}`;
    progress(`awaiting approval: ${summary}`);
    const decision = await requireApproval(sessionId, toolName, summary, command, approvalCfg);
    return decision !== "deny";
  };

  progress(`Running agent on: ${task}`);
  try {
    const { answer, toolCalls } = await runReactAgent({
      llm: makeLlm(llmCfg),
      system:
        (docContext ? `${docContext}\n\n` : "") +
        "Use the tools as needed to complete the user's task, then give your Final Answer.",
      task,
      toolList: tools,
      maxSteps: Math.max(1, Math.floor(ctxCfg.maxSteps) || 40),
      gate,
      onStep: (s) => {
        if (s.kind === "action") progress(`step ${s.step + 1}: ${s.action}`);
        else if (s.kind === "final") progress(`final answer after ${s.step + 1} step(s)`);
      },
    });
    writeFileSync(join(workspaceRoot(), "ANSWER.md"), `# ${task}\n\n${answer}\n`, "utf8");
    progress(`Done (${toolCalls} tool call(s)) — wrote ANSWER.md`);
  } catch (err) {
    progress(`Agent failed: ${String(err)}`);
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
