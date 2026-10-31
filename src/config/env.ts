/** Centralized access to environment variables.
 *
 * All `process.env` reads go through this module so the application has a
 * single seam for environment configuration. This makes testing easier and
 * keeps environment variable names in one place.
 */

export const getOcrLlmUrl = (): string | undefined => process.env.OCR_LLM_URL;
export const getOcrLlmToken = (): string | undefined => process.env.OCR_LLM_TOKEN;
export const getOcrLlmModel = (): string | undefined => process.env.OCR_LLM_MODEL;
export const getOcrLlmProtocol = (): string | undefined => process.env.OCR_LLM_PROTOCOL;
export const getOcrUseAnthropic = (): string | undefined => process.env.OCR_USE_ANTHROPIC;
export const getOcrLanguage = (): string | undefined => process.env.OCR_LANGUAGE;
export const getOcrMaxTokens = (): string | undefined => process.env.OCR_LLM_MAX_TOKENS;

export const getReviewSticky = (): string | undefined => process.env.REVIEW_STICKY_SUMMARY;
export const getReviewIncremental = (): string | undefined => process.env.REVIEW_INCREMENTAL;
export const getReviewIncrementalOverlapThreshold = (): string | undefined =>
  process.env.REVIEW_INCREMENTAL_OVERLAP_THRESHOLD;
export const getReviewContentBasedDeduplication = (): string | undefined =>
  process.env.REVIEW_CONTENT_BASED_DEDUPLICATION;
export const getReviewContentSimilarityThreshold = (): string | undefined =>
  process.env.REVIEW_CONTENT_SIMILARITY_THRESHOLD;
export const getReviewBatchSize = (): string | undefined => process.env.REVIEW_COMMENT_BATCH_SIZE;
export const getReviewRouteSeverityBelow = (): string | undefined =>
  process.env.REVIEW_ROUTE_SEVERITY_BELOW;
export const getReviewRouteCategories = (): string | undefined =>
  process.env.REVIEW_ROUTE_CATEGORIES;

export const getGitHubToken = (): string | undefined => process.env.GITHUB_TOKEN;
export const getGitHubRepository = (): string | undefined => process.env.GITHUB_REPOSITORY;
export const getPrNumber = (): string | undefined => process.env.PR_NUMBER;
export const getCommentId = (): string | undefined => process.env.COMMENT_ID;
export const getCommentBody = (): string | undefined => process.env.COMMENT_BODY;
export const getCommentUser = (): string | undefined => process.env.COMMENT_USER;
export const getBotMention = (): string | undefined => process.env.BOT_MENTION;
export const getResultPath = (): string | undefined => process.env.RESULT_PATH;
export const getComposePr = (): string | undefined => process.env.COMPOSE_PR;
export const getBaseRef = (): string | undefined => process.env.BASE_REF;
export const getHeadSha = (): string | undefined => process.env.HEAD_SHA;
