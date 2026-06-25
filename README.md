# react-hooks-agent

Drive a **no-tool-calling LLM** as a **ReAct agent** using VS Code agent hooks.

Some models (local / BYOK models such as those served by Ollama) cannot receive
tool specifications, so VS Code agent mode won't hand them tools. This project
works around that entirely with hooks: tools are described to the model as **text**,
and the model's textual actions are executed by a `Stop` hook that feeds results
back as observations — a classic ReAct loop.

See [`docs/PLAN.md`](docs/PLAN.md) for the design and the spec constraints behind it.

## How it works

```
SessionStart ─► inject tool catalog + ReAct format as text
   model ─► Thought / Action: run_command / Action Input: {"cmd":"ls"}
   Stop  ─► parse → run command → {decision:"block", reason:"Observation: …"} ─► loop
   model ─► … / Final Answer: <answer>
   Stop  ─► continue:true (session ends)
```

The whole tool surface is a single `run_command` shell tool, so the `Stop` hook
executes actions directly — no separate tool server.

## Install (VS Code extension / VSIX)

This is packaged as a VS Code extension that bundles the hook runtime.

1. Install the VSIX:
   - Command Palette → **Extensions: Install from VSIX…** → pick `react-byok.vsix`, or
   - `code --install-extension react-byok.vsix`
2. Open the workspace you want to use it in.
3. Command Palette → **ReAct BYOK: Set up in this workspace**, and enter your model id.
   This copies the self-contained runtime into `.react-byok/` and writes
   `.github/hooks/react.json` + `.github/agents/react-byok.agent.md`.
4. Enable the `chat.useCustomAgentHooks` setting (hooks are a Preview feature).
5. Select the **ReAct BYOK** agent in chat.

> **No Node.js install required.** The generated hooks run the bundled scripts with
> the Node runtime that ships inside VS Code itself (`process.execPath` +
> `ELECTRON_RUN_AS_NODE=1`), so this works on machines with no developer setup. The
> setup command bakes the path to your VS Code executable into
> `.github/hooks/react.json`, so **re-run the setup command after moving the project
> to another machine or upgrading VS Code** if the path changes.

### Build the VSIX yourself

```bash
npm install
npm run package    # builds (src/ -> dist/) and writes react-byok.vsix
npm test           # parser + simulated Stop-step tests
```

## Tools, output, and multiple agents

- **Tools** are defined in `src/tools.ts` and automatically offered to every agent
  (rendered into the injected catalog and dispatched by the Stop hook). Built in:
  `run_command`, `fetch_url`, `arxiv_search`, `search_docs`, `read_doc`, `read_file`,
  `write_file`, `list_files`. To add a tool, append one object to the `tools` array —
  nothing else to wire up. The preamble steers the model to these dedicated tools over
  ad-hoc `run_command` scripts (`fetch_url` for web pages/APIs, `search_docs`/`read_doc`
  for local PDFs), so a no-tool model stops reimplementing them in Python.
- **`fetch_url`** does an HTTP(S) GET (HTML reduced to readable text by default; raw with
  `as_text:false`) and shares the arXiv cert fallback — so non-arXiv web sources don't
  require a scraping script.
- **Document context**: documents in a configured folder (default `docs/`, including
  PDFs) are gathered automatically at session start — a budgeted manifest plus the full
  text of as many as fit `budgetTokens` (in `.react-byok/context.json`), the rest as
  previews. The agent then uses `search_docs` {query} for one-call ranked retrieval
  across the whole corpus, or `read_doc` {path} for a full document. PDF text is
  extracted offline via a bundled pdf.js (no external tools). Run *ReAct BYOK: Re-gather
  document context* after adding files to refresh the cache.
- **Tool output buffer**: each tool run is appended to `.react-byok/commands.log`,
  which the extension tails into the **"ReAct Tools"** Output channel. Run
  *ReAct BYOK: Show tool output* to open it.
- **Guardrails**: file tools (`read_file`/`read_doc`/`write_file`/`list_files`) are
  **path-contained** to the workspace root — `../` and absolute escapes are refused, and
  `write_file` can't touch `.react-byok/` (so the agent can't disable its own guardrails).
  State-changing executions (`run_command`, `write_file`) require **user authorization**:
  the Stop hook asks the extension, which shows an Allow / Allow for session / Deny modal;
  fail-safe is **deny** (timeout or no extension). Configure via `approval` in
  `.react-byok/context.json` — e.g. add regexes to `allowCommands` to auto-approve safe
  commands, or change `requireFor`.
- **Step budget**: the ReAct loop caps tool steps per session (`maxSteps` in
  `.react-byok/context.json`, default 40). It is **read live on every Stop**, so editing
  the value applies on the next step — raise it mid-run for a long task, no reload needed.
- **Multiple agents** share one tool runtime and are **bundled in the VSIX**, auto-
  deployed to `.github/agents/` on install/reload: **ReAct BYOK** (general) and
  **ArXiv Researcher** (literature reviews over local papers + arXiv). Each agent file
  is just a task-specific prompt; add more via the `AGENTS` list in `src/extension.ts`.

## Layout

- `src/tools.ts` — tool definitions (single source of truth).
- `src/format.ts` — text catalog/preamble + the action parser.
- `src/transcript.ts` — reads the last assistant message.
- `src/hooks/inject-catalog.ts` — `SessionStart` hook.
- `src/hooks/react-step.ts` — `Stop` hook (the loop engine).

## Safety

Per-session iteration cap, command timeout, output truncation, and corrective
re-prompts on malformed model output. `run_command` runs real shell commands —
review the agent's tasks accordingly; tighten it with a `PreToolUse`-style
denylist if you extend the tool surface.
