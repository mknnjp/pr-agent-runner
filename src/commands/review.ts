import { Octokit } from '@octokit/rest';
import type { CliDeps, ReviewCliConfig } from '../types/cli.ts';
import { info as coreInfo, setOutput as coreSetOutput } from '@actions/core';
import { resolveLlmConfig } from '../chat/llm/config.ts';
import { fetchPrContext } from '../chat/mention.ts';
import { composePrTitleBody } from '../chat/pr-compose.ts';
import { runOcrReview } from './ocr.ts';
import { loadFindings } from '../input/loader.ts';
import { postReview } from '../github/reviews.ts';

/** Execute the review command: run OCR (if refs provided), optionally compose PR,
 * load findings, and post review comments. */
export const runReview = async (config: ReviewCliConfig, deps: CliDeps = {}): Promise<void> => {
  const { info = coreInfo, setOutput = coreSetOutput } = deps;
  const octokitFactory = deps.octokitFactory ?? ((token: string): Octokit => new Octokit({ auth: token }));
  const octokit = octokitFactory(config.token);

  try {
    let resultPath = config.resultPath;
    // When a ref range is provided (composite action flow), run OCR here so the
    // action has a single entry point. Otherwise fall back to a pre-generated
    // result file (standalone usage).
    if (config.baseRef && config.headSha) {
      resultPath = await runOcrReview({ baseRef: config.baseRef, headSha: config.headSha }, deps);
    }

    if (config.composePr) {
      try {
        const llmConfig = resolveLlmConfig();
        const pr = await fetchPrContext(octokit, { owner: config.owner, repo: config.repo }, config.prNumber);
        const composed = await composePrTitleBody(octokit, llmConfig, { owner: config.owner, repo: config.repo }, pr);
        if (composed) {
          info(`Composed PR title: ${composed.title}`);
        } else {
          info('PR composition returned no valid result; skipping update');
        }
      } catch (error) {
        info(`PR composition failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const findings = await loadFindings(resultPath);

    // Handle empty array or null/undefined cases
    if (!Array.isArray(findings)) {
      throw new Error(`loadFindings returned invalid type: ${typeof findings}`);
    }

    info(`Loaded ${findings.length} findings`);

    // Skip if no findings
    if (findings.length === 0) {
      info('No findings to review; skipping');
      return;
    }

    const stats = await postReview(octokit, { owner: config.owner, repo: config.repo }, config.prNumber, findings, {
      sticky: config.stickySummary,
      incremental: config.incremental,
      incrementalOverlapThreshold: config.incrementalOverlapThreshold,
      contentBasedDeduplication: config.contentBasedDeduplication,
      contentSimilarityThreshold: config.contentSimilarityThreshold,
      batchSize: config.batchSize,
      routeSeverityBelow: config.routeSeverityBelow,
      routeCategories: config.routeCategories,
    });
    setOutput('comments_total', String(stats.total));
    setOutput('comments_inline', String(stats.inline));
    setOutput('comments_skipped', String(stats.skipped));
    setOutput('comments_routed', String(stats.routed));
    setOutput('comments_failed', String(stats.failed));
    setOutput('summary_comment_url', stats.summaryUrl ?? '');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Review failed for PR #${config.prNumber}: ${msg}`);
  }
};
