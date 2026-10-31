import type { Octokit } from '@octokit/rest';
import type { Finding } from '../schemas/finding.ts';
import type { RepoRef } from '../types/cli.ts';
import type { ReviewStats } from '../types/github.ts';
import type { ReviewOptions } from '../types/review.ts';
import { filterFindings, applyIncrementalFilter } from './review-filter.ts';
import { sortAndBatchComments } from './review-batcher.ts';
import {
  listExistingReviewComments,
  findSummaryReview,
  postReviewBatch,
  updateReviewBody,
  createSummaryReview,
  toComment,
  buildSummaryBody,
} from './review-poster.ts';
import { resolveBatchSize } from '../domain/post-comments.ts';

const EMPTY_STATS: ReviewStats = { total: 0, inline: 0, skipped: 0, routed: 0, failed: 0 };

/**
 * Post review comments for a PR. Inline comments are batched into one or more
 * `createReview` calls; the summary lives in the review body. When `sticky`,
 * the review carrying the summary marker is updated in place across runs
 * (inline comments always go to fresh reviews, since GitHub does not allow
 * adding comments to an existing review).
 */
export const postReview = async (
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
  findings: readonly Finding[],
  options: ReviewOptions = {},
): Promise<ReviewStats> => {
  if (findings.length === 0) return EMPTY_STATS;

  const sticky = options.sticky !== false;
  const incremental = options.incremental === true;
  const threshold = 0.6; // DEFAULT_OVERLAP_THRESHOLD from domain/post-comments.ts

  const { data: pr } = await octokit.rest.pulls.get({
    owner: repo.owner,
    repo: repo.repo,
    pull_number: prNumber,
  });

  const reviewFiles = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: repo.owner,
    repo: repo.repo,
    pull_number: prNumber,
    per_page: 100,
  });

  const filterResult = filterFindings(findings, reviewFiles, options);

  const comments = filterResult.inlineComments.map(toComment);

  // Incremental filtering: drop inline comments whose (path, line range)
  // overlaps an existing bot review comment, or whose content matches one.
  // History is never deleted.
  let skipped = 0;
  let toSend: typeof comments = comments;
  if (incremental && toSend.length > 0) {
    const existing = await listExistingReviewComments(octokit, repo, prNumber);
    const result = applyIncrementalFilter(toSend, existing, options, threshold);
    toSend = result.toSend;
    skipped = result.skipped;
  }

  const batches = sortAndBatchComments(toSend, resolveBatchSize(options.batchSize));

  let summaryBody = buildSummaryBody(findings.length, filterResult.summaryEntries);
  if (toSend.length === 0 && skipped > 0) {
    summaryBody += '\n\n---\n\nℹ️ All inline comments overlapped with existing reviews; nothing new was posted.';
  }

  const existingSummary = sticky ? await findSummaryReview(octokit, repo, prNumber) : undefined;

  let inline = 0;
  let failed = 0;
  let summaryUrl: string | undefined;
  const postBatch = async (index: number, body: string | undefined): Promise<void> => {
    const url = await postReviewBatch(octokit, repo, prNumber, pr.head.sha, batches[index], body);
    if (url !== undefined) {
      inline += batches[index].length;
      if (index === 0) summaryUrl = url;
    } else {
      failed += batches[index].length;
    }
  };

  if (batches.length > 0) {
    const firstBody = existingSummary === undefined ? summaryBody : undefined;
    for (let i = 0; i < batches.length; i += 1) {
      await postBatch(i, i === 0 ? firstBody : undefined);
    }
    if (existingSummary !== undefined) {
      const url = await updateReviewBody(octokit, repo, prNumber, existingSummary.id, summaryBody);
      if (url !== undefined) summaryUrl = url;
    }
  } else if (existingSummary !== undefined) {
    const url = await updateReviewBody(octokit, repo, prNumber, existingSummary.id, summaryBody);
    if (url !== undefined) summaryUrl = url;
  } else {
    const url = await createSummaryReview(octokit, repo, prNumber, pr.head.sha, summaryBody);
    if (url !== undefined) summaryUrl = url;
  }

  return {
    total: findings.length,
    inline,
    skipped,
    routed: filterResult.routedCount,
    failed,
    ...(summaryUrl !== undefined ? { summaryUrl } : {}),
  };
};
