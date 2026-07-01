# Path A — in-chat agent (hooks)

Use this when **Diagnose setup** says hooks are viable (most machines).

1. Enable the preview setting **`chat.useCustomAgentHooks`** (button on the left).
2. Reload VS Code.
3. Open the **chat** view and pick the **ReAct BYOK** agent (or **ArXiv Researcher**).
4. Ask it something. The loop runs via hooks: `SessionStart` injects the tool catalog as
   text, and the `Stop` hook runs each Action and feeds back the Observation.

**How to tell it's working:** after your first message, **`.react-byok/hook.log`** should
appear/update, and tool runs show in the **ReAct Tools** output channel.

**If `hook.log` never appears**, your machine is blocking hook spawning (commonly no
`cmd.exe`, since VS Code runs hooks through it). Switch to **Path B — the hook-free
runner**, which doesn't use hooks at all.
