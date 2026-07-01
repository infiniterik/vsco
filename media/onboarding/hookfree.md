# Path B — hook-free runner

Use this on locked-down Windows (**no `cmd.exe`**) or where the hooks never run. It does
**not** use VS Code hooks and never touches `cmd.exe`.

**Prerequisite:** your model endpoint is set in `council.json` (step "Point it at your
model").

1. Run **ReAct BYOK: Run agent (hook-free)**.
2. Type your task.
3. Watch progress in the **ReAct Tools** output channel. State-changing tools
   (`run_command`, `write_file`) still ask for **Allow / Deny**.
4. The final answer is written to **`ANSWER.md`** (VS Code offers to open it).

**Why it works where hooks don't:** the extension spawns the runner **directly**
(`spawn(Code.exe, …)` with no shell), so nothing goes through `cmd.exe`. It drives the same
ReAct loop against your OpenAI-compatible endpoint with the full toolset and the same
guardrails.

Trade-off: it's a command + `ANSWER.md` flow, not the in-chat conversation panel.
