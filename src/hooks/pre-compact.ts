import { logDebug } from "../debug.js";
import { protectStdout, readStdin, writeOutput } from "./io.js";

/**
 * PreCompact hook. It cannot inject context (common output only), but it can nudge
 * the model: after the chat history is compacted the local documents are still on
 * disk and re-retrievable, and any notes the agent wrote are still there.
 */
async function main(): Promise<void> {
  protectStdout();
  await readStdin();
  logDebug("preCompact.invoke", {});
  writeOutput({
    continue: true,
    systemMessage:
      "Context was compacted. The local documents are still on disk — use search_docs to " +
      "re-retrieve relevant passages, and read_file your notes (e.g. REVIEW.md) to restore state.",
  });
}

void main();
