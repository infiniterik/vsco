import type { ContextConfig } from "./docs.js";

/** A document with its extracted text, ready for budgeting/ranking. */
export interface GatheredDoc {
  label: string;
  text: string;
  tokens: number;
}

/** Rough token estimate (~4 chars/token) — good enough for budgeting. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** A short, whitespace-collapsed preview of a document's text. */
export function preview(text: string, n: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}

export interface Chunk {
  label: string;
  offset: number;
  text: string;
}

/** Split text into overlapping character windows sized by a token budget. */
export function chunkText(label: string, text: string, chunkTokens = 400, overlapTokens = 40): Chunk[] {
  const size = chunkTokens * 4;
  const step = Math.max(1, (chunkTokens - overlapTokens) * 4);
  const chunks: Chunk[] = [];
  for (let off = 0; off < text.length; off += step) {
    const slice = text.slice(off, off + size);
    if (slice.trim()) chunks.push({ label, offset: off, text: slice });
    if (off + size >= text.length) break;
  }
  return chunks;
}

function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])];
}

/** Score and select the chunks most relevant to a query, up to a token budget. */
export function rankChunks(query: string, chunks: Chunk[], budgetTokens: number): Chunk[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const scored = chunks
    .map((chunk) => {
      const hay = chunk.text.toLowerCase();
      let score = 0;
      let distinct = 0;
      for (const term of terms) {
        let count = 0;
        let idx = hay.indexOf(term);
        while (idx !== -1) {
          count++;
          idx = hay.indexOf(term, idx + term.length);
        }
        if (count > 0) distinct++;
        score += count;
      }
      // Reward chunks covering more distinct query terms.
      return { chunk, score: score + distinct * 2 };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.text.length - b.chunk.text.length);

  const out: Chunk[] = [];
  let used = 0;
  for (const { chunk } of scored) {
    const t = estimateTokens(chunk.text);
    if (used + t > budgetTokens) continue;
    out.push(chunk);
    used += t;
    if (used >= budgetTokens) break;
  }
  return out;
}

/**
 * Build the query-agnostic context injected at SessionStart: a manifest of every
 * document plus the full text of as many as fit the budget (smallest first), with a
 * preview for the rest and a note on how to retrieve more.
 */
export function buildInjection(docs: GatheredDoc[], cfg: ContextConfig): string {
  if (!docs.length) return "";
  const sorted = [...docs].sort((a, b) => a.tokens - b.tokens);
  const fullBudget = Math.floor(cfg.budgetTokens * 0.8);

  const full = new Set<string>();
  let used = 0;
  for (const d of sorted) {
    if (used + d.tokens <= fullBudget) {
      full.add(d.label);
      used += d.tokens;
    }
  }

  const manifest = sorted
    .map((d, i) => {
      const tag = full.has(d.label) ? "FULL" : "PREVIEW";
      const head = `[${i + 1}] ${d.label} (~${d.tokens} tok) [${tag}]`;
      return full.has(d.label) ? head : `${head}\n    ${preview(d.text, cfg.previewChars)}`;
    })
    .join("\n");

  const fullText = sorted
    .filter((d) => full.has(d.label))
    .map((d) => `\n===== ${d.label} =====\n${d.text}`)
    .join("\n");

  return [
    "# Local document context",
    `${docs.length} document(s) from the workspace are available. Those marked [FULL] are`,
    "included in full below; [PREVIEW] ones show only an excerpt.",
    "",
    "## Document manifest",
    manifest,
    "",
    "## How to read more (without dumping everything)",
    "- `search_docs` {query}: get the most relevant passages from ALL documents in one call —",
    "  prefer this over reading whole files.",
    "- `read_doc` {path}: read one full document (use a manifest path).",
    "- As you reach conclusions, save them with `write_file` (e.g. to REVIEW.md) so they",
    "  survive context compaction; re-read them later if needed.",
    full.size ? "\n## Full documents" : "",
    fullText,
  ].join("\n");
}

/** Format a query-aware search across the gathered documents. */
export function runSearch(docs: GatheredDoc[], query: string, budgetTokens: number): string {
  const chunks = docs.flatMap((d) => chunkText(d.label, d.text));
  const top = rankChunks(query, chunks, budgetTokens);
  if (!top.length) return `No passages matched "${query}" in the ${docs.length} local document(s).`;
  const body = top
    .map((c) => `[${c.label} @ ${c.offset}]\n${c.text.replace(/\s+/g, " ").trim()}`)
    .join("\n\n");
  return `Top ${top.length} passage(s) for "${query}":\n\n${body}`;
}
