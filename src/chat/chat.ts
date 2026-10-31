import type { Octokit } from '@octokit/rest';
import type { LlmConfig, ChatMessage } from './llm/config.ts';
import { chat } from './llm/client.ts';
import type { PrContext } from './mention.ts';
import { buildPrChatMessages } from './prompt-context.ts';
import type { RepoRef } from '../types/cli.ts';
import { getOcrLanguage } from '../config/env.ts';

const SYSTEM_PROMPT = `You are a code review assistant operating on Pull Requests.
You work in conjunction with OpenCodeReview (OCR), a code review tool, and answer questions by referencing the PR diff and metadata.

Rules:
- Respond in the same language as the question.
- Use Markdown fenced code blocks for code snippets.
- Wrap file paths and line numbers in backticks.
- Do not state facts based on speculation; answer "unknown" when unsure.
- Be concise and practical. Avoid verbose preambles.`;

const buildSystemPrompt = (): string => {
  const language = getOcrLanguage();
  if (language) {
    return `${SYSTEM_PROMPT}\n\nAdditional instruction: Always respond in ${language}.`;
  }
  return SYSTEM_PROMPT;
};

const buildMessages = async (
  octokit: Octokit,
  repo: RepoRef,
  pr: PrContext,
  question: string,
): Promise<ChatMessage[]> => {
  return buildPrChatMessages(octokit, repo, pr, buildSystemPrompt(), `Question\n${question}`);
};

export const answerChat = async (
  octokit: Octokit,
  config: LlmConfig,
  repo: RepoRef,
  pr: PrContext,
  question: string,
): Promise<string> => {
  const messages = await buildMessages(octokit, repo, pr, question);
  return chat(config, messages);
};

export const postChatReply = async (
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
  answer: string,
  botMention = '@opencode-review',
  commentId?: number,
): Promise<void> => {
  const language = getOcrLanguage();
  const label = language ? `${botMention} (${language})` : botMention;
  const body = `${label} reply:\n\n${answer}`;
  await octokit.rest.issues.createComment({
    ...repo,
    issue_number: prNumber,
    body,
    ...(commentId !== undefined ? { in_reply_to: commentId } : {}),
  });
};
