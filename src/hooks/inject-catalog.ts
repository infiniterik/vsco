import { renderPreamble } from "../format.js";
import { readStdin, writeOutput } from "./io.js";

/**
 * SessionStart hook.
 *
 * A model without native tool-calling never receives JSON tool schemas from the
 * host, so we inject the tool catalog and the ReAct output contract as plain text
 * into the agent's context. SessionStart is used (rather than UserPromptSubmit)
 * because UserPromptSubmit cannot return `additionalContext`.
 */
async function main(): Promise<void> {
  await readStdin(); // consume the event payload; we don't need any of its fields
  writeOutput({
    continue: true,
    systemMessage: "ReAct hook active: textual tool catalog injected for a no-tool-calling model.",
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: renderPreamble(),
    },
  });
}

void main();
