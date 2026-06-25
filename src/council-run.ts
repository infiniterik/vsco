import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import {
  type CouncilConfig,
  DEFAULT_COUNCIL_CONFIG,
  renderCouncilReport,
  resolveApiKey,
  runCouncil,
} from "./council.js";
import { reactDir } from "./debug.js";
import { buildInjection } from "./context.js";
import { gatherDocuments, loadContextConfig } from "./docs.js";
import { makeLlm } from "./llm.js";
import { protectStdout } from "./hooks/io.js";

/**
 * Standalone council runner. Spawned by the extension with cwd = workspace root (like the
 * hooks), so the tools' path logic and document gathering resolve against the workspace.
 *
 * Usage: node council.js "<question>"
 * Reads .react-byok/council.json; writes COUNCIL.md, .react-byok/council/bus.jsonl, and
 * progress to .react-byok/commands.log (which the "ReAct Tools" output channel tails).
 */

function loadCouncilConfig(): CouncilConfig {
  let user: Partial<CouncilConfig> = {};
  try {
    user = JSON.parse(readFileSync(reactDir("council.json"), "utf8")) as Partial<CouncilConfig>;
  } catch {
    /* use defaults */
  }
  return {
    ...DEFAULT_COUNCIL_CONFIG,
    ...user,
    llm: { ...DEFAULT_COUNCIL_CONFIG.llm, ...(user.llm ?? {}) },
    experts: user.experts?.length ? user.experts : DEFAULT_COUNCIL_CONFIG.experts,
    moderator: user.moderator ?? DEFAULT_COUNCIL_CONFIG.moderator,
  };
}

function progress(line: string): void {
  try {
    appendFileSync(reactDir("commands.log"), `[council] ${line}\n`);
  } catch {
    /* best effort */
  }
}

async function main(): Promise<void> {
  protectStdout();
  const question = process.argv.slice(2).join(" ").trim();
  if (!question) {
    progress("No question provided; aborting.");
    process.exit(1);
  }

  const cfg = loadCouncilConfig();
  cfg.llm = { ...cfg.llm, apiKey: resolveApiKey(cfg.llm.apiKey), allowInsecureTls: loadContextConfig().allowInsecureTls };

  progress(`Convening ${cfg.experts.length} experts on: ${question}`);
  if (!cfg.llm.baseUrl) {
    progress('No llm.baseUrl in .react-byok/council.json — set it to your OpenAI-compatible URL.');
    process.exit(1);
  }

  // Share the same query-agnostic document context the SessionStart hook builds.
  let docContext = "";
  try {
    const ctxCfg = loadContextConfig();
    const docs = await gatherDocuments(ctxCfg);
    docContext = buildInjection(docs, ctxCfg);
    progress(`Gathered ${docs.length} document(s) for the council.`);
  } catch (err) {
    progress(`Document gathering skipped: ${String(err)}`);
  }

  // Persist each message to the bus as it lands.
  const busPath = reactDir("council", "bus.jsonl");
  mkdirSync(reactDir("council"), { recursive: true });
  writeFileSync(busPath, "");

  try {
    const { bus, verdict } = await runCouncil(cfg, question, {
      llm: makeLlm(cfg.llm),
      docContext,
      log: progress,
      onMessage: (m) => {
        try {
          appendFileSync(busPath, `${JSON.stringify(m)}\n`);
        } catch {
          /* best effort */
        }
      },
    });

    const report = renderCouncilReport(cfg, question, bus, verdict);
    writeFileSync("COUNCIL.md", report, "utf8");
    progress("Done — wrote COUNCIL.md");
  } catch (err) {
    progress(`Council failed: ${String(err)}`);
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
