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
   `.github/hooks/react.json` + `.github/agents/react-byok.agent.md` (all relative
   paths — committable, no `npm install` needed in the target project).
4. Enable the `chat.useCustomAgentHooks` setting (hooks are a Preview feature).
5. Select the **ReAct BYOK** agent in chat.

### Build the VSIX yourself

```bash
npm install
npm run package    # builds (src/ -> dist/) and writes react-byok.vsix
npm test           # parser + simulated Stop-step tests
```

## Layout

- `src/tools.ts` — the `run_command` tool (single source of truth).
- `src/format.ts` — text catalog/preamble + the action parser.
- `src/transcript.ts` — reads the last assistant message.
- `src/hooks/inject-catalog.ts` — `SessionStart` hook.
- `src/hooks/react-step.ts` — `Stop` hook (the loop engine).

## Safety

Per-session iteration cap, command timeout, output truncation, and corrective
re-prompts on malformed model output. `run_command` runs real shell commands —
review the agent's tasks accordingly; tighten it with a `PreToolUse`-style
denylist if you extend the tool surface.
