import type { Octokit } from '@octokit/rest';
import type { RepoRef } from '../types/cli.ts';
import type { Finding } from '../schemas/finding.ts';
import { isInlineRightFinding } from '../domain/reviewable-lines.ts';
import { resolveEndLine } from '../schemas/finding.ts';

const FIXABLE_SEVERITIES = new Set(['critical', 'high']);

export interface FixTarget {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly suggestion: string;
}

/**
 * Extract only RIGHT-side findings with critical/high severity and a suggestion as fix targets.
 * Line numbers are 1-based. If endLine is missing, it defaults to startLine (single-line replacement).
 */
export const extractFixTargets = (findings: readonly Finding[]): readonly FixTarget[] => {
  const targets: FixTarget[] = [];
  for (const finding of findings) {
    if (!FIXABLE_SEVERITIES.has(finding.severity)) continue;
    if (!isInlineRightFinding(finding)) continue;
    if (typeof finding.suggestion !== 'string' || finding.suggestion.trim() === '') continue;
    targets.push({
      path: finding.path,
      startLine: finding.start_line,
      endLine: resolveEndLine(finding),
      suggestion: finding.suggestion,
    });
  }
  return targets;
};

/**
 * Replace the specified range in a file (represented as an array of lines) with the suggestion.
 * Returns true if the replacement was performed.
 */
export const applyReplacement = (
  lines: readonly string[],
  target: FixTarget,
): { content: string; changed: boolean } => {
  // Convert 1-based line numbers to 0-based indices
  const startIdx = target.startLine - 1;
  const endIdx = target.endLine - 1;
  if (startIdx < 0 || endIdx >= lines.length || startIdx > endIdx) {
    return { content: lines.join('\n'), changed: false };
  }
  const next = [...lines];
  next.splice(startIdx, endIdx - startIdx + 1, target.suggestion);
  return { content: next.join('\n'), changed: true };
};

/**
 * Normalize a bot mention (e.g. "@org/team") into a safe git branch name segment.
 * Strips a leading "@", replaces characters not allowed in git ref names with "-",
 * collapses runs of "-", and falls back to "bot" when nothing usable remains.
 */
const sanitizeBranchSegment = (mention: string): string => {
  const name = mention.startsWith('@') ? mention.slice(1) : mention;
  const sanitized = name
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return sanitized || 'bot';
};

export const buildFixBranchName = (prNumber: number, botMention = '@opencode-review'): string =>
  `fix/${sanitizeBranchSegment(botMention)}-${prNumber}`;

interface ApplyFixesResult {
  readonly branch: string;
  readonly prUrl?: string;
  readonly changedFiles: number;
}

/**
 * Group fix targets by file, create a fix branch from headSha, commit changes,
 * and create a PR based on the original working branch.
 */
// Error handling wrapper for file operations
const safeGetFileContent = async (
  octokit: Octokit,
  repo: RepoRef,
  path: string,
  ref: string,
): Promise<{ content: string; sha: string } | null> => {
  try {
    const { data } = await octokit.rest.repos.getContent({
      ...repo,
      path,
      ref,
    });

    if (!('content' in data) || typeof data.content !== 'string') {
      // Not a regular file (e.g. a directory) — nothing to fix; skip.
      return null;
    }

    const decoded = Buffer.from(data.content, 'base64').toString('utf8');
    return { content: decoded, sha: data.sha };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to get file ${path} at ref ${ref}: ${msg}`);
  }
};

const safeUpdateFile = async (
  octokit: Octokit,
  repo: RepoRef,
  path: string,
  content: string,
  branch: string,
  sha: string,
  message: string,
): Promise<void> => {
  try {
    await octokit.rest.repos.createOrUpdateFileContents({
      ...repo,
      path,
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch,
      sha,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to update file ${path}: ${msg}`);
  }
};

export const applyFixes = async (
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
  targets: readonly FixTarget[],
  headSha: string,
  baseRef: string,
  botMention = '@opencode-review',
): Promise<ApplyFixesResult> => {
  if (targets.length === 0) {
    return { branch: buildFixBranchName(prNumber, botMention), changedFiles: 0 };
  }

  // Group by path
  const byPath = new Map<string, FixTarget[]>();
  for (const target of targets) {
    const list = byPath.get(target.path) ?? [];
    list.push(target);
    byPath.set(target.path, list);
  }

  const branch = buildFixBranchName(prNumber, botMention);

  // Create fix branch from headSha (reuse if already exists)
  try {
    await octokit.rest.git.createRef({
      ...repo,
      ref: `refs/heads/${branch}`,
      sha: headSha,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.includes('already exists')) {
      throw new Error(`Failed to create branch ${branch}: ${msg}`);
    }
    // Ignore error - existing branch is reused
  }

  const changedFiles: string[] = [];

  try {
    for (const [path, pathTargets] of byPath) {
      const fileData = await safeGetFileContent(octokit, repo, path, headSha);
      if (fileData === null) {
        // Skip non-regular files (e.g. directories) — nothing to fix.
        continue;
      }
      const lines = fileData.content.split('\n');

      let current = lines;
      let changed = false;
      // Apply targets from the back (descending startLine) so earlier line numbers
      // stay valid: replacing a range later in the file never shifts earlier lines.
      const sorted = [...pathTargets].sort((a, b) => b.startLine - a.startLine);
      for (const target of sorted) {
        const result = applyReplacement(current, target);
        if (result.changed) {
          current = result.content.split('\n');
          changed = true;
        }
      }

      if (!changed) continue;

      await safeUpdateFile(
        octokit,
        repo,
        path,
        current.join('\n'),
        branch,
        fileData.sha,
        `fix: apply OCR suggestion for ${path}`,
      );
      changedFiles.push(path);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // File operation failure is a fatal error
    throw new Error(`File operation failed during fix application: ${msg}`);
  }

  let prUrl: string | undefined;
  if (changedFiles.length > 0) {
    try {
      const { data } = await octokit.rest.pulls.create({
        ...repo,
        head: branch,
        base: baseRef,
        title: `fix: auto-applied OCR review suggestions for #${prNumber}`,
        body: `Automatically applied ${changedFiles.length} suggestion(s) from OpenCodeReview on #${prNumber}.\n\nModified files:\n${changedFiles.map((f) => `- \`${f}\``).join('\n')}`,
      });
      prUrl = data.html_url;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Failed to create PR for fix branch: ${msg}`);
      // PR creation failure is not fatal, but log it
    }
  }

  return { branch, prUrl, changedFiles: changedFiles.length };
};
