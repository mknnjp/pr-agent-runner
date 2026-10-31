import type { Octokit } from '@octokit/rest';

/** Repository reference (owner + name). */
export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
}

/**
 * Test seams for the CLI entry points. All fields default to the real
 * implementations so production behaviour is unchanged.
 */
export interface CliDeps {
  /** Override Octokit construction (defaults to real Octokit). */
  octokitFactory?: (token: string) => Octokit;
  /** Override execFile (defaults to promisified node:child_process.execFile). */
  execFile?: (
    file: string,
    args: readonly string[],
    options?: Record<string, unknown>,
  ) => Promise<{ stdout: string; stderr: string }>;
  /** Override writeFile (defaults to node:fs/promises.writeFile). */
  writeFile?: (path: string, data: string, encoding: 'utf8') => Promise<void>;
  /** Override @actions/core.info (defaults to the real one). */
  info?: (message: string) => void;
  /** Override @actions/core.setOutput (defaults to the real one). */
  setOutput?: (name: string, value: string) => void;
  /** Override @actions/core.setFailed (defaults to the real one). */
  setFailed?: (message: string) => void;
}

export interface ReviewCliConfig {
  readonly mode: 'review';
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly resultPath: string;
  readonly composePr: boolean;
  readonly baseRef?: string;
  readonly headSha?: string;
  readonly stickySummary: boolean;
  readonly incremental: boolean;
  readonly incrementalOverlapThreshold: string;
  readonly contentBasedDeduplication: boolean;
  readonly contentSimilarityThreshold: string;
  readonly batchSize: string;
  readonly routeSeverityBelow: string;
  readonly routeCategories: string;
}

export interface ChatCliConfig {
  readonly mode: 'chat' | 'review-on-mention';
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly commentId: number;
  readonly commentBody: string;
  readonly commentUser: string;
  readonly botMention: string;
}

export type CliConfig = ReviewCliConfig | ChatCliConfig;
