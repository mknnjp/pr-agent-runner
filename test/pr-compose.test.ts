import type { LlmConfig } from '../src/chat/llm/config.ts';
import type { PrContext } from '../src/chat/mention.ts';
import { expect } from 'expect';
import { describe, test } from 'node:test';
import { composePrTitleBody, parseComposed } from '../src/chat/pr-compose.ts';
import { makeFakeOctokit, createCaptures, toOctokit } from './helpers/fake-octokit.ts';
import { mockFetch } from './helpers/fetch-mock.ts';

describe('parseComposed', () => {
  const composedCases: ReadonlyArray<[string, string, string | null, string | null]> = [
    ['parses a plain JSON object', '{"title":"Add login","body":"## Summary\\nfoo"}', 'Add login', '## Summary\nfoo'],
    ['strips code fences', '```json\n{"title":"x","body":"y"}\n```', 'x', 'y'],
    ['returns null when JSON is invalid', 'not json at all', null, null],
    ['returns null when fields are missing', '{"title":"only title"}', null, null],
    ['returns null when types are wrong', '{"title":123,"body":true}', null, null],
  ];

  for (const [name, input, title, body] of composedCases) {
    test(name, () => {
      const result = parseComposed(input);
      if (title === null) {
        expect(result).toBeNull();
      } else {
        expect(result?.title).toBe(title);
        expect(result?.body).toBe(body);
      }
    });
  }
});

describe('composePrTitleBody', () => {
  const fakeConfig: LlmConfig = {
    url: 'https://api.openai.com/v1/chat/completions',
    token: 'test-token',
    model: 'gpt-4o',
    protocol: 'openai',
    maxTokens: 2048,
  };

  const fakePr: PrContext = {
    owner: 'test-owner',
    repo: 'test-repo',
    prNumber: 42,
    headSha: 'abc123',
    baseRef: 'main',
    title: 'Old Title',
    body: 'Old description',
  };

  test('composes and updates PR', async () => {
    const { restore } = mockFetch([
      {
        status: 200,
        body: { choices: [{ message: { content: '{"title":"New Title","body":"New body"}' } }] },
      },
    ]);
    try {
      const captures = createCaptures();
      const octokit = makeFakeOctokit([{ filename: 'src/a.ts', patch: '@@ -1 +1 @@\n-old\n+new' }], captures);
      const result = await composePrTitleBody(toOctokit(octokit), fakeConfig, { owner: 'o', repo: 'r' }, fakePr);
      expect(result?.title).toBe('New Title');
      expect(result?.body).toBe('New body');
      expect(captures.prUpdates).toHaveLength(1);
      expect(captures.prUpdates[0]?.title).toBe('New Title');
    } finally {
      restore();
    }
  });

  test('returns null when LLM returns invalid JSON', async () => {
    const { restore } = mockFetch([
      {
        status: 200,
        body: { choices: [{ message: { content: 'not valid json' } }] },
      },
    ]);
    try {
      const captures = createCaptures();
      const octokit = makeFakeOctokit([], captures);
      const result = await composePrTitleBody(toOctokit(octokit), fakeConfig, { owner: 'o', repo: 'r' }, fakePr);
      expect(result).toBeNull();
      expect(captures.prUpdates).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test('strips code fences from LLM response', async () => {
    const { restore } = mockFetch([
      {
        status: 200,
        body: { choices: [{ message: { content: '```json\n{"title":"Fenced","body":"Content"}\n```' } }] },
      },
    ]);
    try {
      const captures = createCaptures();
      const octokit = makeFakeOctokit([], captures);
      const result = await composePrTitleBody(toOctokit(octokit), fakeConfig, { owner: 'o', repo: 'r' }, fakePr);
      expect(result?.title).toBe('Fenced');
      expect(result?.body).toBe('Content');
    } finally {
      restore();
    }
  });
});
