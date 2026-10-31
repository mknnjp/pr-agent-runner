import { expect } from 'expect';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { runMention } from '../src/commands/mention.ts';
import { runReview } from '../src/commands/review.ts';
import { runOcrReview } from '../src/commands/ocr.ts';
import type { CliDeps } from '../src/types/cli.ts';
import { makeFakeOctokit, createCaptures, toOctokit } from './helpers/fake-octokit.ts';
import { mockFetch } from './helpers/fetch-mock.ts';
import { PATCH } from './helpers/fixtures.ts';
import { withCwd, withTempDir } from './helpers/temp.ts';

const asReview = (config: ReturnType<typeof parseConfig>) => {
  if (config.mode !== 'review') throw new Error(`expected review config, got ${config.mode}`);
  return config;
};

const asMention = (config: ReturnType<typeof parseConfig>) => {
  if (config.mode !== 'review-on-mention') throw new Error(`expected mention config, got ${config.mode}`);
  return config;
};

/** Run `fn` with the given env vars set, restoring the previous values afterwards. */
const withEnv = async <T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> => {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) {
    saved.set(key, process.env[key]);
    process.env[key] = env[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, prev] of saved) {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  }
};

/** Fake execFile that answers the OCR/git command sequence with `findings`. */
const fakeOcrExec =
  (findings: unknown): CliDeps['execFile'] =>
    async (file, args) => {
      if (file === 'git' && args[0] === 'merge-base') return { stdout: 'base123\n', stderr: '' };
      if (file === 'ocr' && args[0] === 'review') {
        return { stdout: JSON.stringify(findings), stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };

const inlineFindingJson = (path: string, line: number) => ({
  path,
  content: `inline ${line}`,
  category: 'bug',
  severity: 'high',
  side: 'RIGHT',
  start_line: line,
});

describe('parseConfig', () => {
  test('reads required values from env (review mode)', () => {
    const config = asReview(
      parseConfig({
        GITHUB_TOKEN: 'tok',
        GITHUB_REPOSITORY: 'owner/repo',
        PR_NUMBER: '42',
        RESULT_PATH: 'out.json',
      }),
    );
    expect(config.mode).toBe('review');
    expect(config.token).toBe('tok');
    expect(config.owner).toBe('owner');
    expect(config.repo).toBe('repo');
    expect(config.prNumber).toBe(42);
    expect(config.resultPath).toBe('out.json');
  });

  test('defaults RESULT_PATH to result.json', () => {
    const config = asReview(parseConfig({ GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'owner/repo', PR_NUMBER: '1' }));
    expect(config.resultPath).toBe('result.json');
  });

  test('stays in review mode when COMMENT_ID is empty', () => {
    const config = asReview(
      parseConfig({ GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'owner/repo', PR_NUMBER: '42', COMMENT_ID: '' }),
    );
    expect(config.mode).toBe('review');
  });

  const errorCases: ReadonlyArray<[string, NodeJS.ProcessEnv, RegExp]> = [
    ['throws when GITHUB_TOKEN is missing', { GITHUB_REPOSITORY: 'owner/repo', PR_NUMBER: '1' }, /GITHUB_TOKEN/],
    ['throws when GITHUB_REPOSITORY is missing', { GITHUB_TOKEN: 'tok', PR_NUMBER: '1' }, /GITHUB_REPOSITORY/],
    [
      'throws when PR_NUMBER is invalid',
      { GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'owner/repo', PR_NUMBER: 'abc' },
      /PR_NUMBER/,
    ],
    [
      'throws when PR_NUMBER is zero',
      { GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'owner/repo', PR_NUMBER: '0' },
      /PR_NUMBER/,
    ],
    [
      'throws when COMMENT_ID is invalid',
      { GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'owner/repo', PR_NUMBER: '1', COMMENT_ID: 'abc' },
      /COMMENT_ID/,
    ],
  ];

  for (const [name, env, re] of errorCases) {
    test(name, () => {
      expect(() => parseConfig(env)).toThrow(re);
    });
  }

  test('switches to review-on-mention mode when COMMENT_ID is present', () => {
    const config = asMention(
      parseConfig({
        GITHUB_TOKEN: 'tok',
        GITHUB_REPOSITORY: 'owner/repo',
        PR_NUMBER: '42',
        COMMENT_ID: '12345',
        COMMENT_BODY: '@bg-onigiri review',
        COMMENT_USER: 'someone',
        BOT_MENTION: '@bg-onigiri',
        BASE_REF: 'main',
        HEAD_SHA: 'abc123',
      }),
    );
    expect(config.commentId).toBe(12345);
    expect(config.commentBody).toBe('@bg-onigiri review');
    expect(config.botMention).toBe('@bg-onigiri');
  });

  test('defaults BOT_MENTION to @opencode-review', () => {
    const config = asMention(
      parseConfig({ GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'owner/repo', PR_NUMBER: '1', COMMENT_ID: '1' }),
    );
    expect(config.botMention).toBe('@opencode-review');
  });

  test('reads BASE_REF and HEAD_SHA in review mode', () => {
    const config = asReview(
      parseConfig({
        GITHUB_TOKEN: 'tok',
        GITHUB_REPOSITORY: 'owner/repo',
        PR_NUMBER: '42',
        BASE_REF: 'main',
        HEAD_SHA: 'abc123',
      }),
    );
    expect(config.baseRef).toBe('main');
    expect(config.headSha).toBe('abc123');
  });

  test('leaves baseRef/headSha undefined when env is absent', () => {
    const config = asReview(parseConfig({ GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'owner/repo', PR_NUMBER: '42' }));
    expect(config.baseRef).toBeUndefined();
    expect(config.headSha).toBeUndefined();
  });

  test('defaults the review posting options', () => {
    const config = asReview(parseConfig({ GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'owner/repo', PR_NUMBER: '42' }));
    expect(config.stickySummary).toBe(true);
    expect(config.incremental).toBe(false);
    expect(config.incrementalOverlapThreshold).toBe('');
    expect(config.contentBasedDeduplication).toBe(true);
    expect(config.contentSimilarityThreshold).toBe('');
    expect(config.batchSize).toBe('');
    expect(config.routeSeverityBelow).toBe('');
    expect(config.routeCategories).toBe('');
  });

  test('reads the review posting options from env', () => {
    const config = asReview(
      parseConfig({
        GITHUB_TOKEN: 'tok',
        GITHUB_REPOSITORY: 'owner/repo',
        PR_NUMBER: '42',
        REVIEW_STICKY_SUMMARY: 'false',
        REVIEW_INCREMENTAL: 'true',
        REVIEW_INCREMENTAL_OVERLAP_THRESHOLD: '0.3',
        REVIEW_CONTENT_BASED_DEDUPLICATION: 'false',
        REVIEW_CONTENT_SIMILARITY_THRESHOLD: '0.9',
        REVIEW_COMMENT_BATCH_SIZE: '10',
        REVIEW_ROUTE_SEVERITY_BELOW: 'low',
        REVIEW_ROUTE_CATEGORIES: 'style, documentation',
      }),
    );
    expect(config.stickySummary).toBe(false);
    expect(config.incremental).toBe(true);
    expect(config.incrementalOverlapThreshold).toBe('0.3');
    expect(config.contentBasedDeduplication).toBe(false);
    expect(config.contentSimilarityThreshold).toBe('0.9');
    expect(config.batchSize).toBe('10');
    expect(config.routeSeverityBelow).toBe('low');
    expect(config.routeCategories).toBe('style, documentation');
  });
});

describe('runReview', () => {
  test('posts review and sets outputs from a pre-generated result file', async () => {
    const outputs: Array<[string, string]> = [];
    const infoCalls: string[] = [];

    await withTempDir(async (dir) => {
      const resultPath = join(dir, 'result.json');
      await writeFile(resultPath, JSON.stringify([inlineFindingJson('a.ts', 3)]));

      const captures = createCaptures();
      const octokit = makeFakeOctokit([{ filename: 'a.ts', patch: PATCH }], captures);
      const config = asReview(
        parseConfig({ GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'o/r', PR_NUMBER: '7', RESULT_PATH: resultPath }),
      );

      await runReview(config, {
        octokitFactory: () => toOctokit(octokit),
        info: (m) => infoCalls.push(m),
        setOutput: (n, v) => outputs.push([n, v]),
      });

      expect(captures.reviews).toHaveLength(1);
      expect(outputs).toEqual([
        ['comments_total', '1'],
        ['comments_inline', '1'],
        ['comments_skipped', '0'],
        ['comments_routed', '0'],
        ['comments_failed', '0'],
        ['summary_comment_url', 'https://github.com/test/reviews/new'],
      ]);
    });
  });

  test('runs OCR when baseRef/headSha are present', async () => {
    const outputs: Array<[string, string]> = [];

    await withTempDir(async (dir) => {
      await withCwd(dir, async () => {
        const captures = createCaptures();
        const octokit = makeFakeOctokit([{ filename: 'a.ts', patch: PATCH }], captures);
        const config = asReview(
          parseConfig({
            GITHUB_TOKEN: 'tok',
            GITHUB_REPOSITORY: 'o/r',
            PR_NUMBER: '7',
            BASE_REF: 'main',
            HEAD_SHA: 'abc123',
          }),
        );

        await runReview(config, {
          octokitFactory: () => toOctokit(octokit),
          execFile: fakeOcrExec([inlineFindingJson('a.ts', 3)]),
          info: () => { },
          setOutput: (n, v) => outputs.push([n, v]),
        });

        expect(captures.reviews).toHaveLength(1);
        expect(outputs[0]).toEqual(['comments_total', '1']);
      });
    });
  });

  test('skips when there are no findings', async () => {
    const outputs: Array<[string, string]> = [];
    const infoCalls: string[] = [];

    await withTempDir(async (dir) => {
      const resultPath = join(dir, 'result.json');
      await writeFile(resultPath, '[]');
      const captures = createCaptures();
      const octokit = makeFakeOctokit([], captures);
      const config = asReview(
        parseConfig({ GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'o/r', PR_NUMBER: '7', RESULT_PATH: resultPath }),
      );

      await runReview(config, {
        octokitFactory: () => toOctokit(octokit),
        info: (m) => infoCalls.push(m),
        setOutput: (n, v) => outputs.push([n, v]),
      });

      expect(captures.reviews).toHaveLength(0);
      expect(outputs).toHaveLength(0);
      expect(infoCalls.some((m) => /No findings to review/.test(m))).toBe(true);
    });
  });

  test('treats composePr failure as non-fatal', async () => {
    const { restore } = mockFetch([{ status: 500, ok: false, body: {} }]);
    try {
      await withTempDir(async (dir) => {
        const resultPath = join(dir, 'result.json');
        await writeFile(resultPath, JSON.stringify([inlineFindingJson('a.ts', 3)]));
        const captures = createCaptures();
        const octokit = makeFakeOctokit([{ filename: 'a.ts', patch: PATCH }], captures);
        const config = asReview(
          parseConfig({
            GITHUB_TOKEN: 'tok',
            GITHUB_REPOSITORY: 'o/r',
            PR_NUMBER: '7',
            RESULT_PATH: resultPath,
            COMPOSE_PR: 'true',
          }),
        );

        await runReview(config, {
          octokitFactory: () => toOctokit(octokit),
          info: () => { },
          setOutput: () => { },
        });

        expect(captures.reviews).toHaveLength(1);
      });
    } finally {
      restore();
    }
  });

  test('throws a wrapped error when a step fails', async () => {
    const captures = createCaptures();
    const octokit = makeFakeOctokit([], captures);
    const config = asReview(
      parseConfig({
        GITHUB_TOKEN: 'tok',
        GITHUB_REPOSITORY: 'o/r',
        PR_NUMBER: '7',
        RESULT_PATH: '/nonexistent/result.json',
      }),
    );

    await expect(
      runReview(config, {
        octokitFactory: () => toOctokit(octokit),
        info: () => { },
        setOutput: () => { },
      }),
    ).rejects.toThrow(/Review failed for PR #7:[\s\S]*ENOENT/);
  });
});

describe('runOcrReview', () => {
  test('runs ocr/git commands and writes result.json', async () => {
    const execCalls: Array<[string, string[]]> = [];
    const written: Array<[string, string]> = [];
    const deps: CliDeps = {
      execFile: async (file, args) => {
        execCalls.push([file, [...args]]);
        if (file === 'git' && args[0] === 'merge-base') return { stdout: 'base123\n', stderr: '' };
        if (file === 'ocr' && args[0] === 'review') return { stdout: '{"findings":[]}', stderr: '' };
        return { stdout: '', stderr: '' };
      },
      writeFile: async (path, data) => {
        written.push([path, data]);
      },
    };

    const resultPath = await runOcrReview({ baseRef: 'main', headSha: 'abc123' }, deps);

    expect(resultPath).toBe('result.json');
    expect(execCalls).toEqual([
      ['ocr', ['llm', 'test']],
      ['ocr', ['config', 'set', 'language', 'English']],
      ['git', ['fetch', 'origin', 'main']],
      ['git', ['merge-base', 'origin/main', 'abc123']],
      ['ocr', ['review', '--from', 'base123', '--to', 'abc123', '--format', 'json', '--audience', 'agent']],
    ]);
    expect(written).toEqual([['result.json', '{"findings":[]}']]);
  });

  test('falls back to English when OCR_LANGUAGE is empty', async () => {
    const execCalls: Array<[string, string[]]> = [];
    const deps: CliDeps = {
      execFile: async (file, args) => {
        execCalls.push([file, [...args]]);
        if (file === 'git' && args[0] === 'merge-base') return { stdout: 'base123\n', stderr: '' };
        if (file === 'ocr' && args[0] === 'review') return { stdout: '{"findings":[]}', stderr: '' };
        return { stdout: '', stderr: '' };
      },
      writeFile: async () => { },
    };

    await withEnv({ OCR_LANGUAGE: '' }, () => runOcrReview({ baseRef: 'main', headSha: 'abc123' }, deps));

    const languageCalls = execCalls.filter(([file, args]) => file === 'ocr' && args[0] === 'config');
    expect(languageCalls).toEqual([['ocr', ['config', 'set', 'language', 'English']]]);
  });
});

describe('runMention', () => {
  test('review mode re-runs review and posts', async () => {
    await withTempDir(async (dir) => {
      await withCwd(dir, async () => {
        const captures = createCaptures();
        const octokit = makeFakeOctokit([{ filename: 'a.ts', patch: PATCH }], captures);
        const config = asMention(
          parseConfig({
            GITHUB_TOKEN: 'tok',
            GITHUB_REPOSITORY: 'o/r',
            PR_NUMBER: '7',
            COMMENT_ID: '1',
            COMMENT_BODY: '@bot review',
            BOT_MENTION: '@bot',
          }),
        );

        await runMention(config, {
          octokitFactory: () => toOctokit(octokit),
          execFile: fakeOcrExec([inlineFindingJson('a.ts', 3)]),
          info: () => { },
        });

        expect(captures.reviews).toHaveLength(1);
        const review = captures.reviews[0] as { comments?: unknown[] };
        expect(review.comments).toHaveLength(1);
      });
    });
  });

  test('fix mode applies fixes and posts a chat reply', async () => {
    await withTempDir(async (dir) => {
      await withCwd(dir, async () => {
        const captures = createCaptures();
        const octokit = makeFakeOctokit([], captures);
        const config = asMention(
          parseConfig({
            GITHUB_TOKEN: 'tok',
            GITHUB_REPOSITORY: 'o/r',
            PR_NUMBER: '7',
            COMMENT_ID: '1',
            COMMENT_BODY: '@bot fix',
            BOT_MENTION: '@bot',
          }),
        );

        await runMention(config, {
          octokitFactory: () => toOctokit(octokit),
          execFile: fakeOcrExec([
            {
              path: 'src/a.ts',
              content: 'x',
              suggestion: 'fixed line',
              severity: 'high',
              category: 'bug',
              side: 'RIGHT',
              start_line: 1,
            },
          ]),
          info: () => { },
        });

        expect(captures.prCreates).toHaveLength(1);
        expect(captures.comments).toHaveLength(1);
        expect(captures.comments[0]?.body).toMatch(/Created fix PR:/);
      });
    });
  });

  test('chat mode answers and posts a reply', async () => {
    const { restore } = mockFetch([
      { status: 200, body: { choices: [{ message: { content: 'Here is the answer.' } }] } },
    ]);
    try {
      const captures = createCaptures();
      const octokit = makeFakeOctokit([{ filename: 'src/a.ts', patch: '@@ -1 +1 @@\n-old\n+new' }], captures);
      const config = asMention(
        parseConfig({
          GITHUB_TOKEN: 'tok',
          GITHUB_REPOSITORY: 'o/r',
          PR_NUMBER: '7',
          COMMENT_ID: '1',
          COMMENT_BODY: '@bot この関数の意図は?',
          BOT_MENTION: '@bot',
        }),
      );

      await withEnv(
        {
          OCR_LLM_URL: 'https://api.openai.com/v1/chat/completions',
          OCR_LLM_TOKEN: 't',
          OCR_LLM_MODEL: 'gpt-4o',
        },
        async () => {
          await runMention(config, { octokitFactory: () => toOctokit(octokit), info: () => { } });
        },
      );

      expect(captures.comments).toHaveLength(1);
      expect(captures.comments[0]?.body).toMatch(/Here is the answer/);
    } finally {
      restore();
    }
  });

  test('skips when no mention is found', async () => {
    const infoCalls: string[] = [];
    const captures = createCaptures();
    const octokit = makeFakeOctokit([], captures);
    const config = asMention(
      parseConfig({
        GITHUB_TOKEN: 'tok',
        GITHUB_REPOSITORY: 'o/r',
        PR_NUMBER: '7',
        COMMENT_ID: '1',
        COMMENT_BODY: 'just a comment',
        BOT_MENTION: '@bot',
      }),
    );

    await runMention(config, {
      octokitFactory: () => toOctokit(octokit),
      info: (m) => infoCalls.push(m),
    });

    expect(captures.comments).toHaveLength(0);
    expect(captures.reviews).toHaveLength(0);
    expect(infoCalls.some((m) => /No mention found/.test(m))).toBe(true);
  });
});
