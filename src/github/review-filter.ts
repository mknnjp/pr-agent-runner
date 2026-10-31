import {
  buildRoutePolicy,
  isBotComment,
  isDuplicateComment,
  resolveContentThreshold,
  shouldRoute,
} from '../domain/post-comments.ts';
import { buildReviewableRightLineMap, splitFindingsForReview, type InlineFinding } from '../domain/reviewable-lines.ts';
import type { Finding } from '../schemas/finding.ts';
import type { ReviewComment } from '../types/github.ts';
import type { ReviewOptions } from '../types/review.ts';

/** Result of filtering findings into inline vs summary, with routing applied. */
export interface FilterResult {
  readonly inlineComments: InlineFinding[];
  readonly summaryEntries: ReadonlyArray<{ readonly finding: Finding; readonly reason?: string }>;
  readonly routedCount: number;
}

/** Split findings into inline vs summary, apply routing policy. */
export const filterFindings = (
  findings: readonly Finding[],
  reviewFiles: ReadonlyArray<{ readonly filename: string; readonly patch?: string | null }>,
  options: ReviewOptions,
): FilterResult => {
  const policy = buildRoutePolicy(options.routeSeverityBelow, options.routeCategories);

  const reviewableRightLines = buildReviewableRightLineMap(
    reviewFiles.map((f) => ({ filename: f.filename, patch: f.patch ?? undefined })),
  );
  const { inlineComments, summaryComments } = splitFindingsForReview(findings, reviewableRightLines);

  let routed = 0;
  const routedEntries: Array<{ readonly finding: Finding; readonly reason: string }> = [];
  const remainingInline: InlineFinding[] = [];
  for (const finding of inlineComments) {
    const route = shouldRoute(finding, policy);
    if (route.routed) {
      routed += 1;
      routedEntries.push({ finding, reason: route.reason });
    } else {
      remainingInline.push(finding);
    }
  }

  return {
    inlineComments: remainingInline,
    summaryEntries: [
      ...summaryComments.map((finding) => ({ finding })),
      ...routedEntries,
    ],
    routedCount: routed,
  };
};

/** Apply incremental filtering and content-based deduplication. */
export const applyIncrementalFilter = <T extends {
  readonly path: string;
  readonly body?: string | null | undefined;
  readonly start_line?: number | string | null | undefined;
  readonly line?: number | string | null | undefined;
  readonly end_line?: number | string | null | undefined;
  readonly side?: string | null | undefined;
}>(
  comments: readonly T[],
  history: readonly ReviewComment[],
  options: ReviewOptions,
  threshold: number,
): { readonly toSend: T[]; readonly skipped: number } => {
  const historyBot = history.filter(isBotComment);
  const contentDedup = options.contentBasedDeduplication !== false;
  const contentThreshold = resolveContentThreshold(options.contentSimilarityThreshold);
  const toSend = comments.filter(
    (comment) =>
      !isDuplicateComment(comment, historyBot, {
        lineThreshold: threshold,
        content: contentDedup,
        contentThreshold,
      }),
  );
  return { toSend, skipped: comments.length - toSend.length };
};
