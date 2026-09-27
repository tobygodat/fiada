// The smallest client summaries need: one request, a JSON schema, parsed JSON
// back, from whichever provider has a key (OpenAI first when both are set).
// Provider-neutral on purpose so it can fold into the shared client the
// sorting work adds; tests pass their own Llm instead.

import Anthropic from '@anthropic-ai/sdk';
import { unquote } from '../mongo-store.ts';

export interface JsonRequest {
  system: string;
  prompt: string;
  /** JSON Schema of the reply; strict, so every object lists `required` and sets `additionalProperties: false`. */
  schema: Record<string, unknown>;
  /** A short name for the schema, e.g. "summaries". */
  name: string;
  maxTokens?: number;
}

export interface Llm {
  provider: 'openai' | 'anthropic';
  model: string;
  json<T>(req: JsonRequest): Promise<T>;
}

export const DEFAULT_MODELS = { openai: 'gpt-5-mini', anthropic: 'claude-opus-5' } as const;

/** The reply was cut off or declined; the caller may split the batch and retry. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly reason: 'truncated' | 'refused' | 'invalid',
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** A client for the configured provider, or null when no key is set. STRATA_LLM_MODEL picks the model. */
export function createLlm(env: NodeJS.ProcessEnv = process.env): Llm | null {
  if (/^(off|0|false|no)$/i.test(env.STRATA_SUMMARIES ?? '')) return null;
  const openai = unquote(env.OPENAI_API_KEY);
  const anthropic = unquote(env.ANTHROPIC_API_KEY);
  const model = unquote(env.STRATA_LLM_MODEL) || undefined;
  if (openai) return openaiLlm(openai, model ?? DEFAULT_MODELS.openai);
  if (anthropic) return anthropicLlm(anthropic, model ?? DEFAULT_MODELS.anthropic);
  return null;
}

function parse<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new LlmError(`The model's reply wasn't JSON: ${text.slice(0, 120)}`, 'invalid');
  }
}

function anthropicLlm(apiKey: string, model: string): Llm {
  // An explicit base URL only; ANTHROPIC_BASE_URL may point at some other tool's proxy.
  const client = new Anthropic({ apiKey, baseURL: 'https://api.anthropic.com' });
  return {
    provider: 'anthropic',
    model,
    async json<T>(req: JsonRequest): Promise<T> {
      const res = await client.beta.messages.create({
        model,
        max_tokens: req.maxTokens ?? 8000,
        system: req.system,
        messages: [{ role: 'user', content: req.prompt }],
        // Summaries are short and plain: low effort keeps thinking brief.
        output_config: { effort: 'low', format: { type: 'json_schema', schema: req.schema } },
        // A batch the default model declines (security code can trip a classifier) is retried on a fallback model.
        ...(model === DEFAULT_MODELS.anthropic ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      });
      if (res.stop_reason === 'refusal') throw new LlmError('The model declined to summarise this batch.', 'refused');
      if (res.stop_reason === 'max_tokens') throw new LlmError('The reply ran past its token limit.', 'truncated');
      const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      return parse<T>(text);
    },
  };
}

function openaiLlm(apiKey: string, model: string): Llm {
  return {
    provider: 'openai',
    model,
    async json<T>(req: JsonRequest): Promise<T> {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.prompt },
          ],
          response_format: { type: 'json_schema', json_schema: { name: req.name, schema: req.schema, strict: true } },
          max_completion_tokens: req.maxTokens ?? 8000,
          reasoning_effort: 'low',
        }),
        signal: AbortSignal.timeout(180_000),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
        choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
      };
      if (!res.ok) throw new Error(`OpenAI answered ${res.status}: ${body.error?.message ?? res.statusText}`);
      const choice = body.choices?.[0];
      if (choice?.message?.refusal) throw new LlmError('The model declined to summarise this batch.', 'refused');
      if (choice?.finish_reason === 'length') throw new LlmError('The reply ran past its token limit.', 'truncated');
      return parse<T>(choice?.message?.content ?? '');
    },
  };
}
