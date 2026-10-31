import type { Octokit, RestEndpointMethodTypes } from '@octokit/rest';
import type { RepoRef } from '../types/cli.ts';

type Files = RestEndpointMethodTypes['pulls']['listFiles']['response']['data'];
type PullData = RestEndpointMethodTypes['pulls']['get']['response']['data'];

export interface PrContext {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: PullData['number'];
  readonly headSha: PullData['head']['sha'];
  readonly baseRef: PullData['base']['ref'];
  readonly title: NonNullable<PullData['title']>;
  readonly body: NonNullable<PullData['body']>;
}

interface MentionPayload {
  readonly mode: 'review' | 'chat' | 'fix';
  readonly question: string;
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentionRegex = (mention: string): RegExp => new RegExp(`(?<![\\w])${escapeRegex(mention)}(?![\\w])`, 'g');
const stripMentions = (body: string, mention: string): string => body.replace(mentionRegex(mention), '').trim();

export const parseMention = (body: string, mention: string): MentionPayload | null => {
  const regex = mentionRegex(mention);
  if (!regex.test(body)) return null;
  const rest = stripMentions(body, mention);
  const firstToken = rest.split(/\s+/)[0] ?? '';
  const lower = firstToken.toLowerCase();
  if (lower === 'review' || lower === 'fix') {
    return { mode: lower, question: rest.slice(firstToken.length).trim() };
  }
  return { mode: 'chat', question: rest };
};

export const fetchPrContext = async (octokit: Octokit, repo: RepoRef, prNumber: number): Promise<PrContext> => {
  const { data } = await octokit.rest.pulls.get({ ...repo, pull_number: prNumber });
  return {
    owner: repo.owner,
    repo: repo.repo,
    prNumber,
    headSha: data.head.sha,
    baseRef: data.base.ref,
    title: data.title ?? '',
    body: data.body ?? '',
  };
};

const MAX_FILES = 30;
const MAX_PATCH_BYTES_PER_FILE = 24000;

export const fetchPrDiffContext = async (
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
  maxFiles = MAX_FILES,
  maxPatchBytes = MAX_PATCH_BYTES_PER_FILE,
): Promise<string> => {
  const files: Files = [];
  let page = 1;

  while (files.length < maxFiles) {
    const { data, headers } = await octokit.rest.pulls.listFiles({
      ...repo,
      pull_number: prNumber,
      per_page: maxFiles - files.length,
      page,
    });
    if (data.length === 0) break;
    files.push(...data);
    const link = headers.link;
    if (!link || !link.includes('rel="next"')) break;
    page++;
  }

  const lines: string[] = [`# PR #${prNumber} changed files (${files.length} total, showing up to ${maxFiles})`];
  let bytes = 0;
  const maxTotalBytes = maxPatchBytes * 2;
  for (const file of files.slice(0, maxFiles)) {
    const header = `\n## ${file.status} ${file.filename} (+${file.additions} -${file.deletions})\n`;
    const headerBytes = Buffer.byteLength(header);
    if (bytes + headerBytes > maxTotalBytes) break;
    bytes += headerBytes;
    lines.push(header);
    const patch = file.patch ?? '(no patch / binary)';
    const patchBytes = Buffer.byteLength(patch);
    const remaining = maxTotalBytes - bytes;
    if (patchBytes > remaining) {
      const truncated = Buffer.from(patch).subarray(0, remaining).toString() + '\n... (truncated)';
      bytes += Buffer.byteLength(truncated);
      lines.push('---UNTRUSTED_PATCH_START---', truncated, '---UNTRUSTED_PATCH_END---');
      break;
    }
    bytes += patchBytes;
    lines.push('---UNTRUSTED_PATCH_START---', patch, '---UNTRUSTED_PATCH_END---');
  }
  return lines.join('\n');
};
