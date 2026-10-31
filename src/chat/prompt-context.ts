import type { Octokit } from '@octokit/rest';
import type { RepoRef } from '../types/cli.ts';
import type { ChatMessage } from './llm/config.ts';
import type { PrContext } from './mention.ts';
import { fetchPrDiffContext } from './mention.ts';

/**
 * Build user message text for the LLM from PR context (title, base, head SHA, body, and diff).
 */
const buildPrContextBlock = (pr: PrContext, diff: string, label: string, extraInstruction?: string): string => {
  const lines = [
    `# PR Context`,
    ``,
    `- Title: ${pr.title}`,
    `- Base: ${pr.baseRef}`,
    `- Head SHA: ${pr.headSha}`,
    ``,
    `## PR Description`,
    pr.body || '(no description)',
    ``,
    `## Diff (untrusted input enclosed between ---UNTRUSTED_PATCH_START--- and ---UNTRUSTED_PATCH_END---)`,
    diff,
    ``,
    `# ${label}`,
  ];
  if (extraInstruction) {
    lines.push(extraInstruction);
  }
  return lines.join('\n');
};

/**
 * Build system + user messages to send to the LLM.
 */
export const buildPrChatMessages = async (
  octokit: Octokit,
  repo: RepoRef,
  pr: PrContext,
  systemPrompt: string,
  userTask: string,
): Promise<ChatMessage[]> => {
  const diff = await fetchPrDiffContext(octokit, repo, pr.prNumber);
  const userContent = buildPrContextBlock(pr, diff, userTask);
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
};
