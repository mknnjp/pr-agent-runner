import type { Octokit } from '@octokit/rest';
import type { Finding } from '../schemas/finding.ts';
import { resolveEndLine } from '../schemas/finding.ts';
import { buildCommentBody } from './markdown.ts';
import type { RepoRef } from '../types/cli.ts';
import type { Comment, Review, ReviewComment } from '../types/github.ts';
import { SUMMARY_MARKER } from '../domain/post-comments.ts';
import type { InlineFinding } from '../domain/reviewable-lines.ts';

const toComment = (finding: InlineFinding): Comment => {
  const endLine = resolveEndLine(finding);
  const isMultiLine = typeof finding.end_line === 'number' && finding.end_line > finding.start_line;
  const comment = {
    path: finding.path,
    line: endLine,
    side: 'RIGHT' as const,
    body: buildCommentBody(finding),
  };
  if (isMultiLine) {
    return { ...comment, start_line: finding.start_line, start_side: 'RIGHT' as const };
  }
  return comment;
};

const renderSummaryEntry = (finding: Finding, reason?: string): string => {
  let md = `### 📄 \`${finding.path}\``;
  if (finding.start_line) {
    md += ` (L${finding.start_line}${finding.end_line ? `-L${finding.end_line}` : ''})`;
  }
  md += `\n\n${buildCommentBody(finding)}`;
  if (reason) md += `\n\n*${reason}*`;
  return md;
};

const buildSummaryBody = (
  findingsCount: number,
  entries: ReadonlyArray<{ readonly finding: Finding; readonly reason?: string }>,
): string => {
  let body = `${SUMMARY_MARKER}\nOpenCodeReview: **${findingsCount}** issues (critical: ${entries.filter(({ finding }) => finding.severity === 'critical').length})`;
  if (entries.length > 0) {
    body += `\n\n--- \n\n## Review Summary\n\n`;
    body += entries.map(({ finding, reason }) => renderSummaryEntry(finding, reason)).join('\n\n---\n\n');
  }
  return body;
};

/** List existing review comments newest-first, capped at MAX_PAGES pages. */
export const listExistingReviewComments = async (
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
): Promise<ReviewComment[]> => {
  const all: ReviewComment[] = [];
  const MAX_PAGES = 10;
  let page = 1;
  try {
    while (page <= MAX_PAGES) {
      const res = await octokit.rest.pulls.listReviewComments({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: prNumber,
        sort: 'created',
        direction: 'desc',
        per_page: 100,
        page,
      });
      const items = res.data ?? [];
      all.push(...items);
      if (items.length < 100) break;
      page += 1;
    }
  } catch (error) {
    console.info(
      `[incremental] listing review comments failed (${error instanceof Error ? error.message : String(error)}); degrading to no history.`,
    );
    return [];
  }
  if (page > MAX_PAGES) {
    console.info(
      `[incremental] listing review comments reached max page limit (${MAX_PAGES}); results may be incomplete.`,
    );
  }
  return all;
};

/** Find the newest review whose body carries the summary marker. */
export const findSummaryReview = async (
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
): Promise<Review | undefined> => {
  const all: Review[] = [];
  const MAX_PAGES = 10;
  let page = 1;
  try {
    while (page <= MAX_PAGES) {
      const res = await octokit.rest.pulls.listReviews({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: prNumber,
        per_page: 100,
        page,
      });
      const items = res.data ?? [];
      all.push(...items);
      if (items.length < 100) break;
      page += 1;
    }
  } catch (error) {
    console.info(
      `[sticky] listing reviews failed (${error instanceof Error ? error.message : String(error)}); posting a fresh review.`,
    );
    return undefined;
  }
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const body = all[i].body;
    if (typeof body === 'string' && body.includes(SUMMARY_MARKER)) return all[i];
  }
  return undefined;
};

/** Post a single batch of review comments. Returns the review HTML url for the first batch. */
export const postReviewBatch = async (
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
  headSha: string,
  comments: readonly Comment[],
  body: string | undefined,
): Promise<string | undefined> => {
  try {
    const { data: review } = await octokit.rest.pulls.createReview({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: prNumber,
      commit_id: headSha,
      event: 'COMMENT',
      body,
      comments: [...comments],
    });
    return typeof review.html_url === 'string' ? review.html_url : undefined;
  } catch (error) {
    console.info(
      `[post] failed to post review batch of ${comments.length} comment(s): ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
};

/** Update an existing review's body in place. */
export const updateReviewBody = async (
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
  reviewId: number,
  body: string,
): Promise<string | undefined> => {
  try {
    const { data: updated } = await octokit.rest.pulls.updateReview({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: prNumber,
      review_id: reviewId,
      body,
    });
    return typeof updated.html_url === 'string' ? updated.html_url : undefined;
  } catch (error) {
    console.info(
      `[post] failed to update review #${reviewId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
};

/** Create a summary-only review. */
export const createSummaryReview = async (
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
  headSha: string,
  body: string,
): Promise<string | undefined> => {
  try {
    const { data: review } = await octokit.rest.pulls.createReview({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: prNumber,
      commit_id: headSha,
      event: 'COMMENT',
      body,
    });
    return typeof review.html_url === 'string' ? review.html_url : undefined;
  } catch (error) {
    console.info(
      `[post] failed to create summary review: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
};

export { toComment, renderSummaryEntry, buildSummaryBody };
