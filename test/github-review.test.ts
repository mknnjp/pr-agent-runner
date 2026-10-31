import { expect } from 'expect';
import { describe, test } from 'node:test';
import { postReview } from '../src/github/reviews.ts';
import { createCaptures, makeFakeOctokit, toOctokit } from './helpers/fake-octokit.ts';
import { PATCH, inlineFinding, multiLineFinding, summaryFinding } from './helpers/fixtures.ts';

const fakeFor = (
  files: Array<{ filename: string; patch?: string | null }>,
  captures = createCaptures(),
  seed: Parameters<typeof makeFakeOctokit>[2] = {},
) => {
  const octokit = makeFakeOctokit(files, captures, seed);
  return { octokit, captures };
};

describe('postReview', () => {
  test('returns early with empty stats when there are no findings', async () => {
    const { octokit, captures } = fakeFor([]);
    const stats = await postReview(toOctokit(octokit), { owner: 'o', repo: 'r' }, 1, []);
    expect(captures.reviews).toHaveLength(0);
    expect(stats).toEqual({ total: 0, inline: 0, skipped: 0, routed: 0, failed: 0 });
  });

  test('posts inline comments for reviewable lines', async () => {
    const { octokit, captures } = fakeFor([{ filename: 'a.ts', patch: PATCH }]);
    const stats = await postReview(toOctokit(octokit), { owner: 'o', repo: 'r' }, 7, [inlineFinding(3)]);

    expect(captures.reviews).toHaveLength(1);
    const review = captures.reviews[0] as {
      commit_id: string;
      event: string;
      comments?: Array<Record<string, unknown>>;
    };
    expect(review.commit_id).toBe('abc123');
    expect(review.event).toBe('COMMENT');
    expect(review.comments).toHaveLength(1);
    expect(review.comments?.[0]?.path).toBe('a.ts');
    expect(review.comments?.[0]?.line).toBe(3);
    expect(stats).toEqual({
      total: 1,
      inline: 1,
      skipped: 0,
      routed: 0,
      failed: 0,
      summaryUrl: 'https://github.com/test/reviews/new',
    });
  });

  test('moves non-reviewable findings into the summary body', async () => {
    const { octokit, captures } = fakeFor([]);
    await postReview(toOctokit(octokit), { owner: 'o', repo: 'r' }, 7, [summaryFinding]);

    expect(captures.reviews).toHaveLength(1);
    const review = captures.reviews[0] as { body: string; comments?: unknown[] };
    expect(review.body).toMatch(/Review Summary/);
    expect(review.body).toMatch(/summary only/);
    expect(review.comments).toBeUndefined();
  });

  test('adds start_line for multi-line inline comments', async () => {
    const { octokit, captures } = fakeFor([{ filename: 'a.ts', patch: PATCH }]);
    await postReview(toOctokit(octokit), { owner: 'o', repo: 'r' }, 7, [multiLineFinding(2, 4)]);

    const review = captures.reviews[0] as { comments?: Array<Record<string, unknown>> };
    expect(review.comments?.[0]?.start_line).toBe(2);
    expect(review.comments?.[0]?.line).toBe(4);
    expect(review.comments?.[0]?.start_side).toBe('RIGHT');
  });
});

describe('postReview batching', () => {
  test('splits inline comments into batches of batchSize', async () => {
    const { octokit, captures } = fakeFor([{ filename: 'a.ts', patch: PATCH }]);
    const stats = await postReview(
      toOctokit(octokit),
      { owner: 'o', repo: 'r' },
      7,
      [inlineFinding(2), inlineFinding(3), inlineFinding(5)],
      { batchSize: '1' },
    );

    expect(captures.reviews).toHaveLength(3);
    for (const review of captures.reviews) {
      expect((review as { comments: unknown[] }).comments).toHaveLength(1);
    }
    // Summary body (with marker) travels on the first batch only.
    expect((captures.reviews[0] as { body: string }).body).toMatch(/ocr-review-summary/);
    expect((captures.reviews[1] as { body?: string }).body).toBeUndefined();
    expect((captures.reviews[2] as { body?: string }).body).toBeUndefined();
    expect(stats.total).toBe(3);
    expect(stats.inline).toBe(3);
  });
});

describe('postReview sticky summary', () => {
  test('creates a fresh review carrying the summary on first run', async () => {
    const { octokit, captures } = fakeFor([{ filename: 'a.ts', patch: PATCH }]);
    await postReview(toOctokit(octokit), { owner: 'o', repo: 'r' }, 7, [inlineFinding(3)]);

    expect(captures.reviews).toHaveLength(1);
    expect((captures.reviews[0] as { body: string }).body).toMatch(/ocr-review-summary/);
    expect((captures.reviews[0] as { comments?: unknown[] }).comments).toHaveLength(1);
  });

  test('updates the existing summary review in place when sticky', async () => {
    const { octokit, captures } = fakeFor([{ filename: 'a.ts', patch: PATCH }], createCaptures(), {
      reviews: [
        {
          id: 42,
          body: '<!-- ocr-review-summary -->\nold summary',
          html_url: 'https://github.com/o/r/pull/7/reviews/42',
        },
      ],
    });
    const stats = await postReview(toOctokit(octokit), { owner: 'o', repo: 'r' }, 7, [inlineFinding(3)]);

    expect(captures.reviews).toHaveLength(1);
    expect(captures.reviewUpdates).toHaveLength(1);
    const created = captures.reviews[0] as { body?: string };
    const updated = captures.reviewUpdates[0] as { review_id: number; body: string };
    expect(created).toBeTruthy();
    // Inline comments go to a fresh review; the summary body is updated in place.
    expect(created.body).toBeUndefined();
    expect(updated.review_id).toBe(42);
    expect(updated.body).toMatch(/ocr-review-summary/);
    expect(stats.summaryUrl).toBe('https://github.com/test/reviews/updated');
  });

  test('with sticky false always posts a fresh review with the summary', async () => {
    const { octokit, captures } = fakeFor([{ filename: 'a.ts', patch: PATCH }], createCaptures(), {
      reviews: [{ id: 42, body: '<!-- ocr-review-summary -->\nold summary' }],
    });
    await postReview(toOctokit(octokit), { owner: 'o', repo: 'r' }, 7, [inlineFinding(3)], { sticky: false });

    expect(captures.reviews).toHaveLength(1);
    expect((captures.reviews[0] as { body: string }).body).toMatch(/ocr-review-summary/);
    expect((captures.reviews[0] as { comments?: unknown[] }).comments).toHaveLength(1);
  });

  test('summary-only run updates the existing sticky review without creating a new one', async () => {
    const { octokit, captures } = fakeFor([], createCaptures(), {
      reviews: [{ id: 42, body: '<!-- ocr-review-summary -->\nold summary' }],
    });
    await postReview(toOctokit(octokit), { owner: 'o', repo: 'r' }, 7, [summaryFinding]);

    expect(captures.reviewUpdates).toHaveLength(1);
    const updated = captures.reviewUpdates[0] as { review_id?: number; body: string };
    expect(updated.review_id).toBe(42);
    expect(updated.body).toMatch(/summary only/);
  });
});

describe('postReview incremental', () => {
  test('skips an inline comment overlapping an existing bot comment on the same line', async () => {
    const { octokit, captures } = fakeFor([{ filename: 'a.ts', patch: PATCH }], createCaptures(), {
      reviewComments: [
        { path: 'a.ts', start_line: null, line: 3, side: 'RIGHT', user: { type: 'Bot', login: 'app[bot]' } },
      ],
    });
    const stats = await postReview(toOctokit(octokit), { owner: 'o', repo: 'r' }, 7, [inlineFinding(3)], {
      incremental: true,
    });

    expect(stats.skipped).toBe(1);
    expect(stats.inline).toBe(0);
    // Nothing inline left → summary-only review (no comments).
    expect(captures.reviews).toHaveLength(1);
    expect((captures.reviews[0] as { comments?: unknown[] }).comments).toBeUndefined();
    expect((captures.reviews[0] as { body: string }).body).toMatch(/overlapped with existing reviews/);
  });

  test('does not skip a single-line comment when history is multi-line', async () => {
    const { octokit } = fakeFor([{ filename: 'a.ts', patch: PATCH }], createCaptures(), {
      reviewComments: [{ path: 'a.ts', start_line: 2, line: 4, side: 'RIGHT', user: { type: 'Bot' } }],
    });
    const stats = await postReview(toOctokit(octokit), { owner: 'o', repo: 'r' }, 7, [inlineFinding(3)], {
      incremental: true,
    });

    expect(stats.skipped).toBe(0);
    expect(stats.inline).toBe(1);
  });

  test('does not skip a multi-line comment when IoU is at or below the threshold', async () => {
    const { octokit } = fakeFor([{ filename: 'a.ts', patch: PATCH }], createCaptures(), {
      reviewComments: [{ path: 'a.ts', start_line: 3, line: 5, side: 'RIGHT', user: { type: 'Bot' } }],
    });
    // cur [1..4] (4 lines), other [3..5] (3): overlap 2, union 5, IoU = 0.4 <= 0.6
    const stats = await postReview(toOctokit(octokit), { owner: 'o', repo: 'r' }, 7, [multiLineFinding(1, 4)], {
      incremental: true,
    });

    expect(stats.skipped).toBe(0);
    expect(stats.inline).toBe(1);
  });

  test('skips a multi-line comment when IoU exceeds the threshold', async () => {
    const { octokit } = fakeFor([{ filename: 'a.ts', patch: PATCH }], createCaptures(), {
      reviewComments: [{ path: 'a.ts', start_line: 2, line: 5, side: 'RIGHT', user: { type: 'Bot' } }],
    });
    // cur [1..5] (5), other [2..5] (4): overlap 4, union 5, IoU = 0.8 > 0.6
    const stats = await postReview(toOctokit(octokit), { owner: 'o', repo: 'r' }, 7, [multiLineFinding(1, 5)], {
      incremental: true,
    });

    expect(stats.skipped).toBe(1);
    expect(stats.inline).toBe(0);
  });

  test('ignores history comments from non-bot users', async () => {
    const { octokit } = fakeFor([{ filename: 'a.ts', patch: PATCH }], createCaptures(), {
      reviewComments: [
        { path: 'a.ts', start_line: null, line: 3, side: 'RIGHT', user: { type: 'User', login: 'human' } },
      ],
    });
    const stats = await postReview(toOctokit(octokit), { owner: 'o', repo: 'r' }, 7, [inlineFinding(3)], {
      incremental: true,
    });

    expect(stats.skipped).toBe(0);
    expect(stats.inline).toBe(1);
  });
});

describe('postReview content-based dedup', () => {
  test('skips an inline comment whose content matches a bot comment on the same path, even on a different line', async () => {
    const { octokit } = fakeFor([{ filename: 'a.ts', patch: PATCH }], createCaptures(), {
      reviewComments: [
        {
          path: 'a.ts',
          start_line: null,
          line: 2,
          side: 'RIGHT',
          user: { type: 'Bot' },
          body: '[bug · high]\n\nUse unsafe method here',
        },
      ],
    });
    const stats = await postReview(
      toOctokit(octokit),
      { owner: 'o', repo: 'r' },
      7,
      [{ ...inlineFinding(3), content: 'use unsafe method here' }],
      { incremental: true },
    );

    expect(stats.skipped).toBe(1);
    expect(stats.inline).toBe(0);
  });

  test('does not skip when both the content and the lines differ', async () => {
    const { octokit, captures } = fakeFor([{ filename: 'a.ts', patch: PATCH }], createCaptures(), {
      reviewComments: [
        {
          path: 'a.ts',
          start_line: null,
          line: 2,
          side: 'RIGHT',
          user: { type: 'Bot' },
          body: '[bug · high]\n\ncompletely different concern',
        },
      ],
    });
    const stats = await postReview(
      toOctokit(octokit),
      { owner: 'o', repo: 'r' },
      7,
      [{ ...inlineFinding(3), content: 'use unsafe method here' }],
      { incremental: true },
    );

    expect(stats.skipped).toBe(0);
    expect(stats.inline).toBe(1);
    expect(captures.reviews).toHaveLength(1);
  });

  test('content dedup can be disabled via contentBasedDeduplication false', async () => {
    const { octokit, captures } = fakeFor([{ filename: 'a.ts', patch: PATCH }], createCaptures(), {
      reviewComments: [
        {
          path: 'a.ts',
          start_line: null,
          line: 2,
          side: 'RIGHT',
          user: { type: 'Bot' },
          body: '[bug · high]\n\nuse unsafe method here',
        },
      ],
    });
    const stats = await postReview(
      toOctokit(octokit),
      { owner: 'o', repo: 'r' },
      7,
      [{ ...inlineFinding(3), content: 'use unsafe method here' }],
      { incremental: true, contentBasedDeduplication: false },
    );

    expect(stats.skipped).toBe(0);
    expect(stats.inline).toBe(1);
    expect(captures.reviews).toHaveLength(1);
  });

  test('content similarity threshold tightens the duplicate test', async () => {
    const { octokit } = fakeFor([{ filename: 'a.ts', patch: PATCH }], createCaptures(), {
      reviewComments: [
        {
          path: 'a.ts',
          start_line: null,
          line: 2,
          side: 'RIGHT',
          user: { type: 'Bot' },
          body: '[bug · high]\n\nuse unsafe method with extra context here',
        },
      ],
    });
    // share most tokens, but a high threshold keeps them distinct.
    const stats = await postReview(
      toOctokit(octokit),
      { owner: 'o', repo: 'r' },
      7,
      [{ ...inlineFinding(3), content: 'use unsafe method here' }],
      { incremental: true, contentSimilarityThreshold: '0.99' },
    );

    expect(stats.skipped).toBe(0);
    expect(stats.inline).toBe(1);
  });
});

describe('postReview routing', () => {
  test('routes only low findings to the summary with routeSeverityBelow=low', async () => {
    const { octokit, captures } = fakeFor([{ filename: 'a.ts', patch: PATCH }]);
    const stats = await postReview(
      toOctokit(octokit),
      { owner: 'o', repo: 'r' },
      7,
      [inlineFinding(2, 'high'), inlineFinding(3, 'medium'), inlineFinding(5, 'low')],
      { routeSeverityBelow: 'low' },
    );

    expect(stats.routed).toBe(1);
    expect(stats.inline).toBe(2);
    expect(captures.reviews).toHaveLength(1);
    const review = captures.reviews[0] as { comments: Array<Record<string, unknown>>; body: string };
    expect(review.comments.map((comment) => comment.line)).toEqual([2, 3]);
    expect(review.body).toMatch(/low/);
    expect(review.body).toMatch(/Routed to summary/);
  });

  test('routes only medium and low findings with routeSeverityBelow=medium', async () => {
    const { octokit, captures } = fakeFor([{ filename: 'a.ts', patch: PATCH }]);
    const stats = await postReview(
      toOctokit(octokit),
      { owner: 'o', repo: 'r' },
      7,
      [inlineFinding(1, 'critical'), inlineFinding(2, 'high'), inlineFinding(3, 'medium'), inlineFinding(5, 'low')],
      { routeSeverityBelow: 'medium' },
    );

    expect(stats.routed).toBe(2);
    expect(stats.inline).toBe(2);
    expect(captures.reviews).toHaveLength(1);
    const review = captures.reviews[0] as { comments: Array<Record<string, unknown>>; body: string };
    expect(review.comments.map((comment) => comment.line)).toEqual([1, 2]);
    expect(review.body).toMatch(/medium/);
    expect(review.body).toMatch(/low/);
  });

  test('routes findings matching a configured category to the summary', async () => {
    const { octokit, captures } = fakeFor([{ filename: 'a.ts', patch: PATCH }]);
    const stats = await postReview(
      toOctokit(octokit),
      { owner: 'o', repo: 'r' },
      7,
      [inlineFinding(2, 'high', 'bug'), inlineFinding(3, 'high', 'style')],
      { routeCategories: 'style' },
    );

    expect(stats.routed).toBe(1);
    expect(stats.inline).toBe(1);
    const review = captures.reviews[0] as { comments: Array<Record<string, unknown>> };
    expect(review.comments[0]?.line).toBe(2);
  });

  test('leaves unknown metadata alone (nothing routed)', async () => {
    const { octokit, captures } = fakeFor([{ filename: 'a.ts', patch: PATCH }]);
    const stats = await postReview(
      toOctokit(octokit),
      { owner: 'o', repo: 'r' },
      7,
      [inlineFinding(2, 'medium'), inlineFinding(3, 'low')],
      { routeSeverityBelow: 'garbage' },
    );

    expect(stats.routed).toBe(0);
    expect(stats.inline).toBe(2);
    expect(captures.reviews).toHaveLength(1);
    expect((captures.reviews[0] as { comments: unknown[] }).comments).toHaveLength(2);
  });
});

describe('postReview error handling', () => {
  test('reports failed batches in stats', async () => {
    const { octokit } = fakeFor([{ filename: 'a.ts', patch: PATCH }]);
    // Force the createReview call to reject.
    octokit.rest.pulls.createReview = async () => {
      throw new Error('boom');
    };
    const stats = await postReview(toOctokit(octokit), { owner: 'o', repo: 'r' }, 7, [inlineFinding(3)]);

    expect(stats.failed).toBe(1);
    expect(stats.inline).toBe(0);
  });
});
