import { Octokit } from '@octokit/rest';
import type { CliDeps, ChatCliConfig } from '../types.ts';
import { info as coreInfo } from '@actions/core';
import { answerChat, postChatReply } from '../chat/chat.ts';
import { applyFixes, extractFixTargets } from '../chat/fix.ts';
import { resolveLlmConfig } from '../chat/llm.ts';
import { fetchPrContext, parseMention } from '../chat/mention.ts';
import { postReview } from '../output/github-review.ts';
import { parseReviewOptions } from '../config.ts';

interface OcrPrResult {
  readonly pr: Awaited<ReturnType<typeof fetchPrContext>>;
  readonly findings: Awaited<ReturnType<typeof import('../input/loader.ts').loadFindings>>;
}

/** Run OCR against the PR diff and load the resulting findings.
 * Shared by the review re-run and auto-fix mention flows. */
const runOcrForPr = async (
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  deps: CliDeps = {},
): Promise<OcrPrResult> => {
  const { runOcrReview } = await import('../commands/review.ts');
  const pr = await fetchPrContext(octokit, { owner, repo }, prNumber);
  const resultPath = await runOcrReview({ baseRef: pr.baseRef, headSha: pr.headSha }, deps);
  const { loadFindings } = await import('../input/loader.ts');
  return { pr, findings: await loadFindings(resultPath) };
};

/** Execute the mention command: parse the mention and dispatch to review/fix/chat. */
export const runMention = async (config: ChatCliConfig, deps: CliDeps = {}): Promise<void> => {
  const { info = coreInfo } = deps;
  const payload = parseMention(config.commentBody, config.botMention);
  if (payload === null) {
    info('No mention found. Skipping.');
    return;
  }

  const octokitFactory = deps.octokitFactory ?? ((token: string): Octokit => new Octokit({ auth: token }));
  const octokit = octokitFactory(config.token);
  const owner = config.owner;
  const repo = config.repo;

  if (payload.mode === 'review') {
    info('Mention requested review re-run');
    const { findings } = await runOcrForPr(octokit, owner, repo, config.prNumber, deps);
    await postReview(octokit, { owner, repo }, config.prNumber, findings, parseReviewOptions(process.env));
    info('Review re-run done');
    return;
  }

  if (payload.mode === 'fix') {
    info('Mention requested auto-fix');
    const { pr, findings } = await runOcrForPr(octokit, owner, repo, config.prNumber, deps);
    const targets = extractFixTargets(findings);
    info(`Extracted ${targets.length} fixable targets (critical/high with suggestion)`);
    const result = await applyFixes(octokit, { owner, repo }, config.prNumber, targets, pr.headSha, pr.baseRef, config.botMention);
    if (result.changedFiles > 0 && result.prUrl) {
      await postChatReply(
        octokit,
        { owner, repo },
        config.prNumber,
        `Created fix PR: ${result.prUrl}\n\nFiles modified: ${result.changedFiles}`,
        config.botMention,
        config.commentId,
      );
    } else {
      await postChatReply(
        octokit,
        { owner, repo },
        config.prNumber,
        'No fixable findings (critical/high with suggestions) were found.',
        config.botMention,
        config.commentId,
      );
    }
    info('Auto-fix done');
    return;
  }

  info(`Chat question: ${payload.question}`);
  const llmConfig = resolveLlmConfig(process.env);
  const pr = await fetchPrContext(octokit, { owner, repo }, config.prNumber);
  const answer = await answerChat(octokit, llmConfig, { owner, repo }, pr, payload.question);
  await postChatReply(octokit, { owner, repo }, config.prNumber, answer, config.botMention, config.commentId);
  info('Chat reply posted');
};
