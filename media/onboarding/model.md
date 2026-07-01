# Point it at your model

Open **`.react-byok/council.json`** and set the `llm` block to your
**OpenAI-compatible** endpoint:

```jsonc
{
  "llm": {
    "baseUrl": "https://your-host/v1",   // OpenAI-compatible base URL
    "apiKey": "env:OPENAI_API_KEY",       // literal, or "env:VAR" to read from an env var
    "model": "your-model-id"
  }
}
```

- `apiKey` supports **`"env:VAR_NAME"`** so you don't commit secrets.
- For a local Ollama server use `"baseUrl": "http://localhost:11434/v1"`.

This endpoint powers both the **hook-free runner** and the **council of experts**. The
in-chat hook path instead uses the model VS Code is configured with.

▶ Click **Open model config** to edit `council.json`.
