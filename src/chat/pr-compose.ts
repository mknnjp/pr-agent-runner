import type { Octokit } from '@octokit/rest';
import type { RepoRef } from '../types/cli.ts';
import type { LlmConfig } from './llm/config.ts';
import type { PrContext } from './mention.ts';
import { z } from 'zod';
import { chat } from './llm/client.ts';
import { buildPrChatMessages } from './prompt-context.ts';

const SYSTEM_PROMPT = `You are a code review assistant operating on Pull Requests.
You compose a concise, informative Pull Request title and description from the PR diff and metadata.

Rules:
- The title must be a single short sentence (<= 70 chars) summarizing the change.
- The body must be Markdown. Include: a brief summary, notable changes, and any follow-up/risk if evident from the diff.
- Do NOT invent requirements, ticket IDs, or context not present in the diff.
- Respond ONLY with a JSON object of the form:
{"title": "...", "body": "..."}
No prose, no code fences around the JSON.`;

const buildMessages = async (
  octokit: Octokit,
  repo: RepoRef,
  pr: PrContext,
): Promise<Array<{ role: 'system' | 'user' | 'assistant'; content: string }>> => {
  return buildPrChatMessages(
    octokit,
    repo,
    pr,
    SYSTEM_PROMPT,
    'Compose an improved title and description for this PR. Respond with JSON only.',
  );
};

const composedPrSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
});

type ComposedPr = z.infer<typeof composedPrSchema>;

export const parseComposed = (raw: string): ComposedPr | null => {
  const text = raw.trim();
  // Remove code fences if present
  const jsonText = text
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    const result = composedPrSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
};

export const composePrTitleBody = async (
  octokit: Octokit,
  config: LlmConfig,
  repo: RepoRef,
  pr: PrContext,
): Promise<ComposedPr | null> => {
  const messages = await buildMessages(octokit, repo, pr);
  const raw = await chat(config, messages);
  const composed = parseComposed(raw);
  if (composed === null) return null;

  await octokit.rest.pulls.update({
    ...repo,
    pull_number: pr.prNumber,
    title: composed.title,
    body: composed.body,
  });

  return composed;
};
