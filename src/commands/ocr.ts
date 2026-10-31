import type { Octokit } from '@octokit/rest';
import type { CliDeps } from '../types/cli.ts';
import { execFile } from 'node:child_process';
import { writeFile as fsWriteFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fetchPrContext } from '../chat/mention.ts';
import { loadFindings } from '../input/loader.ts';
import {
  getOcrLlmUrl,
  getOcrLlmToken,
  getOcrLlmModel,
  getOcrUseAnthropic,
  getOcrLlmProtocol,
  getOcrLanguage,
} from '../config/env.ts';

const execFileAsync = promisify(execFile);

/** Run OCR against the PR diff and write findings to result.json. */
export const runOcrReview = async (
  refs: { readonly baseRef: string; readonly headSha: string },
  deps: CliDeps = {},
): Promise<string> => {
  const {
    execFile = execFileAsync as NonNullable<CliDeps['execFile']>,
    writeFile = fsWriteFile as NonNullable<CliDeps['writeFile']>,
  } = deps;
  const env: Record<string, string | undefined> = {
    OCR_LLM_URL: getOcrLlmUrl(),
    OCR_LLM_TOKEN: getOcrLlmToken(),
    OCR_LLM_MODEL: getOcrLlmModel(),
    OCR_USE_ANTHROPIC: getOcrUseAnthropic(),
    OCR_LLM_PROTOCOL: getOcrLlmProtocol(),
  };
  const { baseRef, headSha } = refs;

  await execFile('ocr', ['llm', 'test'], { env: { ...process.env, ...env } });
  await execFile('ocr', ['config', 'set', 'language', getOcrLanguage() || 'English'], {
    env: { ...process.env, ...env },
  });
  await execFile('git', ['fetch', 'origin', baseRef]);
  const { stdout: mergeBase } = await execFile('git', ['merge-base', `origin/${baseRef}`, headSha]);
  const resultPath = 'result.json';
  const { stdout } = await execFile(
    'ocr',
    ['review', '--from', mergeBase.trim(), '--to', headSha, '--format', 'json', '--audience', 'agent'],
    { env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 },
  );
  await writeFile(resultPath, stdout, 'utf8');
  return resultPath;
};

interface OcrPrResult {
  readonly pr: Awaited<ReturnType<typeof fetchPrContext>>;
  readonly findings: Awaited<ReturnType<typeof loadFindings>>;
}

/** Run OCR against the PR diff and load the resulting findings.
 * Shared by the review re-run and auto-fix mention flows. */
export const runOcrForPr = async (
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  deps: CliDeps = {},
): Promise<OcrPrResult> => {
  const pr = await fetchPrContext(octokit, { owner, repo }, prNumber);
  const resultPath = await runOcrReview({ baseRef: pr.baseRef, headSha: pr.headSha }, deps);
  const findings = await loadFindings(resultPath);
  return { pr, findings };
};

export type { OcrPrResult };
