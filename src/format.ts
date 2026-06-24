import { tools, type Tool } from "./tools.js";

/**
 * The ReAct contract: how tools are described to the model (text, not JSON schema)
 * and how the model's text replies are parsed back into actions.
 */

export function renderToolCatalog(toolList: Tool[] = tools): string {
  return toolList
    .map((t) => {
      const params = Object.entries(t.inputSchema.properties)
        .map(([k, v]) => {
          const req = t.inputSchema.required.includes(k) ? " (required)" : " (optional)";
          return `    - ${k} (${v.type})${req}: ${v.description}`;
        })
        .join("\n");
      return `- ${t.name}: ${t.description}\n  Input (JSON object):\n${params}`;
    })
    .join("\n");
}

export function renderPreamble(toolList: Tool[] = tools): string {
  const names = toolList.map((t) => t.name).join(", ");
  const example = toolList[0]?.name ?? "run_command";
  return `You are a ReAct agent driving tools through a strict TEXT protocol.

# CRITICAL: how tools actually work here
You do NOT have native tool-calling, function-calling, or code-execution abilities.
Any built-in "call a tool" mechanism you think you have is NOT connected to anything
and will do nothing. The ONLY way to make a tool run is to write the exact text
format below. A separate host program reads your message, runs the tool, and writes
the result back to you as an "Observation:". So:

- Do NOT emit JSON tool calls, function calls, XML tags, or special tokens.
- Do NOT claim you ran a command or invented its output. You cannot run anything
  yourself — you must ask the host by writing an Action and then STOPPING.
- Do NOT write an "Observation:" yourself. Only the host writes Observations.

# Available tools
${renderToolCatalog(toolList)}

# Your reply must be EXACTLY one of these two shapes

(a) Take a tool step (then stop and wait):
Thought: <one or two sentences of reasoning about the next step>
Action: <exactly one of: ${names}>
Action Input: <a single-line JSON object matching that tool's input schema>

(b) Finish (only when you can fully answer):
Thought: <why you are done>
Final Answer: <your complete answer to the user>

# Hard rules
1. Output AT MOST ONE Action per reply. After the "Action Input:" line, STOP
   immediately and send the message. Do not write anything after it.
2. "Action Input" MUST be valid JSON on a SINGLE line. No code fences, no comments,
   no trailing text. Example: {"cmd":"ls -la"}
3. Use the EXACT tool name. Do not invent tools or parameters.
4. After you stop, the host appends a line starting "Observation:" with the result.
   Read it, then either take another Action or give your Final Answer.
5. If you already know the answer and need no tool, reply with shape (b) only.
6. Never put both an Action and a Final Answer in the same reply.

# Worked example
User: How many TypeScript files are in src?

Assistant:
Thought: I should count the .ts files under src.
Action: ${example}
Action Input: {"cmd":"ls src/**/*.ts | wc -l"}

(host runs it and replies:)
Observation: result of ${example} (exit code 0):
stdout:
7

Assistant:
Thought: The count is 7.
Final Answer: There are 7 TypeScript files in src.`;
}

export type ParsedTurn =
  | { kind: "action"; action: string; input: Record<string, unknown>; rawInput: string }
  | { kind: "final"; answer: string }
  | { kind: "error"; reason: string };

/**
 * Parse the model's latest assistant message. Tolerant of code fences, trailing
 * prose after the JSON, and the model emitting both an Action and a Final Answer
 * (whichever appears last wins).
 */
export function parseAssistantTurn(text: string): ParsedTurn {
  const finalMatch = /Final Answer:\s*([\s\S]*)$/i.exec(text);
  const actionMatch =
    /Action:\s*([^\n]+)[\r\n]+\s*Action Input:\s*([\s\S]*?)(?:\n\s*Observation:|$)/i.exec(text);

  const finalIdx = finalMatch ? finalMatch.index : -1;
  const actionIdx = actionMatch ? actionMatch.index : -1;

  // If both are present, honor whichever the model wrote last.
  if (finalMatch && finalIdx >= actionIdx) {
    return { kind: "final", answer: finalMatch[1].trim() };
  }

  if (actionMatch) {
    const action = actionMatch[1].trim();
    const rawInput = stripFences(actionMatch[2].trim());
    const jsonText = extractFirstJsonObject(rawInput) ?? rawInput;
    try {
      const input = JSON.parse(jsonText) as Record<string, unknown>;
      return { kind: "action", action, input, rawInput: jsonText };
    } catch {
      return {
        kind: "error",
        reason:
          `Could not parse "Action Input" as JSON. You wrote: ${rawInput}\n` +
          "Reply again with a single-line, valid JSON object.",
      };
    }
  }

  return {
    kind: "error",
    reason:
      "STOP. You did not use the required format, so NOTHING happened — no file was " +
      "created, no command ran. Do not claim you did anything; you have no native " +
      "tools here and cannot act except through this protocol. Redo your reply now as " +
      "EXACTLY one of:\n" +
      'Action: <tool name>\nAction Input: <single-line JSON>\n' +
      "— or, only if the task is genuinely complete, a line starting with " +
      '"Final Answer:". Output nothing else.',
  };
}

function stripFences(s: string): string {
  return s
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

/** Extract the first balanced {...} JSON object, ignoring braces inside strings. */
function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
