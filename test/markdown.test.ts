import { expect } from 'expect';
import { describe, test } from 'node:test';
import { buildCommentBody, escapeMarkdown } from '../src/github/markdown.ts';
import type { Finding } from '../src/schemas/finding.ts';

const escapeCases: ReadonlyArray<[string, string | undefined, string]> = [
  ['escapes backslash', 'a\\b', 'a\\\\b'],
  ['escapes asterisk', 'a*b', 'a\\*b'],
  ['escapes underscore', 'a_b', 'a\\_b'],
  ['does not escape hyphens', 'a-b', 'a-b'],
  ['handles undefined as empty string', undefined, ''],
  ['leaves plain text untouched', 'hello world 123', 'hello world 123'],
  ['preserves inline code', 'use `code` here', 'use `code` here'],
  ['preserves fenced code blocks', '```ts\nconst x = 1;\n```', '```ts\nconst x = 1;\n```'],
  [
    'escapes special chars outside code but keeps code intact',
    'fix *this* and `keep code` and *more*',
    'fix \\*this\\* and `keep code` and \\*more\\*',
  ],
];

for (const [name, input, expected] of escapeCases) {
  test(`escapeMarkdown ${name}`, () => {
    expect(escapeMarkdown(input)).toBe(expected);
  });
}

const commentBodyFinding = (overrides: Partial<Finding> = {}): Finding => ({
  path: 'a.ts',
  content: 'do thing',
  category: 'bug',
  severity: 'high',
  side: 'RIGHT',
  ...overrides,
});

describe('buildCommentBody', () => {
  test('includes category and severity header', () => {
    const body = buildCommentBody(commentBodyFinding());
    expect(body).toMatch(/^\[bug · high\]/);
    expect(body).toMatch(/do thing/);
  });

  test('appends suggestion when present', () => {
    const body = buildCommentBody(commentBodyFinding({ suggestion: 'do other thing' }));
    expect(body).toMatch(/Suggestion:\n/);
    expect(body).toMatch(/```\ndo other thing\n```/);
  });

  test('wraps multi-line suggestion in a fenced code block', () => {
    const body = buildCommentBody(commentBodyFinding({ suggestion: 'line one\n  indented line two\nline three' }));
    expect(body).toMatch(/Suggestion:\n```\nline one\n  indented line two\nline three\n```/);
  });

  test('does not double-wrap an already fenced suggestion', () => {
    const body = buildCommentBody(commentBodyFinding({ suggestion: '```ts\nconst x = 1;\n```' }));
    expect(body).toMatch(/Suggestion:\n```ts\nconst x = 1;\n```/);
    expect(body).not.toMatch(/````/);
  });

  test('omits suggestion when blank', () => {
    const body = buildCommentBody(commentBodyFinding({ suggestion: '   ' }));
    expect(body).not.toMatch(/Suggestion:/);
  });

  test('keeps code formatting in content and suggestion', () => {
    const body = buildCommentBody(
      commentBodyFinding({
        content: 'use `code` here',
        suggestion: 'try *bold*',
        category: 'security',
        severity: 'critical',
      }),
    );
    expect(body).toMatch(/use `code` here/);
    expect(body).toMatch(/Suggestion:\n```\ntry \*bold\*\n```/);
  });
});
