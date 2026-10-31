import type { CliConfig } from './types/cli.ts';
import type { ReviewOptions } from './types/review.ts';

const parseRepo = (env: NodeJS.ProcessEnv): { readonly owner: string; readonly repo: string } => {
  const [owner, repo] = env.GITHUB_REPOSITORY?.split('/') ?? [];
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY is required');
  return { owner, repo };
};

const parsePrNumber = (env: NodeJS.ProcessEnv): number => {
  const prNumber = Number(env.PR_NUMBER);
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error('PR_NUMBER is invalid');
  return prNumber;
};

/** Parse review posting options from the environment. Optional fields stay
 * raw so `postReview` resolves its own defaults. */
export const parseReviewOptions = (env: NodeJS.ProcessEnv): ReviewOptions => ({
  sticky: env.REVIEW_STICKY_SUMMARY !== 'false',
  incremental: env.REVIEW_INCREMENTAL === 'true',
  incrementalOverlapThreshold: env.REVIEW_INCREMENTAL_OVERLAP_THRESHOLD,
  contentBasedDeduplication: env.REVIEW_CONTENT_BASED_DEDUPLICATION !== 'false',
  contentSimilarityThreshold: env.REVIEW_CONTENT_SIMILARITY_THRESHOLD,
  batchSize: env.REVIEW_COMMENT_BATCH_SIZE,
  routeSeverityBelow: env.REVIEW_ROUTE_SEVERITY_BELOW ?? '',
  routeCategories: env.REVIEW_ROUTE_CATEGORIES ?? '',
});

/** Parse environment variables into a CliConfig. */
export const parseConfig = (env: NodeJS.ProcessEnv): CliConfig => {
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required');
  const { owner, repo } = parseRepo(env);
  const prNumber = parsePrNumber(env);

  if (env.COMMENT_ID !== undefined && env.COMMENT_ID !== '') {
    const commentId = Number(env.COMMENT_ID);
    if (!Number.isInteger(commentId) || commentId <= 0) throw new Error('COMMENT_ID is invalid');
    const commentBody = env.COMMENT_BODY ?? '';
    const commentUser = env.COMMENT_USER ?? '';
    const botMention = env.BOT_MENTION || '@opencode-review';
    return {
      mode: 'review-on-mention',
      token,
      owner,
      repo,
      prNumber,
      commentId,
      commentBody,
      commentUser,
      botMention,
    };
  }

  const options = parseReviewOptions(env);
  return {
    mode: 'review',
    token,
    owner,
    repo,
    prNumber,
    resultPath: env.RESULT_PATH ?? 'result.json',
    composePr: env.COMPOSE_PR === 'true',
    baseRef: env.BASE_REF,
    headSha: env.HEAD_SHA,
    stickySummary: options.sticky ?? true,
    incremental: options.incremental ?? false,
    incrementalOverlapThreshold: String(options.incrementalOverlapThreshold ?? ''),
    contentBasedDeduplication: options.contentBasedDeduplication ?? true,
    contentSimilarityThreshold: String(options.contentSimilarityThreshold ?? ''),
    batchSize: String(options.batchSize ?? ''),
    routeSeverityBelow: options.routeSeverityBelow ?? '',
    routeCategories: options.routeCategories ?? '',
  };
};
