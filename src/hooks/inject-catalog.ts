import { buildInjection } from "../context.js";
import { logDebug } from "../debug.js";
import { gatherDocuments, loadContextConfig } from "../docs.js";
import { renderPreamble } from "../format.js";
import { protectStdout, readStdin, writeOutput } from "./io.js";

/**
 * SessionStart hook.
 *
 * A model without native tool-calling never receives JSON tool schemas from the
 * host, so we inject the tool catalog and the ReAct output contract as plain text.
 * We also gather the local document corpus (query-agnostic, since SessionStart does
 * not see the prompt) into a budgeted manifest + full text, so the agent starts with
 * the documents already in context. SessionStart is used because UserPromptSubmit
 * cannot return additionalContext.
 */
async function main(): Promise<void> {
  protectStdout();
  await readStdin(); // consume the event payload; we don't need its fields

  let docContext = "";
  try {
    const cfg = loadContextConfig();
    if (cfg.enabled) {
      const docs = await gatherDocuments(cfg);
      docContext = buildInjection(docs, cfg);
      logDebug("sessionStart.gather", {
        docs: docs.length,
        tokens: docs.reduce((s, d) => s + d.tokens, 0),
        budget: cfg.budgetTokens,
      });
    }
  } catch (err) {
    logDebug("sessionStart.gather_error", { error: String(err) });
  }

  const additionalContext = docContext ? `${renderPreamble()}\n\n${docContext}` : renderPreamble();
  logDebug("sessionStart.invoke", { hasDocContext: Boolean(docContext) });

  writeOutput({
    continue: true,
    systemMessage: "ReAct hook active: textual tool catalog injected for a no-tool-calling model.",
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  });
}

void main();
