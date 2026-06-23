# Workflow: arXiv + local-PDF literature review

Drives the **ReAct BYOK** agent to review a folder of PDFs you already have and
relate it to current arXiv work — using nothing but the agent's `run_command`
tool plus the helper scripts here.

## Files

- `PROMPT.md` — the task you hand to the agent (fill in `{{TOPIC}}` and `{{PAPERS_DIR}}`).
- `scripts/list-pdfs.sh <dir>` — inventory the PDFs in a folder.
- `scripts/pdf-to-text.sh <file> [maxChars]` — extract text from one PDF.
- `scripts/grep-pdfs.sh <dir> <pattern>` — find which PDFs mention a term.
- `scripts/arxiv-search.mjs "<query>" [max]` — query the arXiv API, plain-text output.
- `papers/` — drop your PDFs here (or point `PAPERS_DIR` elsewhere).
- `REVIEW.md` — produced by the agent (git-ignored).

## Prerequisites

- **Node 18+** (for `arxiv-search.mjs`, uses built-in `fetch`).
- **poppler-utils** for the PDF scripts (`pdftotext`):
  - Debian/Ubuntu: `apt-get install -y poppler-utils`
  - macOS: `brew install poppler`
- Network access to `export.arxiv.org` for the arXiv search.

## Run it

1. Put PDFs in `examples/lit-review/papers/`.
2. In `PROMPT.md`, replace `{{TOPIC}}` and `{{PAPERS_DIR}}`.
3. Start the **ReAct BYOK** agent (see the repo README) and paste the prompt.

The agent will inventory the PDFs, read them, search arXiv, cross-reference, and
write `REVIEW.md`.

## Try the helpers directly

```bash
bash examples/lit-review/scripts/list-pdfs.sh examples/lit-review/papers
node examples/lit-review/scripts/arxiv-search.mjs "retrieval augmented generation" 5
bash examples/lit-review/scripts/pdf-to-text.sh examples/lit-review/papers/some.pdf 4000
```
