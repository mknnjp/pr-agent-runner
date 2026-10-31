import type { ChatMessage, LlmConfig } from '../src/chat/llm/config.ts';
import { expect } from 'expect';
import { describe, test } from 'node:test';
import { chat, retryWithBackoff } from '../src/chat/llm/client.ts';
import { resolveLlmConfig } from '../src/chat/llm/config.ts';
import { withFetch } from './helpers/fetch-mock.ts';

describe('resolveLlmConfig', () => {
  const errorCases: ReadonlyArray<[string, Record<string, string>, RegExp]> = [
    ['throws when OCR_LLM_URL is missing', { OCR_LLM_TOKEN: 't', OCR_LLM_MODEL: 'm' }, /OCR_LLM_URL/],
    ['throws when OCR_LLM_TOKEN is missing', { OCR_LLM_URL: 'https://x', OCR_LLM_MODEL: 'm' }, /OCR_LLM_TOKEN/],
    ['throws when OCR_LLM_MODEL is missing', { OCR_LLM_URL: 'https://x', OCR_LLM_TOKEN: 't' }, /OCR_LLM_MODEL/],
  ];

  for (const [name, env, re] of errorCases) {
    test(name, () => {
      const prev = { ...process.env };
      process.env = { ...env } as NodeJS.ProcessEnv;
      expect(() => resolveLlmConfig()).toThrow(re);
      process.env = prev;
    });
  }

  const protocolCases: ReadonlyArray<[string, Record<string, string>, string]> = [
    [
      'respects OCR_LLM_PROTOCOL=anthropic',
      {
        OCR_LLM_URL: 'https://api.anthropic.com/v1/messages',
        OCR_LLM_TOKEN: 't',
        OCR_LLM_MODEL: 'claude-sonnet-4-6',
        OCR_LLM_PROTOCOL: 'anthropic',
      },
      'anthropic',
    ],
    [
      'respects OCR_USE_ANTHROPIC=true',
      {
        OCR_LLM_URL: 'https://api.anthropic.com/v1/messages',
        OCR_LLM_TOKEN: 't',
        OCR_LLM_MODEL: 'claude-sonnet-4-6',
        OCR_USE_ANTHROPIC: 'true',
      },
      'anthropic',
    ],
    [
      'infers anthropic from /v1/messages URL',
      {
        OCR_LLM_URL: 'https://api.anthropic.com/v1/messages',
        OCR_LLM_TOKEN: 't',
        OCR_LLM_MODEL: 'claude-sonnet-4-6',
      },
      'anthropic',
    ],
    [
      'defaults to openai',
      {
        OCR_LLM_URL: 'https://api.openai.com/v1/chat/completions',
        OCR_LLM_TOKEN: 't',
        OCR_LLM_MODEL: 'gpt-4o',
      },
      'openai',
    ],
  ];

  for (const [name, env, protocol] of protocolCases) {
    test(name, () => {
      const prev = { ...process.env };
      process.env = { ...env } as NodeJS.ProcessEnv;
      expect(resolveLlmConfig().protocol).toBe(protocol);
      process.env = prev;
    });
  }
});

describe('chat', () => {
  const openaiConfig: LlmConfig = {
    url: 'https://api.openai.com/v1/chat/completions',
    token: 't',
    model: 'gpt-4o',
    protocol: 'openai',
    maxTokens: 2048,
  };
  const anthropicConfig: LlmConfig = {
    url: 'https://api.anthropic.com/v1/messages',
    token: 't',
    model: 'claude-sonnet-4-6',
    protocol: 'anthropic',
    maxTokens: 2048,
  };
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello' },
  ];

  test('returns text from OpenAI response', async () => {
    await withFetch([{ status: 200, body: { choices: [{ message: { content: 'Hi there!' } }] } }], async () => {
      const result = await chat(openaiConfig, messages);
      expect(result).toBe('Hi there!');
    });
  });

  test('returns text from Anthropic response', async () => {
    await withFetch([{ status: 200, body: { content: [{ type: 'text', text: 'Hello!' }] } }], async () => {
      const result = await chat(anthropicConfig, messages);
      expect(result).toBe('Hello!');
    });
  });

  test('throws on OpenAI non-ok response', async () => {
    await withFetch([{ status: 401, ok: false, body: { error: 'unauthorized' } }], async () => {
      await expect(chat(openaiConfig, messages)).rejects.toThrow(/LLM API failed for gpt-4o at[\s\S]*Status: 401/);
    });
  });

  test('throws on Anthropic non-ok response', async () => {
    await withFetch([{ status: 500, ok: false, body: { error: 'server error' } }], async () => {
      await expect(chat(anthropicConfig, messages)).rejects.toThrow(
        /LLM API failed for claude-sonnet-4-6 at[\s\S]*Status: 500/,
      );
    });
  });

  test('throws when OpenAI returns empty choices', async () => {
    await withFetch([{ status: 200, body: { choices: [] } }], async () => {
      await expect(chat(openaiConfig, messages)).rejects.toThrow(/no content/);
    });
  });

  test('throws when Anthropic returns no text content', async () => {
    await withFetch([{ status: 200, body: { content: [] } }], async () => {
      await expect(chat(anthropicConfig, messages)).rejects.toThrow(/no text content/);
    });
  });

  test('includes the response body in the error message', async () => {
    await withFetch([{ status: 401, ok: false, body: { error: 'unauthorized' } }], async () => {
      await expect(chat(openaiConfig, messages)).rejects.toThrow(/Response body:[\s\S]*unauthorized/);
    });
  });

  test('retries on 429 and succeeds on the next attempt', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await withFetch(
      [
        { status: 429, ok: false, body: { error: 'rate limit' } },
        { status: 200, body: { choices: [{ message: { content: 'ok after retry' } }] } },
      ],
      async (calls) => {
        const promise = chat(openaiConfig, messages);
        // Let the first fetch settle and the backoff timer be scheduled, then advance it.
        await new Promise((resolve) => setImmediate(resolve));
        t.mock.timers.tick(1000);
        await new Promise((resolve) => setImmediate(resolve));
        const result = await promise;
        expect(result).toBe('ok after retry');
        expect(calls).toHaveLength(2);
      },
    );
  });
});

describe('retryWithBackoff', () => {
  test('does not retry non-retryable errors', async () => {
    let attempts = 0;
    await expect(
      retryWithBackoff(
        async () => {
          attempts += 1;
          throw new Error('boom');
        },
        3,
        (e) => (e as { status?: number }).status === 429,
      ),
    ).rejects.toThrow(/boom/);
    expect(attempts).toBe(1);
  });

  test('gives up after exhausting retries', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let attempts = 0;
    const promise = retryWithBackoff(
      async () => {
        attempts += 1;
        throw Object.assign(new Error('rate limited'), { status: 429 });
      },
      3,
      (e) => (e as { status?: number }).status === 429,
    ).catch((error: unknown) => error as Error);
    // Backoff delays are 1s, 2s, 4s, 8s; advance each timer once scheduled.
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1000);
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(2000);
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(4000);
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(8000);
    await new Promise((resolve) => setImmediate(resolve));
    const err = await promise;
    expect(attempts).toBe(4);
    expect(err.message).toMatch(/rate limited/);
  });
});
