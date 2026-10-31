import { getOcrLlmProtocol, getOcrLlmUrl, getOcrLlmToken, getOcrLlmModel, getOcrUseAnthropic, getOcrMaxTokens } from '../env.ts';

export interface LlmConfig {
  readonly url: string;
  readonly token: string;
  readonly model: string;
  readonly protocol: 'anthropic' | 'openai';
  readonly maxTokens: number;
}

const resolveProtocol = (): LlmConfig['protocol'] => {
  const explicit = getOcrLlmProtocol();
  if (explicit === 'anthropic') return 'anthropic';
  if (explicit === 'openai') return 'openai';
  if (getOcrUseAnthropic() === 'true') return 'anthropic';
  const url = getOcrLlmUrl();
  if (typeof url === 'string' && url.includes('/v1/messages')) return 'anthropic';
  return 'openai';
};

const parseMaxTokens = (): number => {
  const value = getOcrMaxTokens();
  if (typeof value !== 'string') return DEFAULT_MAX_TOKENS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_MAX_TOKENS;
  return parsed;
};

export const resolveLlmConfig = (): LlmConfig => {
  const url = getOcrLlmUrl();
  const token = getOcrLlmToken();
  const model = getOcrLlmModel();
  if (!url) throw new Error('OCR_LLM_URL is required for chat mode');
  if (!token) throw new Error('OCR_LLM_TOKEN is required for chat mode');
  if (!model) throw new Error('OCR_LLM_MODEL is required for chat mode');
  return { url, token, model, protocol: resolveProtocol(), maxTokens: parseMaxTokens() };
};

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

const DEFAULT_MAX_TOKENS = 2048;
const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
}

interface OpenAiResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

// Error detection functions
const isRateLimitError = (error: unknown): boolean => {
  const err = error as { status?: number; message?: string };
  return err.status === 429 || (err.message?.includes('rate limit') ?? false);
};

// Retry logic with exponential backoff
export const retryWithBackoff = async <T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  isRetryableError?: (error: unknown) => boolean,
): Promise<T> => {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (!isRetryableError?.(error)) break;

      const delay = Math.min(1000 * 2 ** attempt, 30000);
      console.error(`Attempt ${attempt + 1}/${maxRetries} failed. Retrying in ${delay}ms...`);

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error('Unknown error');
};

// Improved error messages
const createLlmError = (url: string, model: string, status?: number, responseBody?: string): Error => {
  const detail =
    typeof responseBody === 'string' && responseBody.trim() !== ''
      ? `\nResponse body: ${responseBody.slice(0, 500)}`
      : '';
  return new Error(
    `LLM API failed for ${model} at ${url}\n` +
      `Status: ${status || 'unknown'}\n` +
      `Please check your OCR_LLM_URL and OCR_LLM_TOKEN environment variables.${detail}`,
  );
};

const postLlmRequest = async (
  url: string,
  headers: Record<string, string>,
  body: unknown,
  model: string,
): Promise<unknown> => {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const responseBody = await res.text();
    throw createLlmError(url, model, res.status, responseBody);
  }
  return res.json();
};

const extractAnthropicText = (data: unknown): string => {
  const response = data as AnthropicResponse;
  const text = response.content?.find((c) => c.type === 'text')?.text;
  if (!text) throw new Error('Anthropic API returned no text content');
  return text;
};

const extractOpenAiText = (data: unknown): string => {
  const response = data as OpenAiResponse;
  const text = response.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI API returned no content');
  return text;
};

const callAnthropic = async (config: LlmConfig, messages: readonly ChatMessage[]): Promise<string> => {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const dialog = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  const data = await postLlmRequest(
    config.url,
    {
      'content-type': 'application/json',
      'x-api-key': config.token,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    {
      model: config.model,
      max_tokens: config.maxTokens,
      system,
      messages: dialog,
    },
    config.model,
  );

  return extractAnthropicText(data);
};

const callOpenAi = async (config: LlmConfig, messages: readonly ChatMessage[]): Promise<string> => {
  const data = await postLlmRequest(
    config.url,
    {
      'content-type': 'application/json',
      authorization: `Bearer ${config.token}`,
    },
    {
      model: config.model,
      max_tokens: config.maxTokens,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    },
    config.model,
  );

  return extractOpenAiText(data);
};

// chat function with retry logic
export const chat = async (config: LlmConfig, messages: readonly ChatMessage[]): Promise<string> => {
  return retryWithBackoff(
    () => {
      if (config.protocol === 'anthropic') return callAnthropic(config, messages);
      return callOpenAi(config, messages);
    },
    3,
    isRateLimitError,
  );
};
