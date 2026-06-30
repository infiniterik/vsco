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

> **OneDrive (Windows).** Two OneDrive hazards both cause `spawn UNKNOWN` (the OS refuses
> to create a process from/into a OneDrive placeholder), so both the hook's **executable**
> and its **working directory** are kept off OneDrive:
> - The hook scripts are staged into the extension's **local** global storage
>   (`%APPDATA%\…\globalStorage`), not the workspace.
> - The generated `react.json` sets each hook's `cwd` to that local dir and passes the real
>   workspace path in `REACT_BYOK_WORKSPACE`; the hooks resolve `.react-byok/`, documents,
>   and `run_command`'s directory from that env var instead of the process `cwd`.
>
> So a OneDrive-hosted project runs without moving it off OneDrive — just **re-run setup**
> so `react.json` carries the local `cwd` + workspace env. (Global storage is keyed by
> extension id, so extension updates refresh the staged scripts automatically.) One caveat:
> `run_command` still launches shells **in** the workspace, so commands that themselves
> spawn from OneDrive placeholders can fail — if you rely heavily on `run_command`, pin the
> project folder ("Always keep on this device") so its files are fully local.

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

## Hook-free agent (no cmd.exe / locked-down Windows)

VS Code launches agent hooks via `spawn(shell: true)` → **cmd.exe** on Windows. On
locked-down machines without a usable `cmd.exe`, that spawn fails with `spawn UNKNOWN`
before the hook runs, and nothing in the hook config can avoid it. For those machines,
run the agent **without hooks**:

- *ReAct BYOK: Run agent (hook-free)* → type a task. The extension spawns the runner
  **directly** (`spawn(Code.exe, …)`, no shell → never touches cmd.exe), driving the same
  ReAct loop against the OpenAI-compatible endpoint in `.react-byok/council.json`, with the
  full toolset and the same Allow/Deny approval modal. Progress streams to the *ReAct Tools*
  output; the answer is written to `ANSWER.md`.
- Trade-off: it runs as a command + output flow, not the in-chat agent (the chat panel is
  what requires the hooks). Everything else — tools, document context, guardrails — is shared.

## Council of experts

Run **several expert agents that debate** over the same documents and reach a verdict —
a multi-agent discussion, not a single agent. Run *ReAct BYOK: Convene council of experts*,
type a question, and watch it in the "ReAct Tools" output; it writes `COUNCIL.md`.

- **How it reuses the engine, not VS Code.** VS Code drives exactly one interactive chat
  session and has no API to spawn/relay peer sessions, so a council can't live in its agent
  runtime. But the no-tool-calling workaround (catalog-as-text → parse Action → run tool →
  Observation) is just `format.ts` + `tools.ts` with no VS Code dependency. The council
  calls your **OpenAI-compatible endpoint directly** and runs that same ReAct loop per
  expert — so each expert is a tool-capable ReAct agent without native tool-calling.
- **Concurrency + bus.** Experts in a round run **in parallel** (`Promise.all`) but commit
  to a shared bus (`.react-byok/council/bus.jsonl`) at the **round boundary**, so each
  expert sees the others' last-round remarks — real cross-talk, no races. After `rounds`
  rounds a moderator synthesizes the bus into `COUNCIL.md`.
- **Config** (`.react-byok/council.json`): `llm` (`baseUrl`, `apiKey` — supports
  `"env:VAR"`, `model`), `experts` (name + persona), `moderator`, `rounds`, and `useTools`
  (default false = prose debate over the injected documents; true = experts may use the
  **read-only** tools `search_docs`/`read_doc`/`read_file`/`list_files`/`fetch_url` via a
  bounded ReAct loop — no `run_command`/`write_file`, so no approval prompts mid-debate).
- Runs as a spawned subprocess with VS Code's Node (cwd = workspace root, like the hooks).

## Layout

- `src/tools.ts` — tool definitions (single source of truth).
- `src/format.ts` — text catalog/preamble + action parser + observation formatter.
- `src/transcript.ts` — reads the last assistant message.
- `src/hooks/inject-catalog.ts` — `SessionStart` hook.
- `src/hooks/react-step.ts` — `Stop` hook (the loop engine).
- `src/council.ts` — council orchestration + the portable ReAct driver (`runReactAgent`).
- `src/llm.ts` — OpenAI-compatible chat client.
- `src/council-run.ts` — bundled council runner (spawned by the convene command).

## Safety

Per-session iteration cap, command timeout, output truncation, and corrective
re-prompts on malformed model output. `run_command` runs real shell commands —
review the agent's tasks accordingly; tighten it with a `PreToolUse`-style
denylist if you extend the tool surface.
