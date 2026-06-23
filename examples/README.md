# Example workflows

A "workflow" for the ReAct BYOK agent is a **task prompt plus a few shell helpers**
it drives through its only tool, `run_command`. Anything the model needs to *do* is
a CLI command; the prompt tells it how to sequence those commands and what to
produce.

The pattern for adding a workflow:

1. Make a folder under `examples/<name>/`.
2. Put small, single-purpose CLI helpers in `scripts/` (shell, or `node *.mjs` for
   anything that needs parsing). Each should print clean plain text — it becomes the
   agent's Observation.
3. Write a `PROMPT.md`: the goal, the exact `run_command` calls to use, the output
   format, and a clear stop condition ("end with a Final Answer when `X` is written").
4. Add a short `README.md` with prerequisites and how to run.

## Available workflows

| Workflow | What it does |
|----------|--------------|
| [`lit-review/`](lit-review/) | Reviews local PDFs and relates them to current arXiv work. |
