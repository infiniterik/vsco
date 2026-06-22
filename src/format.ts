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
  return `You are a ReAct agent. You do NOT have native tool-calling; instead you act by
writing your reasoning and actions in a strict text format that the host executes
on your behalf and then feeds the result back to you.

# Available tools
${renderToolCatalog(toolList)}

# Output format — follow EXACTLY
On each turn, output ONE of the following two shapes:

(a) A tool step:
Thought: <your reasoning about what to do next>
Action: <one of: ${names}>
Action Input: <a single-line JSON object matching that tool's input schema>

(b) The final response, when you have enough information:
Thought: <your reasoning>
Final Answer: <your complete answer to the user>

# Rules
- Emit at most ONE Action per turn, then STOP and wait for the Observation.
- "Action Input" MUST be valid JSON on a single line. Do not wrap it in code fences.
- After you act, the host appends an "Observation:" with the result; use it to decide the next step.
- When the task is complete you MUST end with a "Final Answer:" line and no Action.`;
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
      'No "Action"/"Action Input" pair and no "Final Answer" were found. ' +
      "Follow the required format: either a tool step or a Final Answer.",
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
