import type { Finding } from '../schemas/finding.ts';

const SENTINEL = ''; // private-use char, unlikely to appear in real text

/**
 * Escapes Markdown special characters while preserving code formatting.
 *
 * Fenced code blocks (```) and inline code (`...`) are extracted and left
 * untouched so they render correctly on GitHub. The remaining text is escaped
 * to prevent unintended Markdown parsing (e.g. literal asterisks, underscores,
 * brackets), which avoids breaking the layout without over-escaping code.
 */
export const escapeMarkdown = (text?: string): string => {
  const original = text ?? '';
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  let result = original.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `${SENTINEL}CB${codeBlocks.length - 1}${SENTINEL}`;
  });

  result = result.replace(/`[^`\n]+`/g, (match) => {
    inlineCodes.push(match);
    return `${SENTINEL}IC${inlineCodes.length - 1}${SENTINEL}`;
  });

  result = result
    .replace(/\\/g, '\\\\')
    .replace(/[*_~]/g, (c) => `\\${c}`)
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');

  result = result.replace(new RegExp(`${SENTINEL}CB(\\d+)${SENTINEL}`, 'g'), (_, i) => codeBlocks[Number(i)]);
  result = result.replace(new RegExp(`${SENTINEL}IC(\\d+)${SENTINEL}`, 'g'), (_, i) => inlineCodes[Number(i)]);

  return result;
};

/**
 * Formats a suggestion so its layout (line breaks, indentation) is preserved
 * when rendered as Markdown.
 *
 * If the suggestion is already a fenced code block it is returned untouched to
 * avoid double-wrapping. Otherwise it is wrapped in a plain fenced code block
 * so multi-line / indented suggestions do not get mangled by Markdown parsing
 * (headings, lists, blockquotes, collapsed indentation) on GitHub.
 */
const formatSuggestion = (suggestion?: string): string => {
  const text = (suggestion ?? '').trim();
  if (text === '') return '';
  // Already a fenced code block (possibly with a language tag) -> keep as-is.
  if (/^```[\s\S]*```$/.test(text) || text.startsWith('```')) {
    return text;
  }
  return '```\n' + text + '\n```';
};

/**
 * Builds a Markdown-formatted comment body.
 * Content keeps its code formatting (fenced/inline code) while other special
 * characters are escaped to avoid breaking Markdown. The suggestion is always
 * rendered inside a fenced code block so multi-line / indented proposals keep
 * their layout on GitHub.
 */
export const buildCommentBody = ({ category, severity, content, suggestion }: Finding): string => {
  const escapedContent = escapeMarkdown(content);
  const suggestionBlock = formatSuggestion(suggestion);
  let md = `[${category} · ${severity}]\n\n${escapedContent}`;
  if (suggestionBlock !== '') {
    md += `\n\nSuggestion:\n${escapeMarkdown(suggestionBlock)}`;
  }
  return md;
};
