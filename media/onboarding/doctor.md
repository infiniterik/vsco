# Check your environment

**Diagnose setup** inspects your machine and tells you which path will work. It checks:

- whether the workspace is under **OneDrive** (placeholder files can break hook spawning),
- on Windows, whether **`cmd.exe`** exists (VS Code launches hooks through it),
- whether the hooks setting, staged runtime, and `react.json` are in place,
- whether **`.react-byok/hook.log`** exists — the tell for whether hooks have *actually run*,
- whether your **model endpoint** is configured.

It prints a report and a recommendation in the **ReAct Tools** output channel:

- **Hooks viable** → use Path A (the in-chat agent).
- **Hooks blocked** (no cmd.exe / OneDrive, or `hook.log` never appears) → use Path B
  (the hook-free runner).

▶ Click **Diagnose setup**, then read the recommendation at the bottom of the output.
