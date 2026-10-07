// The indexer's one way to ask a language model something, so features that
// need one (sorting a project's leftovers, summaries) share the key, the
// model and the error messages. Two providers: Claude through the Anthropic
// API, with the key in ANTHROPIC_API_KEY, and OpenAI, with the key in
// OPENAI_API_KEY. Without either key, llmFromEnv() is null and each
// feature says it is unavailable rather than failing.

import Anthropic from '@anthropic-ai/sdk';
import { request as httpsRequest } from 'node:https';
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
  /** Who answers, for people: "OpenAI" or "Claude". */
  label: string;
  /** The model id, e.g. "claude-haiku-5-5" or "gpt-5.5". */
  model: string;
  json(req: JsonRequest): Promise<unknown>;
}

/** Claude's default model, for sorting and summaries alike. */
export const DEFAULT_MODEL = 'claude-haiku-5-5';
/** OpenAI's default model, then the ones to try when a key can't use it. */
export const DEFAULT_OPENAI_MODELS = ['gpt-5.5', 'gpt-5', 'gpt-4.1'];
/**
 * OpenAI's default for summaries: short lines, many of them, written on
 * every import, where a smaller model does as well for far less.
 */
export const SUMMARY_OPENAI_MODELS = ['gpt-5-mini', ...DEFAULT_OPENAI_MODELS];

const providerOf = (model: string) => (/^claude/i.test(model) ? 'anthropic' : /^(gpt|chatgpt|o\d)/i.test(model) ? 'openai' : undefined);

/**
 * Claude when ANTHROPIC_API_KEY is set, else OpenAI when OPENAI_API_KEY is;
 * null without either. FIADA_LLM_MODEL picks the model that sorts, and an
 * OpenAI model there picks OpenAI when both keys are set. Summaries use
 * FIADA_SUMMARY_MODEL, else a smaller OpenAI model (Claude keeps its
 * default), on the provider FIADA_LLM_MODEL picked. A model of the other
 * provider's is ignored, so a leftover FIADA_LLM_MODEL=gpt-… doesn't break
 * an Anthropic key.
 */
export function llmFromEnv(env: NodeJS.ProcessEnv = process.env, use: 'sort' | 'summaries' = 'sort'): LLM | null {
  const openai = unquote(env.OPENAI_API_KEY);
  const anthropic = unquote(env.ANTHROPIC_API_KEY);
  const own = (use === 'summaries' && env.FIADA_SUMMARY_MODEL?.trim()) || undefined;
  const model = own ?? (env.FIADA_LLM_MODEL?.trim() || undefined);
  const wants = model && providerOf(model);
  if (anthropic && !(wants === 'openai' && openai)) return anthropicLLM(anthropic, (wants !== 'openai' && model) || DEFAULT_MODEL);
  if (openai) {
    if (use === 'summaries' && !own) return openaiLLM(openai, SUMMARY_OPENAI_MODELS);
    return openaiLLM(openai, wants === 'anthropic' ? undefined : model);
  }
  return null;
}

/** Where to set a key, for messages that say a feature is unavailable. */
export const KEY_HINT = 'ANTHROPIC_API_KEY or OPENAI_API_KEY';

/**
 * Claude through the Anthropic API. Structured output, so every answer
 * parses against the request's schema; streamed, since answers can be long.
 * Opts into server-side fallbacks, so a declined request is retried on
 * another model; if the key's organisation can't use them, it asks again
 * without. Haiku has none to opt into. `fetch` is for tests.
 */
export function anthropicLLM(apiKey: string, model: string, opts: { fetch?: typeof fetch } = {}): LLM {
  const client = new Anthropic({ apiKey, maxRetries: 3, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  let fallbacks = !/haiku/i.test(model);
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

// ── OpenAI ─────────────────────────────────────────────────────────────

/** A failed OpenAI request: `status` is unset when the API couldn't be reached. */
export class OpenAIError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** OpenAI's error code, e.g. "model_not_found" or "insufficient_quota". */
    readonly code?: string,
    readonly model?: string,
  ) {
    super(message);
    this.name = 'OpenAIError';
  }
}

/** One HTTP POST: status, headers (lower-cased) and body text. Rejects only when the server can't be reached. */
export type Post = (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; headers: Record<string, string | undefined>; body: string }>;

/**
 * POST over node:https rather than fetch: fetch gives up after five minutes
 * without response headers, and a long batch can take a reasoning model
 * longer than that to answer. Ours gives up after `timeoutMs`.
 */
export const httpsPost =
  (timeoutMs = 15 * 60_000): Post =>
  (url, headers, body) =>
    new Promise((resolve, reject) => {
      const req = httpsRequest(url, { method: 'POST', headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          clearTimeout(timer);
          const h = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v]));
          resolve({ status: res.statusCode ?? 0, headers: h, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', fail);
      });
      const timer = setTimeout(() => req.destroy(new Error(`no answer in ${Math.round(timeoutMs / 60_000)} minutes`)), timeoutMs);
      function fail(err: Error) {
        clearTimeout(timer);
        reject(err);
      }
      req.on('error', fail);
      req.end(body);
    });

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries the way the Anthropic SDK does: timeouts, conflicts, rate limits and server errors, three more times. */
const retryable = (status: number, code?: string) => status === 408 || status === 409 || (status === 429 && code !== 'insufficient_quota') || status >= 500;
function retryDelay(attempt: number, headers: Record<string, string | undefined>): number {
  const ms = Number(headers['retry-after-ms']);
  if (ms >= 0 && ms < 60_000) return ms;
  const s = Number(headers['retry-after']);
  if (s >= 0 && s < 60) return s * 1000;
  return Math.min(500 * 2 ** attempt, 8000) * (1 - Math.random() * 0.25);
}

interface ChatCompletion {
  choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
  error?: { message?: string; code?: string | null; type?: string };
}

/**
 * OpenAI through the Chat Completions API, with plain HTTPS rather than the
 * SDK. Structured output in strict mode, so every answer parses against the
 * request's schema. Without a `model`, it starts with the newest default
 * and moves down DEFAULT_OPENAI_MODELS when the key can't use one; given a
 * list, it moves down that. `post` and `retryDelayMs` are for tests.
 */
export function openaiLLM(apiKey: string, model?: string | string[], opts: { post?: Post; retries?: number; retryDelayMs?: number; log?: (line: string) => void } = {}): LLM {
  const post = opts.post ?? httpsPost();
  const retries = opts.retries ?? 3;
  const log = opts.log ?? ((l: string) => console.log(l));
  const candidates = Array.isArray(model) ? model : model ? [model] : DEFAULT_OPENAI_MODELS;
  let current = 0;

  async function once(model: string, body: string): Promise<ChatCompletion> {
    for (let attempt = 0; ; attempt++) {
      let res: Awaited<ReturnType<Post>>;
      try {
        res = await post(OPENAI_URL, { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body);
      } catch (err) {
        if (attempt < retries) {
          await sleep(opts.retryDelayMs ?? retryDelay(attempt, {}));
          continue;
        }
        throw new OpenAIError(`Couldn't reach the OpenAI API: ${(err as Error).message}`, undefined, undefined, model);
      }
      let data: ChatCompletion = {};
      try {
        data = JSON.parse(res.body);
      } catch {
        // An error page from a proxy; the status says enough.
      }
      if (res.status >= 200 && res.status < 300) return data;
      const code = data.error?.code ?? undefined;
      if (attempt < retries && retryable(res.status, code)) {
        await sleep(opts.retryDelayMs ?? retryDelay(attempt, res.headers));
        continue;
      }
      throw new OpenAIError(data.error?.message || res.body.slice(0, 200) || `HTTP ${res.status}`, res.status, code, model);
    }
  }

  const llm: LLM = {
    label: 'OpenAI',
    get model() {
      return candidates[current];
    },
    async json({ label, system, prompt, schema }) {
      for (;;) {
        const tried = current;
        const model = candidates[tried];
        const body = JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system.join('\n\n') },
            { role: 'user', content: prompt },
          ],
          response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } },
        });
        let data: ChatCompletion;
        try {
          data = await once(model, body);
        } catch (err) {
          const missing = err instanceof OpenAIError && (err.code === 'model_not_found' || err.status === 404);
          if (!missing || tried + 1 >= candidates.length) throw err;
          // Requests in flight together can all miss; the first to come back moves everyone on.
          if (current === tried) {
            current = tried + 1;
            log(`[fiada] OpenAI has no ${model} for this key; using ${candidates[current]}`);
          }
          continue;
        }
        const choice = data.choices?.[0];
        if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') throw new Error(`OpenAI declined the ${label} request.`);
        if (choice?.finish_reason === 'length') throw new Error(`OpenAI's answer to the ${label} request was cut off.`);
        const text = choice?.message?.content;
        if (!text) throw new Error(`OpenAI sent an empty answer to the ${label} request.`);
        return JSON.parse(text);
      }
    },
  };
  return llm;
}

/**
 * One model shared by many accounts, each allowed `perDay` requests a UTC
 * day, so one person's imports can't spend everyone's key. Past the limit a
 * request fails at once, without reaching the provider, and features fall
 * back as they do without a key's answer.
 */
export class LLMBudget {
  private used = new Map<string, { day: string; n: number }>();

  constructor(
    readonly perDay: number,
    private now: () => number = Date.now,
  ) {}

  /** `llm` as `key` may use it. */
  for(key: string, llm: LLM): LLM {
    const take = () => {
      const day = new Date(this.now()).toISOString().slice(0, 10);
      const u = this.used.get(key);
      const n = u?.day === day ? u.n : 0;
      if (n >= this.perDay) throw new Error(`This map has used its ${this.perDay} model requests for today. Summaries and sorting pick up again tomorrow (UTC).`);
      this.used.set(key, { day, n: n + 1 });
    };
    return {
      get label() {
        return llm.label;
      },
      get model() {
        return llm.model;
      },
      async json(req) {
        take();
        return llm.json(req);
      },
    };
  }
}

/** A sentence for people about why a request failed. */
export function describeLLMError(err: unknown): string {
  if (err instanceof OpenAIError) {
    if (err.status === undefined) return "Couldn't reach the OpenAI API.";
    if (err.status === 401) return 'The OpenAI API key was rejected. Check OPENAI_API_KEY on the indexer.';
    if (err.code === 'model_not_found' || err.status === 404) return `The OpenAI API key can't use ${err.model ?? 'this model'}. Set FIADA_LLM_MODEL (or FIADA_SUMMARY_MODEL, for summaries) to a model it has.`;
    if (err.code === 'insufficient_quota') return "The OpenAI API key's account is out of credit. Add some under Billing on platform.openai.com.";
    if (err.status === 403) return `The OpenAI API refused this key: ${err.message}`.slice(0, 300);
    if (err.status === 429) return 'The OpenAI API is rate limiting this key. Try again in a minute.';
    return `The OpenAI API answered ${err.status}: ${err.message}`.slice(0, 300);
  }
  if (err instanceof Anthropic.AuthenticationError) return 'The Anthropic API key was rejected. Check ANTHROPIC_API_KEY on the indexer.';
  if (err instanceof Anthropic.PermissionDeniedError) return "The Anthropic API key can't use this model.";
  if (err instanceof Anthropic.RateLimitError) return 'The Anthropic API is rate limiting this key. Try again in a minute.';
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Anthropic API.";
  if (err instanceof Anthropic.APIError) return `The Anthropic API answered ${err.status ?? 'with an error'}: ${err.message}`.slice(0, 300);
  return ((err as Error)?.message ?? String(err)).slice(0, 300);
}
