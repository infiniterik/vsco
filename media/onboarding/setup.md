# Set up this workspace

Running **setup** does everything the extension needs in your project:

- **Stages the runtime** into local storage (never OneDrive) so scripts can always run.
- Writes **`.github/hooks/react.json`** (the hook wiring) and the custom agents.
- Creates **`.react-byok/context.json`** (document context + guardrails) and
  **`.react-byok/council.json`** (your model endpoint).
- Creates the `docs/` and `papers/` folders.

You'll be asked for a **model id** — the BYOK/local model without native tool-calling.

> Re-run setup after updating the extension or moving the project to another machine.

▶ Run **ReAct BYOK: Set up in this workspace** (button on the left).
