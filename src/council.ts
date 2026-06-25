import type { ContextConfig } from "./docs.js";
import { formatObservation, parseAssistantTurn, renderPreamble } from "./format.js";
import type { ChatMessage, LlmConfig, LlmFn } from "./llm.js";
import { getTool, type Tool, tools } from "./tools.js";

/**
 * Council of experts.
 *
 * Several expert agents reason over the same documents and DEBATE across rounds,
 * communicating through a shared message bus. Concurrency is real (experts in a round
 * run in parallel) but synchronized at round boundaries, so each expert sees what the
 * others said last round — genuine cross-talk without races.
 *
 * Every expert is a ReAct BYOK agent: with `useTools`, it drives the SAME text protocol
 * the VS Code Stop hook uses (catalog as text → parse Action → run tool → Observation),
 * reused here against the OpenAI-compatible endpoint directly. No native tool-calling is
 * required, exactly as for the single agent.
 */

export interface Expert {
  name: string;
  /** System persona — the lens this expert argues from. */
  persona: string;
}

export interface CouncilConfig {
  llm: LlmConfig;
  experts: Expert[];
  moderator: Expert;
  /** How many debate rounds before the moderator synthesizes. */
  rounds: number;
  /**
   * If true, experts may use read-only tools (search_docs/read_doc/read_file/list_files/
   * fetch_url) via a bounded ReAct loop before stating their position. If false, they
   * reason purely over the injected documents + the bus (clean prose debate).
   */
  useTools: boolean;
  /** Max ReAct tool steps an expert may take per turn (only when useTools). */
  expertSteps: number;
}

export const DEFAULT_COUNCIL_CONFIG: CouncilConfig = {
  llm: { baseUrl: "http://localhost:11434/v1", apiKey: "", model: "llama3.1" },
  experts: [
    { name: "Methodologist", persona: "You scrutinize experimental design, baselines, ablations, and statistical validity. Call out unsupported claims." },
    { name: "Systems", persona: "You focus on scalability, hardware, throughput, and engineering trade-offs. Ground discussion in what actually runs at scale." },
    { name: "Skeptic", persona: "You probe overclaims, missing comparisons, and threats to validity. Steelman the opposing view." },
  ],
  moderator: {
    name: "Chair",
    persona: "You are a neutral chair. Synthesize the council into a balanced verdict: points of agreement, open disagreements, and a bottom-line recommendation.",
  },
  rounds: 3,
  useTools: false,
  expertSteps: 3,
};

export interface BusMessage {
  round: number;
  from: string;
  text: string;
  ts: number;
}

/** Read-only tools an expert is allowed to use (no run_command/write_file → no approval prompts). */
const READONLY_TOOL_NAMES = ["search_docs", "read_doc", "read_file", "list_files", "fetch_url"];
export function readonlyTools(): Tool[] {
  return tools.filter((t) => READONLY_TOOL_NAMES.includes(t.name));
}

/**
 * Drive a no-tool-calling model through the ReAct text protocol to a Final Answer,
 * executing tools from `toolList`. This is the portable core the VS Code Stop hook
 * also embodies — reused here so each expert is a genuine tool-capable agent.
 */
export async function runReactAgent(opts: {
  llm: LlmFn;
  system: string;
  task: string;
  toolList: Tool[];
  maxSteps: number;
}): Promise<{ answer: string; toolCalls: number }> {
  const { llm, toolList, maxSteps } = opts;
  const messages: ChatMessage[] = [
    { role: "system", content: `${renderPreamble(toolList)}\n\n${opts.system}` },
    { role: "user", content: opts.task },
  ];
  let toolCalls = 0;
  for (let step = 0; step < maxSteps; step++) {
    const text = await llm(messages);
    messages.push({ role: "assistant", content: text });
    const turn = parseAssistantTurn(text);
    if (turn.kind === "final") return { answer: turn.answer, toolCalls };
    if (turn.kind === "error") {
      messages.push({ role: "user", content: turn.reason });
      continue;
    }
    const tool = getTool(turn.action);
    if (!tool || !toolList.includes(tool)) {
      messages.push({
        role: "user",
        content: `Tool "${turn.action}" is not available. Allowed: ${toolList.map((t) => t.name).join(", ")}. Choose one or give your Final Answer.`,
      });
      continue;
    }
    const result = await tool.execute(turn.input);
    toolCalls++;
    messages.push({ role: "user", content: formatObservation(turn.action, result) });
  }
  // Out of tool steps — force a final statement.
  const text = await llm([
    ...messages,
    { role: "user", content: 'Stop using tools now. Give your "Final Answer:" using what you have.' },
  ]);
  const turn = parseAssistantTurn(text);
  return { answer: turn.kind === "final" ? turn.answer : text.trim(), toolCalls };
}

/** The shared instruction block appended to every expert's task. */
function councilInstructions(useTools: boolean): string {
  return useTools
    ? "You are one member of an expert council. Research as needed with the read-only tools, " +
        "then state your position. End with a single 'Final Answer:' containing your council " +
        "statement (3-6 sentences): your assessment, and where you agree or disagree with other members."
    : "You are one member of an expert council. In 3-6 sentences, state your assessment from your " +
        "perspective, explicitly engaging with what other members said (agree, disagree, or extend). " +
        "Be substantive and concrete; cite the documents where relevant.";
}

/** Build one expert's task: the question, the shared documents, and the debate so far. */
function expertTask(question: string, docContext: string, bus: BusMessage[], round: number): string {
  const prior = bus.filter((m) => m.round < round);
  const transcript = prior.length
    ? prior.map((m) => `### ${m.from} (round ${m.round + 1})\n${m.text}`).join("\n\n")
    : "(You are speaking first; no prior remarks yet.)";
  return [
    `# Question before the council\n${question}`,
    docContext ? `\n# Shared documents\n${docContext}` : "",
    `\n# Discussion so far\n${transcript}`,
    `\n# Your turn (round ${round + 1})`,
  ].join("\n");
}

/** Run one expert's turn — a ReAct loop if tools are enabled, else a single completion. */
async function expertTurn(
  cfg: CouncilConfig,
  llm: LlmFn,
  expert: Expert,
  task: string,
): Promise<string> {
  const system = `${expert.persona}\n\n${councilInstructions(cfg.useTools)}`;
  if (cfg.useTools) {
    const { answer } = await runReactAgent({
      llm,
      system,
      task,
      toolList: readonlyTools(),
      maxSteps: Math.max(1, cfg.expertSteps),
    });
    return answer.trim();
  }
  const text = await llm([
    { role: "system", content: system },
    { role: "user", content: task },
  ]);
  return text.trim();
}

export interface CouncilDeps {
  llm: LlmFn;
  /** Query-agnostic document context to share with every expert (may be empty). */
  docContext: string;
  /** Called as each message lands on the bus, for progress UI + persistence. */
  onMessage?: (m: BusMessage) => void;
  log?: (line: string) => void;
}

/**
 * Run the full council: `rounds` of parallel expert turns over a shared bus, then a
 * moderator synthesis. Returns the bus plus the moderator's final verdict.
 */
export async function runCouncil(
  cfg: CouncilConfig,
  question: string,
  deps: CouncilDeps,
): Promise<{ bus: BusMessage[]; verdict: string }> {
  const bus: BusMessage[] = [];
  const log = deps.log ?? (() => undefined);

  for (let round = 0; round < cfg.rounds; round++) {
    log(`— Round ${round + 1}/${cfg.rounds} —`);
    // Experts in a round run concurrently; all read the SAME prior-round bus snapshot.
    const results = await Promise.all(
      cfg.experts.map(async (expert) => {
        const task = expertTask(question, deps.docContext, bus, round);
        try {
          return { expert, text: await expertTurn(cfg, deps.llm, expert, task) };
        } catch (err) {
          return { expert, text: `[error: ${String(err)}]` };
        }
      }),
    );
    // Commit the whole round atomically so cross-talk happens at the boundary.
    for (const { expert, text } of results) {
      const m: BusMessage = { round, from: expert.name, text, ts: Date.now() };
      bus.push(m);
      deps.onMessage?.(m);
      log(`  ${expert.name}: ${text.replace(/\s+/g, " ").slice(0, 140)}…`);
    }
  }

  log(`— ${cfg.moderator.name} synthesizing —`);
  const transcript = bus.map((m) => `### ${m.from} (round ${m.round + 1})\n${m.text}`).join("\n\n");
  const verdict = (
    await deps.llm([
      { role: "system", content: cfg.moderator.persona },
      {
        role: "user",
        content:
          `# Question\n${question}\n\n# Full council discussion\n${transcript}\n\n` +
          "# Your synthesis\nWrite the council's verdict as Markdown with sections: " +
          "Points of agreement, Open disagreements, Bottom line.",
      },
    ])
  ).trim();

  const moderatorMsg: BusMessage = { round: cfg.rounds, from: cfg.moderator.name, text: verdict, ts: Date.now() };
  bus.push(moderatorMsg);
  deps.onMessage?.(moderatorMsg);
  return { bus, verdict };
}

/** Render the council result as a COUNCIL.md report. */
export function renderCouncilReport(cfg: CouncilConfig, question: string, bus: BusMessage[], verdict: string): string {
  const rounds = bus.filter((m) => m.round < cfg.rounds);
  const byRound = new Map<number, BusMessage[]>();
  for (const m of rounds) {
    const arr = byRound.get(m.round) ?? [];
    arr.push(m);
    byRound.set(m.round, arr);
  }
  const out = [`# Council verdict\n`, `**Question:** ${question}\n`, `## Verdict\n${verdict}\n`, `## Transcript\n`];
  for (const [round, msgs] of [...byRound.entries()].sort((a, b) => a[0] - b[0])) {
    out.push(`### Round ${round + 1}`);
    for (const m of msgs) out.push(`**${m.from}:** ${m.text}\n`);
  }
  return out.join("\n");
}

/** Resolve an apiKey that may be a literal or `env:VAR_NAME`. */
export function resolveApiKey(key: string): string {
  const m = /^env:(.+)$/.exec(key.trim());
  return m ? process.env[m[1]] ?? "" : key;
}
