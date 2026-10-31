import { getOcrLlmProtocol, getOcrLlmUrl, getOcrLlmToken, getOcrLlmModel, getOcrUseAnthropic, getOcrMaxTokens } from '../../config/env.ts';

export interface LlmConfig {
  readonly url: string;
  readonly token: string;
  readonly model: string;
  readonly protocol: 'anthropic' | 'openai';
  readonly maxTokens: number;
}

const DEFAULT_MAX_TOKENS = 2048;

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
