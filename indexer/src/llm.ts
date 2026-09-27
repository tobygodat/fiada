// The indexer's one way to ask a language model something, so features that
// need one (sorting a project's leftovers, summaries) share the key, the
// model and the error messages. Today that's Claude through the Anthropic
// API, with the key in ANTHROPIC_API_KEY. Without a key, llmFromEnv() is null
// and each feature says it is unavailable rather than failing.

import Anthropic from '@anthropic-ai/sdk';
import { unquote } from './mongo-store.ts';

/** One request whose answer must parse as JSON following `schema`. */
export interface JsonRequest {
  /** Short name for logs and errors, e.g. "domains" or "leftovers 2/8". */
  label: string;
  /** Instructions first, then context shared by a run's requests (the last part is cached across them). */
  system: string[];
  prompt: string;
  /** JSON Schema. Every object needs additionalProperties: false and all of its properties required. */
  schema: Record<string, unknown>;
}

export interface LLM {
  /** Who answers, for people: "Claude". */
  label: string;
  /** The model id, e.g. "claude-opus-5". */
  model: string;
  json(req: JsonRequest): Promise<unknown>;
}

export const DEFAULT_MODEL = 'claude-opus-5';

/** Claude, with the key in ANTHROPIC_API_KEY and the model in STRATA_LLM_MODEL (default claude-opus-5); null without a key. */
export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): LLM | null {
  const key = unquote(env.ANTHROPIC_API_KEY);
  if (!key) return null;
  return anthropicLLM(key, env.STRATA_LLM_MODEL?.trim() || DEFAULT_MODEL);
}

/** Where to set a key, for messages that say a feature is unavailable. */
export const KEY_HINT = 'ANTHROPIC_API_KEY';

/**
 * Claude through the Anthropic API. Structured output, so every answer
 * parses against the request's schema; streamed, since answers can be long.
 * Opts into server-side fallbacks, so a declined request is retried on
 * another model; if the key's organisation can't use them, it asks again
 * without.
 */
export function anthropicLLM(apiKey: string, model: string): LLM {
  const client = new Anthropic({ apiKey, maxRetries: 3 });
  let fallbacks = true;
  return {
    label: 'Claude',
    model,
    async json({ label, system, prompt, schema }) {
      const params = {
        model,
        max_tokens: 64000,
        thinking: { type: 'adaptive' as const },
        system: system.map((text, i) => ({ type: 'text' as const, text, ...(i === system.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}) })),
        messages: [{ role: 'user' as const, content: prompt }],
        output_config: { format: { type: 'json_schema' as const, schema } },
      };
      let msg: Anthropic.Beta.BetaMessage | Anthropic.Message;
      try {
        msg = fallbacks
          ? await client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }).finalMessage()
          : await client.messages.stream(params).finalMessage();
      } catch (err) {
        if (!fallbacks || !(err instanceof Anthropic.BadRequestError)) throw err;
        fallbacks = false;
        msg = await client.messages.stream(params).finalMessage();
      }
      if (msg.stop_reason === 'refusal') throw new Error(`Claude declined the ${label} request.`);
      if (msg.stop_reason === 'max_tokens') throw new Error(`Claude's answer to the ${label} request was cut off.`);
      const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      return JSON.parse(text);
    },
  };
}

/** A sentence for people about why a request failed. */
export function describeLLMError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return `The Anthropic API key was rejected. Check ${KEY_HINT} on the indexer.`;
  if (err instanceof Anthropic.PermissionDeniedError) return "The Anthropic API key can't use this model.";
  if (err instanceof Anthropic.RateLimitError) return 'The Anthropic API is rate limiting this key. Try again in a minute.';
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Anthropic API.";
  if (err instanceof Anthropic.APIError) return `The Anthropic API answered ${err.status ?? 'with an error'}: ${err.message}`.slice(0, 300);
  return ((err as Error)?.message ?? String(err)).slice(0, 300);
}
