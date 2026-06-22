import { readFileSync } from "node:fs";

/**
 * Read the last assistant message text out of a session transcript.
 *
 * The Stop hook receives a `transcript_path`. The on-disk format is not strongly
 * specified across hosts, so this reader is deliberately tolerant: it handles
 * JSONL (one entry per line) and a single JSON document holding a `messages`
 * array, and normalizes both `{role, content}` and `{message: {role, content}}`
 * shapes with string or content-block arrays.
 */
export function readLastAssistantText(transcriptPath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }

  let lastText: string | null = null;

  // Attempt JSONL.
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  let parsedAnyLine = false;
  for (const line of lines) {
    try {
      const entry = normalizeEntry(JSON.parse(line));
      parsedAnyLine = true;
      if (entry && entry.role === "assistant" && entry.text.trim()) lastText = entry.text;
    } catch {
      // not a JSONL line; ignore
    }
  }
  if (parsedAnyLine && lastText !== null) return lastText;

  // Attempt a single JSON document.
  try {
    const doc = JSON.parse(raw) as unknown;
    const arr: unknown[] = Array.isArray(doc)
      ? doc
      : ((doc as Record<string, unknown>).messages as unknown[]) ??
        ((doc as Record<string, unknown>).transcript as unknown[]) ??
        [];
    for (const obj of arr) {
      const entry = normalizeEntry(obj);
      if (entry && entry.role === "assistant" && entry.text.trim()) lastText = entry.text;
    }
  } catch {
    // not a single JSON document either
  }

  return lastText;
}

function normalizeEntry(obj: unknown): { role: string; text: string } | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const m = (o.message as Record<string, unknown>) ?? o;
  const role = (m.role ?? o.role ?? o.type) as string | undefined;
  if (!role) return null;
  const content = m.content ?? o.content ?? o.text ?? "";
  return { role: String(role), text: contentToText(content) };
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : ((p as Record<string, unknown>)?.text as string) ?? ""))
      .join("");
  }
  if (content && typeof content === "object") {
    return ((content as Record<string, unknown>).text as string) ?? "";
  }
  return "";
}
