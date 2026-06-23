# Task: Literature review from local PDFs + arXiv

You are the **ReAct BYOK** agent. Your only tool is `run_command`. Use the helper
scripts in `examples/lit-review/scripts/` to gather evidence, then synthesize a
review. Fill in the two placeholders before running:

- **TOPIC**: `{{TOPIC}}`  (e.g. "efficient long-context attention")
- **PAPERS_DIR**: `{{PAPERS_DIR}}`  (e.g. "examples/lit-review/papers")

## Procedure

Work one step at a time. After each Action, read the Observation before deciding
the next step.

1. **Inventory the local corpus.**
   `Action Input: {"cmd":"bash examples/lit-review/scripts/list-pdfs.sh {{PAPERS_DIR}}"}`
   If there are no PDFs, say so in the final answer and continue with arXiv only.

2. **Read each local PDF** (one per turn; cap the text you pull):
   `Action Input: {"cmd":"bash examples/lit-review/scripts/pdf-to-text.sh <path> 6000"}`
   For each, note: problem addressed, method, key result, and limitations.

3. **Derive 2–4 arXiv queries** from the themes you found, and search:
   `Action Input: {"cmd":"node examples/lit-review/scripts/arxiv-search.mjs \"<query>\" 6"}`
   Prefer recent and highly relevant entries; record title, authors, year, link.

4. **Cross-reference.** Optionally check which local PDFs mention a key term:
   `Action Input: {"cmd":"bash examples/lit-review/scripts/grep-pdfs.sh {{PAPERS_DIR}} \"<term>\"}`

5. **Write the review to disk** as Markdown, then stop:
   `Action Input: {"cmd":"cat > examples/lit-review/REVIEW.md <<'EOF'\n<your review>\nEOF"}`

## Output structure for REVIEW.md

- **Overview** — the topic and scope, and what the local corpus covers.
- **Local papers** — one short paragraph per PDF (problem / method / result / limits).
- **Related arXiv work** — grouped by theme, each item cited as
  `Title (Authors, Year) — link`.
- **Synthesis** — agreements, disagreements, and open gaps across both sources.
- **Reading list** — the 3–5 most important next papers and why.

## Rules

- One Action per turn; wait for the Observation.
- Don't invent citations — only cite PDFs you actually read and arXiv entries the
  search returned.
- When `REVIEW.md` is written, end with a `Final Answer:` summarizing what you did
  and pointing at the file.
