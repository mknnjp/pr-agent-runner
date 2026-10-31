import type { RestEndpointMethodTypes } from '@octokit/rest';

/** One element of the `comments` array accepted by `pulls.createReview`. */
export type RawComment = NonNullable<
  RestEndpointMethodTypes['pulls']['createReview']['parameters']['comments']
>[number];

/** Normalised comment DTO: a `Comment` always carries `path`/`line`/`side`/`body`,
 * while multi-line ranges add `start_line`/`start_side` and drop `position`. */
export type Comment = Partial<Pick<RawComment, 'position' | 'start_line' | 'start_side'>> &
  Required<Omit<RawComment, 'position' | 'start_line' | 'start_side'>>;

/** Shape of a single review comment returned by `pulls.listReviewComments`. */
export type ReviewComment = RestEndpointMethodTypes['pulls']['listReviewComments']['response']['data'][number];

/** Shape of a single review returned by `pulls.listReviews`. */
export type Review = RestEndpointMethodTypes['pulls']['listReviews']['response']['data'][number];

/** Result counters returned by `postReview`. `summaryUrl` is the HTML URL of
 * the review whose body carries the summary marker (the freshly-created one
 * for a first run, or the updated sticky review on subsequent runs). */
export interface ReviewStats {
  readonly total: number;
  readonly inline: number;
  readonly skipped: number;
  readonly routed: number;
  readonly failed: number;
  readonly summaryUrl?: string;
}
