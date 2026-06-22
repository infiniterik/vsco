---
name: ReAct BYOK
description: Runs a model that lacks native tool-calling as a ReAct agent, driven entirely by SessionStart + Stop hooks.
model: ollama/llama3.1
tools: []
hooks:
  SessionStart:
    - type: command
      command: node ./dist/hooks/inject-catalog.js
      timeout: 15
  Stop:
    - type: command
      command: node ./dist/hooks/react-step.js
      timeout: 60
---

# ReAct BYOK agent

This custom agent makes a model that **cannot receive tool specifications** behave
like a ReAct agent.

- `model` should point at a Bring-Your-Own-Key / local model **without** native
  tool-calling (e.g. an Ollama model). Such models are normally hidden from agent
  mode because they can't be handed tool schemas.
- `tools: []` is intentional. We do **not** pass tools through the model API.
  Instead the hooks below carry the whole tool loop as text.

How the loop works:

1. **SessionStart** injects a textual tool catalog plus the strict
   `Thought / Action / Action Input / Observation / Final Answer` contract.
2. The model replies in that text format.
3. **Stop** parses the reply. A `Final Answer:` lets the session end; an `Action:`
   is executed and its output is fed back as an `Observation:` via
   `decision: "block"`, forcing another turn.

> Agent-scoped hooks are a Preview feature — enable `chat.useCustomAgentHooks`.
> Run `npm install && npm run build` first so `dist/` exists.
