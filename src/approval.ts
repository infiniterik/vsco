import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { reactDir } from "./debug.js";

export interface ApprovalConfig {
  /** Tool names whose execution must be authorized by the user. */
  requireFor: string[];
  /** Regex strings; a run_command whose command matches any is auto-approved. */
  allowCommands: string[];
  /** How long the hook waits for the user's decision before failing safe (deny). */
  timeoutSec: number;
}

export const DEFAULT_APPROVAL: ApprovalConfig = {
  requireFor: ["run_command", "write_file"],
  allowCommands: [],
  timeoutSec: 540,
};

export type Decision = "allow" | "deny";

function pendingDir(): string {
  const d = reactDir(".pending");
  mkdirSync(d, { recursive: true });
  return d;
}

function loadApproved(): Record<string, { tools: string[] }> {
  try {
    return JSON.parse(readFileSync(reactDir("approved.json"), "utf8"));
  } catch {
    return {};
  }
}

function rememberSession(sessionId: string, tool: string): void {
  try {
    const data = loadApproved();
    const tools = new Set([...(data[sessionId]?.tools ?? []), tool]);
    data[sessionId] = { tools: [...tools] };
    writeFileSync(reactDir("approved.json"), JSON.stringify(data));
  } catch {
    /* best effort */
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Decide whether a gated tool execution is authorized. Order:
 *   1. allowlist (run_command whose command matches an allowCommands regex),
 *   2. per-session "allow for session" cache,
 *   3. interactive prompt: write a request under `.react-byok/.pending/` and poll for the
 *      extension's decision. Fail-safe is DENY (timeout, no extension, or write error).
 */
export async function requireApproval(
  sessionId: string,
  tool: string,
  summary: string,
  command: string | undefined,
  cfg: ApprovalConfig,
): Promise<Decision> {
  if (tool === "run_command" && command) {
    for (const pat of cfg.allowCommands) {
      try {
        if (new RegExp(pat).test(command)) return "allow";
      } catch {
        /* ignore a bad pattern */
      }
    }
  }

  if (loadApproved()[sessionId]?.tools?.includes(tool)) return "allow";

  const id = randomBytes(6).toString("hex");
  const reqPath = join(pendingDir(), `${id}.json`);
  const decPath = join(pendingDir(), `${id}.decision`);
  try {
    writeFileSync(reqPath, JSON.stringify({ id, session_id: sessionId, tool, summary, ts: Date.now() }));
  } catch {
    return "deny"; // cannot even ask → fail safe
  }

  const deadline = Date.now() + cfg.timeoutSec * 1000;
  let decision: "allow" | "session" | "deny" | null = null;
  while (Date.now() < deadline) {
    if (existsSync(decPath)) {
      try {
        const d = JSON.parse(readFileSync(decPath, "utf8")).decision;
        if (d === "allow" || d === "session" || d === "deny") {
          decision = d;
          break;
        }
      } catch {
        /* decision file mid-write; retry */
      }
    }
    await sleep(250);
  }

  rmSync(reqPath, { force: true });
  rmSync(decPath, { force: true });

  if (decision === "session") {
    rememberSession(sessionId, tool);
    return "allow";
  }
  return decision === "allow" ? "allow" : "deny";
}
