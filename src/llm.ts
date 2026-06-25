import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";

import { isCertError } from "./tools.js";

/**
 * Minimal OpenAI-compatible chat client.
 *
 * The council reuses the SAME no-tool-calling model configured for the ReAct BYOK
 * agent, so we never send a `tools` field — each expert drives tools through the
 * ReAct text protocol (see format.ts), exactly as the VS Code hook does. This module
 * only needs plain chat completions.
 */

export interface LlmConfig {
  /** Base URL of the OpenAI-compatible API, e.g. "https://host/v1". */
  baseUrl: string;
  /** Bearer key. May be empty for keyless local servers. */
  apiKey: string;
  model: string;
  /** Sampling temperature (default 0.7 — a little variety between experts). */
  temperature?: number;
  /** Retry once with TLS verification disabled on a certificate error. */
  allowInsecureTls?: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** One POST of a JSON body; `rejectUnauthorized` toggles TLS verification. */
function rawPost(url: string, body: string, apiKey: string, rejectUnauthorized: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === "https:";
    const requestFn = isHttps ? httpsRequest : httpRequest;
    const opts: RequestOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      ...(isHttps ? { rejectUnauthorized } : {}),
    };
    const req = requestFn(url, opts, (res) => {
      const status = res.statusCode ?? 0;
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (status >= 400) reject(new Error(`HTTP ${status}: ${text.slice(0, 500)}`));
        else resolve(text);
      });
    });
    req.setTimeout(120_000, () => req.destroy(new Error("LLM request timed out")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** POST a chat completion and return the assistant message text. */
export async function chat(cfg: LlmConfig, messages: ChatMessage[]): Promise<string> {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const body = JSON.stringify({
    model: cfg.model,
    messages,
    temperature: cfg.temperature ?? 0.7,
    stream: false,
  });
  let raw: string;
  try {
    raw = await rawPost(url, body, cfg.apiKey, true);
  } catch (err) {
    if (cfg.allowInsecureTls && isCertError(err)) raw = await rawPost(url, body, cfg.apiKey, false);
    else throw err;
  }
  const json = JSON.parse(raw) as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error(`Unexpected LLM response: ${raw.slice(0, 300)}`);
  return content;
}

/** A model caller bound to one config — what the council/driver actually invoke. */
export type LlmFn = (messages: ChatMessage[]) => Promise<string>;

export function makeLlm(cfg: LlmConfig): LlmFn {
  return (messages) => chat(cfg, messages);
}
