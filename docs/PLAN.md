# Plan: ReAct agent via VS Code hooks for a no-tool-calling LLM

## Problem

A BYOK / local model that lacks native tool-calling is never handed JSON tool
schemas by VS Code agent mode (and is hidden from the model picker). To make such
a model act as a ReAct agent, we drive the entire tool loop **through hooks**,
using only text the model can read and write.

## Mechanism

- **Tools-as-text in, actions-as-text out.** The model never sees a tool schema
  over the API. It sees a textual catalog and emits
  `Thought / Action / Action Input` text.
- **The loop is powered by the `Stop` hook.** When the model ends a turn with plain
  text (no native tool call), VS Code tries to end the session. The `Stop` hook
  parses the action, runs it, and returns `decision:"block"` with the observation
  in `reason` — which forces the agent to continue. `Stop` + `decision:block` +
  `reason` is the only lever that both re-injects content *and* keeps a no-tool
  model running.

### Spec constraints that shaped the design

Verified against the VS Code agent hooks reference (Feb 2026 Preview):

- `UserPromptSubmit` and `Stop` have **no `additionalContext`** field → the static
  tool catalog is injected at **`SessionStart`**, and per-step observations ride in
  the `Stop` hook's **`reason`**.
- `PreToolUse` / `PostToolUse` are **never reached**, because the model emits no
  native tool calls — so the loop cannot rely on them.

## Architecture

```
SessionStart hook ─► inject ReAct preamble + run_command catalog + output format
        │
        ▼
   model emits:  Thought… / Action: run_command / Action Input: {"cmd":"ls src"}
        │
        ▼
   agent tries to Stop ─► Stop hook fires
        ├─ Final Answer?  ── yes ─► allow stop (continue:true)
        ├─ valid Action?  ── no  ─► block with a format-correction reason
        └─ yes ─► execute command → {decision:"block", reason:"Observation:\n…"} ─► loops back
```

Loop safety: per-session iteration counter (keyed by `session_id`, capped at 15),
command timeout, output truncation, and graceful recovery on malformed output.

## Decisions

- **Shell-only tool surface** (`run_command`): the Stop hook executes directly, no
  MCP server, no duplicated registry.
- **TypeScript / Node** runtime.
- **Working end-to-end sample**: hooks + dispatcher + config + custom agent + tests.

## Files

| File | Purpose |
|------|---------|
| `package.json`, `tsconfig.json` | Node/TS project; `npm run build` → `dist/`. |
| `.github/hooks/react.json` | Registers `SessionStart` and `Stop` hooks. |
| `src/tools.ts` | Single source of truth: the `run_command` tool (schema + executor). |
| `src/format.ts` | Renders the text preamble/catalog; tolerant action parser. |
| `src/transcript.ts` | Reads the last assistant message from the transcript. |
| `src/hooks/inject-catalog.ts` | `SessionStart`: injects the catalog via `additionalContext`. |
| `src/hooks/react-step.ts` | `Stop`: parse → execute → block-with-observation / allow-stop. |
| `.github/agents/react-byok.agent.md` | Custom agent selecting a no-tool BYOK model. |
| `test/loop.test.ts` | Parser + simulated Stop-step tests. |

## Verification

- Parser unit tests.
- Simulated `Stop` step: a transcript ending in a valid Action returns
  `decision:block` with the real command output as the observation; a `Final Answer`
  returns `continue:true`; the loop cap trips after the max.

## Known limits / assumptions

- The no-tool model is reached via VS Code BYOK (e.g. Ollama). Verification here is
  via simulated-transcript tests, not a live model.
- Targets the Feb 2026 Preview hooks feature (`.github/hooks/*.json`, agent-scoped
  hooks behind `chat.useCustomAgentHooks`).
- Transcript on-disk format is not strongly specified; the reader is tolerant of
  JSONL and single-document shapes.

## Sources

- [Agent hooks (VS Code docs)](https://code.visualstudio.com/docs/agent-customization/hooks)
- [Hooks reference](https://code.visualstudio.com/docs/agents/reference/hooks-reference)
- [vscode-copilot-chat hooks.md](https://github.com/microsoft/vscode-copilot-chat/blob/main/assets/prompts/skills/agent-customization/references/hooks.md)
- [Custom agents](https://code.visualstudio.com/docs/agent-customization/custom-agents)
