/** Options controlling how findings are posted. Every field is optional;
 * defaults mirror the action inputs (sticky summary, no incremental filtering,
 * 50 comments per batch, no routing). */
export interface ReviewOptions {
  /** Update the summary review body in place across runs (default: true). */
  readonly sticky?: boolean;
  /** Skip inline comments overlapping previously-posted bot comments (default: false). */
  readonly incremental?: boolean;
  /** IoU threshold for multi-line overlap in incremental mode (default: 0.6). */
  readonly incrementalOverlapThreshold?: string | number;
  /** Also skip inline comments whose content matches a previously-posted bot
   * comment on the same path, even when the lines differ (default: true). */
  readonly contentBasedDeduplication?: boolean;
  /** Jaccard threshold in [0, 1] for content-based dedup (default: 0.8). */
  readonly contentSimilarityThreshold?: string | number;
  /** Max inline comments per createReview call (default: 50). */
  readonly batchSize?: string | number;
  /** Route findings at-or-below this severity to the summary (default: none). */
  readonly routeSeverityBelow?: string;
  /** Comma-separated categories routed to the summary (default: none). */
  readonly routeCategories?: string;
}
