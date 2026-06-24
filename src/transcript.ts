import { readFileSync } from "node:fs";

/**
 * Read the last assistant message text out of a session transcript.
 *
 * The transcript referenced by a hook's `transcript_path` is JSONL — one event per
 * line. VS Code / GitHub Copilot agent transcripts use events shaped like:
 *
 *   {"type":"assistant.message","data":{"messageId":"…","content":"…","toolRequests":[]}, …}
 *
 * so the assistant's text is `data.content` on `assistant.message` events. We parse
 * that exact shape first, then fall back to a tolerant heuristic for other/older
 * formats (role/message/content variants, single-document arrays).
 */
export function readLastAssistantText(transcriptPath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }

  let last: string | null = null;

  // JSONL: one event/message per line.
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  let parsedAnyLine = false;
  for (const line of lines) {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    parsedAnyLine = true;
    const text = extractAssistantText(obj);
    if (text && text.trim()) last = text;
  }
  if (parsedAnyLine && last !== null) return last;

  // Fallback: a single JSON document holding an array of events/messages.
  try {
    const doc = JSON.parse(raw) as Record<string, unknown> | unknown[];
    const arr: unknown[] = Array.isArray(doc)
      ? doc
      : ((doc as Record<string, unknown>).messages as unknown[]) ??
        ((doc as Record<string, unknown>).transcript as unknown[]) ??
        ((doc as Record<string, unknown>).events as unknown[]) ??
        [];
    for (const obj of arr) {
      const text = extractAssistantText(obj);
      if (text && text.trim()) last = text;
    }
  } catch {
    /* not a single JSON document */
  }

  return last;
}

/** Pull assistant text out of one transcript entry, or "" if it isn't one. */
function extractAssistantText(obj: unknown): string {
  if (!obj || typeof obj !== "object") return "";
  const o = obj as Record<string, unknown>;

  // Exact: Copilot agent transcript event.
  if (o.type === "assistant.message") {
    const data = (o.data as Record<string, unknown>) ?? {};
    return contentToText(data.content ?? data.text ?? "");
  }
  // Skip the non-message Copilot events (turn_start/turn_end/session.start/user.message).
  if (typeof o.type === "string" && o.type.includes(".")) return "";

  // Permissive fallback for other agent/chat transcript shapes.
  const msg = o.message && typeof o.message === "object" ? (o.message as Record<string, unknown>) : o;
  const role = String(msg.role ?? o.role ?? o.type ?? o.kind ?? o.author ?? o.sender ?? "");
  if (!/assistant|model|response|agent|copilot|bot/i.test(role)) return "";
  const data = (o.data as Record<string, unknown>) ?? {};
  return contentToText(msg.content ?? data.content ?? o.content ?? o.text ?? "");
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        const part = p as Record<string, unknown>;
        return (part?.text as string) ?? (part?.value as string) ?? (part?.content as string) ?? "";
      })
      .join("");
  }
  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    return (c.text as string) ?? (c.value as string) ?? "";
  }
  return "";
}

/**
 * A compact, redaction-friendly view of a transcript file for the debug log, used
 * when no assistant text could be parsed — so an unexpected format reveals itself
 * instead of silently failing.
 */
export function sampleTranscript(transcriptPath: string): {
  bytes: number;
  lines: number;
  lastTypes: string[];
  tail: string;
} | null {
  try {
    const raw = readFileSync(transcriptPath, "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const lastTypes: string[] = [];
    for (const line of lines.slice(-6)) {
      try {
        const o = JSON.parse(line) as Record<string, unknown>;
        lastTypes.push(String(o.type ?? o.role ?? o.kind ?? "?"));
      } catch {
        lastTypes.push("<unparsed>");
      }
    }
    return { bytes: raw.length, lines: lines.length, lastTypes, tail: raw.slice(-800) };
  } catch {
    return null;
  }
}
