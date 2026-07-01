# Onboarding: setting up ReAct BYOK

This walks you from a fresh install to a working agent, and picks the path that runs on
your machine. There's also an interactive version: **Command Palette → "Welcome: Open
Walkthrough…" → "Get started with ReAct BYOK."**

## TL;DR

1. Install the VSIX, reload.
2. **ReAct BYOK: Set up in this workspace** (enter your model id).
3. **ReAct BYOK: Open model config** → set your OpenAI-compatible endpoint in `council.json`.
4. **ReAct BYOK: Diagnose setup** → read the recommendation.
5. Use **Path A** (in-chat, hooks) or **Path B** (hook-free runner) as recommended.

---

## 1. Install

- Command Palette → **Extensions: Install from VSIX…** → pick `react-byok.vsix`
  (or `code --install-extension react-byok.vsix`), then **reload**.
- Open the project folder you want to work in.

## 2. Set up the workspace

Run **ReAct BYOK: Set up in this workspace** and enter your model id. This:

- stages the runtime into **local** storage (never OneDrive),
- writes `.github/hooks/react.json` and the bundled agents,
- creates `.react-byok/context.json` (document context + guardrails) and
  `.react-byok/council.json` (model endpoint),
- creates `docs/` and `papers/`.

> Re-run setup after updating the extension or moving the project to another machine.

## 3. Point it at your model

Run **ReAct BYOK: Open model config** and edit the `llm` block of `council.json`:

```jsonc
{
  "llm": {
    "baseUrl": "https://your-host/v1",
    "apiKey": "env:OPENAI_API_KEY",
    "model": "your-model-id"
  }
}
```

`apiKey` may be a literal or `"env:VAR_NAME"`. For local Ollama use
`http://localhost:11434/v1`. This endpoint powers the **hook-free runner** and the
**council**. (The in-chat hook path uses the model VS Code itself is configured with.)

## 4. Diagnose

Run **ReAct BYOK: Diagnose setup**. It checks OneDrive, `cmd.exe` (Windows), the hooks
setting, the staged runtime, `react.json`, whether `hook.log` has ever appeared, and your
model endpoint — then prints a recommendation in the **ReAct Tools** output channel.

## 5. Pick your path

### Path A — in-chat agent (hooks) — *most machines*

1. Enable **`chat.useCustomAgentHooks`** (preview) and reload.
2. In chat, pick the **ReAct BYOK** agent (or **ArXiv Researcher**).
3. Ask something. Success = `.react-byok/hook.log` appears and tools show in **ReAct Tools**.

### Path B — hook-free runner — *no cmd.exe / locked-down / OneDrive Windows*

1. Make sure `council.json` has your endpoint (step 3).
2. Run **ReAct BYOK: Run agent (hook-free)**, type your task.
3. Watch **ReAct Tools**; approve `run_command`/`write_file` when prompted; read `ANSWER.md`.

Why it works where hooks don't: the extension spawns the runner **directly** (no shell), so
it never invokes `cmd.exe`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `spawn UNKNOWN` when the agent starts; **no** `hook.log` | VS Code launches hooks via `cmd.exe`; it's missing/blocked on your box | Use **Path B** (hook-free). It never uses `cmd.exe`. |
| `spawn UNKNOWN`, workspace on OneDrive | OneDrive placeholder used as the spawn dir | Re-run setup (uses a local `cwd`); if you rely on `run_command`, also pin the folder ("Always keep on this device"). Or use **Path B**. |
| PowerShell "unexpected token" running the command manually | You pasted the POSIX `command` line into PowerShell | Use the `windows`/`powershell` line, or just let setup wire it. |
| `arxiv_search` fails with a certificate error | Missing corporate CA | It auto-retries without TLS verification (`allowInsecureTls: true` in `context.json`). |
| Hook-free runner: "No llm.baseUrl…" | `council.json` endpoint not set | Run **Open model config** and set `llm.baseUrl`. |

Still stuck? Run **Diagnose setup** and follow the recommendation at the bottom.
