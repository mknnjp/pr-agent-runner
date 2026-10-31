import type { LlmConfig } from '../src/chat/llm/config.ts';
import type { PrContext } from '../src/chat/mention.ts';
import { expect } from 'expect';
import { describe, test } from 'node:test';
import { answerChat, postChatReply } from '../src/chat/chat.ts';
import { makeFakeOctokit, createCaptures, toOctokit } from './helpers/fake-octokit.ts';
import { mockFetch } from './helpers/fetch-mock.ts';

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
  title: 'Test PR',
  body: 'Test description',
};

describe('postChatReply', () => {
  test('posts a comment with default label', async () => {
    const captures = createCaptures();
    const octokit = makeFakeOctokit([], captures);
    await postChatReply(toOctokit(octokit), { owner: 'o', repo: 'r' }, 1, 'hello');
    expect(captures.comments).toHaveLength(1);
    expect(captures.comments[0]?.body).toMatch(/@opencode-review reply:/);
    expect(captures.comments[0]?.body).toMatch(/hello/);
  });

  test('uses botMention parameter in label', async () => {
    const captures = createCaptures();
    const octokit = makeFakeOctokit([], captures);
    await postChatReply(toOctokit(octokit), { owner: 'o', repo: 'r' }, 1, 'reply', '@custom-bot');
    expect(captures.comments[0]?.body).toMatch(/@custom-bot reply:/);
  });

  test('replies in thread when commentId is provided', async () => {
    const captures = createCaptures();
    const octokit = makeFakeOctokit([], captures);
    await postChatReply(toOctokit(octokit), { owner: 'o', repo: 'r' }, 1, 'reply', '@custom-bot', 12345);
    expect(captures.comments[0]?.in_reply_to).toBe(12345);
  });

  test('omits in_reply_to when commentId is not provided', async () => {
    const captures = createCaptures();
    const octokit = makeFakeOctokit([], captures);
    await postChatReply(toOctokit(octokit), { owner: 'o', repo: 'r' }, 1, 'reply');
    expect(captures.comments[0]?.in_reply_to).toBeUndefined();
  });
});

describe('answerChat', () => {
  test('sends messages and returns the LLM response', async () => {
    const { calls, restore } = mockFetch([
      {
        status: 200,
        body: { choices: [{ message: { content: 'The code looks good.' } }] },
      },
    ]);
    try {
      const captures = createCaptures();
      const octokit = makeFakeOctokit([{ filename: 'src/a.ts', patch: '@@ -1 +1 @@\n-old\n+new' }], captures);
      const answer = await answerChat(
        toOctokit(octokit),
        fakeConfig,
        { owner: 'o', repo: 'r' },
        fakePr,
        'Is this correct?',
      );
      expect(answer).toBe('The code looks good.');
      expect(calls).toHaveLength(1);
      const body = JSON.parse(calls[0].init.body as string) as { messages: Array<{ role: string; content: string }> };
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0]?.role).toBe('system');
      expect(body.messages[1]?.content).toMatch(/Is this correct\?/);
    } finally {
      restore();
    }
  });

  test('sends Anthropic-format request for anthropic protocol', async () => {
    const anthropicConfig: LlmConfig = { ...fakeConfig, protocol: 'anthropic' };
    const { calls, restore } = mockFetch([
      {
        status: 200,
        body: { content: [{ type: 'text', text: 'Looks fine.' }] },
      },
    ]);
    try {
      const captures = createCaptures();
      const octokit = makeFakeOctokit([{ filename: 'src/a.ts', patch: '@@ -1 +1 @@\n-old\n+new' }], captures);
      const answer = await answerChat(
        toOctokit(octokit),
        anthropicConfig,
        { owner: 'o', repo: 'r' },
        fakePr,
        'check auth',
      );
      expect(answer).toBe('Looks fine.');
      const body = JSON.parse(calls[0].init.body as string) as { system: string; messages: Array<{ role: string }> };
      expect(body.system).toMatch(/code review assistant/);
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]?.role).toBe('user');
    } finally {
      restore();
    }
  });
});
