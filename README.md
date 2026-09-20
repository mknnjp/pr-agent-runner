# PR Agent Runner

AI-powered PR review automation built on [OpenCodeReview (OCR)](https://open-codereview.ai/) and a small TypeScript CLI that posts reviews and answers `@mention` commands on GitHub.

- **On PR open, update, or reopen** — runs OCR on the PR diff and posts an inline review.
- **On `@mention`** — supports:
  - `@bot review` — re-run the review and post an updated review.
  - `@bot fix` — auto-apply critical/high findings with suggestions via a new fix PR.
  - any other text — chat about the PR (answers using the PR diff as context).

The whole flow is packaged as a **reusable workflow** (`workflow_call`), so any repository can opt in with a job-level `uses:` call.

## What makes this different

**pr-agent-runner** pairs OCR's review engine with posting capabilities that match the upstream OpenCodeReview GitHub Action, then adds a conversational layer the upstream action does not have:

1. **GitHub App authentication (no PAT)** — a short-lived App token is generated per run (`actions/create-github-app-token`), so no personal access token is required in the consuming repository.
2. **`@mention` bot commands** — comment `@bot review`, `@bot fix`, or ask any question on the PR and the bot answers in the thread.
3. **Auto-fix PRs** — `@bot fix` applies critical/high findings that carry suggestions on a `fix/<bot>-<PR#>` branch and opens a PR.
4. **Self-hosted runner** — the `runner-ref` input pins exactly which revision of the runner CLI executes, decoupling the action's behavior from any release cycle.

### Comparison with the upstream OpenCodeReview GitHub Action

| Aspect            | OpenCodeReview (upstream)                                                                                                 | pr-agent-runner                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Authentication    | Repository `GITHUB_TOKEN`                                                                                                 | GitHub App token (App-scoped, no PAT)                                                                     |
| Triggers          | Workflow events (PR open, push, …)                                                                                        | PR open **plus** `@mention` comments (`review` / `fix` / chat)                                            |
| Posting           | Sticky summary, batch `createReview`, routing, idempotency tags + retries                                                 | Same core posting (sticky summary, batching, routing, incremental dedup); no idempotency/retry layer      |
| Incremental dedup | IoU overlap vs. previously-posted bot comments (matched by login)                                                         | IoU overlap **plus content-based similarity** vs. previously-posted **Bot-type** comments                 |
| Bot commands      | —                                                                                                                         | `@bot review` / `@bot fix` / chat                                                                         |
| Auto-fix          | —                                                                                                                         | `@bot fix` opens a fix PR                                                                                 |
| PR composition    | —                                                                                                                         | Optional PR title/body rewrite (`compose-pr`)                                                             |
| Outputs           | `comments_total` / `comments_inline` / `comments_skipped` / `comments_routed` / `comments_failed` / `summary_comment_url` | Same set                                                                                                  |
| Fork security     | Checks out the base branch and fetches the PR head as git objects (fork-safe)                                             | Standard workflow supports same-repository PRs; fork support requires a separate security-reviewed design |

## Requirements

### 1. GitHub App

Create a GitHub App (or reuse one) with the following permissions:

| Permission    | Access       |
| ------------- | ------------ |
| Pull requests | Read & write |
| Contents      | Read & write |
| Issues        | Read & write |

Install it on every repository that should be reviewed. The App token is used for all API calls (reviews, comments, fix branches/PRs), so it must have the permissions above on the target repos.

> **Fork PRs**: the standard `pull_request` workflow cannot access repository secrets for fork PRs. This example therefore targets same-repository PRs. Supporting forks requires a separate, security-reviewed workflow design.

### 2. Repository variables and secrets

Configure these on each target repository (or at organization level):

| Kind     | Name                    | Description                                                                    |
| -------- | ----------------------- | ------------------------------------------------------------------------------ |
| Secret   | `APP_PRIVATE_KEY`       | GitHub App private key (PEM)                                                   |
| Variable | `APP_ID`                | GitHub App ID                                                                  |
| Secret   | `OCR_LLM_AUTH_TOKEN`    | LLM API token for OCR                                                          |
| Variable | `OCR_LLM_URL`           | LLM endpoint URL                                                               |
| Variable | `OCR_LLM_MODEL`         | LLM model name                                                                 |
| Variable | `OCR_LLM_MAX_TOKENS`    | _(optional)_ LLM max tokens                                                    |
| Variable | `OCR_LLM_USE_ANTHROPIC` | _(optional)_ `"true"` to use the Anthropic protocol                            |
| Variable | `OCR_LLM_PROTOCOL`      | _(optional)_ `anthropic` or `openai` (overrides `OCR_LLM_USE_ANTHROPIC`)       |
| Variable | `OCR_LANGUAGE`          | _(optional)_ Review language, e.g. `English` or `日本語`                       |
| Variable | `COMPOSE_PR`            | _(optional)_ `"true"` to compose/update the PR title and body                  |
| Variable | `BOT_MENTION`           | _(optional)_ Bot mention trigger, e.g. `@my-bot` (default: `@opencode-review`) |

### 3. Node.js 24+ (required)

The runner CLI is executed **directly from TypeScript source** using Node's native [type stripping](https://nodejs.org/api/typescript.html) — there is no build step. This requires **Node.js 24 or newer** (the `node-version` input defaults to `24`). Using an older Node.js (e.g. 20 or 22) will fail at runtime.

## Usage

Add a workflow to your repository (see [`examples/review-runner.yml`](examples/review-runner.yml)):

```yaml
name: PR Agent Runner

on:
  pull_request:
    types: [opened, synchronize, reopened]
  issue_comment:
    types: [created]

jobs:
  review:
    # Ignore non-PR comments, bot comments, and comments without the bot mention.
    if: >-
      github.event_name == 'pull_request' ||
      (github.event_name == 'issue_comment' &&
      github.event.issue.pull_request &&
      github.event.comment.user.type != 'Bot' &&
      contains(github.event.comment.body, vars.BOT_MENTION || '@opencode-review'))
    concurrency:
      group: opencode-review-${{ github.event.pull_request.number || github.event.issue.number }}
      cancel-in-progress: true
    permissions:
      contents: read
      pull-requests: write
      issues: write
    uses: makinosp/pr-agent-runner/.github/workflows/pr-review.yml@v0.2.0
    with:
      app-client-id: ${{ vars.APP_ID }}
      ocr-llm-url: ${{ vars.OCR_LLM_URL }}
      ocr-llm-model: ${{ vars.OCR_LLM_MODEL }}
      runner-ref: v0.2.0
      # Optional inputs (defaults shown):
      # ocr-llm-max-tokens: ${{ vars.OCR_LLM_MAX_TOKENS }}
      # ocr-use-anthropic: ${{ vars.OCR_LLM_USE_ANTHROPIC }}
      # ocr-llm-protocol: ${{ vars.OCR_LLM_PROTOCOL }}
      # ocr-language: ${{ vars.OCR_LANGUAGE || 'English' }}
      # compose-pr: ${{ vars.COMPOSE_PR }}
      # bot-mention: ${{ vars.BOT_MENTION || '@opencode-review' }}
    secrets:
      app-private-key: ${{ secrets.APP_PRIVATE_KEY }}
      ocr-llm-token: ${{ secrets.OCR_LLM_AUTH_TOKEN }}
```

## Bot commands

With the default mention `@opencode-review` (customize via the `bot-mention` input / `BOT_MENTION` variable):

| Comment                       | Behavior                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| `@opencode-review review`     | Re-run the review and post an updated review                                                  |
| `@opencode-review fix`        | Apply critical/high findings with suggestions on a `fix/<bot>-<PR#>` branch and open a fix PR |
| `@opencode-review <question>` | Chat about the PR and reply in the thread                                                     |

## Action inputs

| Input                           | Required | Default                    | Description                                                                                                             |
| ------------------------------- | -------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `app-client-id`                 | ✅       | —                          | GitHub App client ID                                                                                                    |
| `ocr-llm-url`                   | ✅       | —                          | LLM endpoint URL                                                                                                        |
| `ocr-llm-model`                 | ✅       | —                          | LLM model name                                                                                                          |
| `ocr-llm-max-tokens`            | —        | _(unset)_                  | LLM max tokens                                                                                                          |
| `ocr-use-anthropic`             | —        | _(unset)_                  | `"true"` for Anthropic protocol                                                                                         |
| `ocr-llm-protocol`              | —        | _(unset)_                  | `anthropic` \| `openai`                                                                                                 |
| `ocr-language`                  | —        | `English`                  | Review language                                                                                                         |
| `bot-mention`                   | —        | `@opencode-review`         | Mention trigger for comments                                                                                            |
| `compose-pr`                    | —        | `false`                    | `"true"` to compose/update PR title and body                                                                            |
| `sticky-summary`                | —        | `true`                     | Update the summary review body in place across runs                                                                     |
| `incremental`                   | —        | `true`                     | Skip inline comments that duplicate previously-posted bot comments (same line/range overlap or similar content)         |
| `incremental-overlap-threshold` | —        | `0.6`                      | IoU threshold in `(0, 1]` for multi-line duplicate detection                                                            |
| `content-based-deduplication`   | —        | `true`                     | Skip inline comments whose content matches a previously-posted bot comment on the same path, even when the lines differ |
| `content-similarity-threshold`  | —        | `0.8`                      | Jaccard similarity threshold in `(0, 1]` for same-path content duplicates                                               |
| `review-comment-batch-size`     | —        | `50`                       | Max inline comments per `createReview` call                                                                             |
| `route-severity-below`          | —        | _(unset)_                  | Route findings at-or-below this severity to the summary                                                                 |
| `route-categories`              | —        | _(unset)_                  | Comma-separated categories routed to the summary                                                                        |
| `ocr-version`                   | —        | `1.12.7`                   | OCR CLI version                                                                                                         |
| `runner-repository`             | —        | `makinosp/pr-agent-runner` | Repo hosting the runner CLI                                                                                             |
| `runner-ref`                    | —        | `main`                     | Ref of the runner repo used for the CLI                                                                                 |
| `node-version`                  | —        | `24`                       | Node.js version (**must be ≥ 24** — the CLI runs TS directly via type stripping)                                        |
| `pnpm-version`                  | —        | `11`                       | pnpm version                                                                                                            |
| `fetch-depth`                   | —        | `0`                        | Consumer repo checkout depth                                                                                            |
| `timeout-minutes`               | —        | `30`                       | Maximum minutes the review job may run before it is cancelled                                                           |

## Action secrets

| Secret            | Required | Description                                    |
| ----------------- | -------- | ---------------------------------------------- |
| `app-private-key` | ✅       | GitHub App private key (PEM) for token minting |
| `ocr-llm-token`   | ✅       | LLM API token used by OCR                      |

Secrets are passed through the calling job's `secrets:` block (for example `ocr-llm-token: ${{ secrets.OCR_LLM_AUTH_TOKEN }}`). The `with:` block cannot reference the `secrets` context, so tokens must never be passed as inputs.

## Review posting behavior

Findings are split into **inline comments** (RIGHT-side findings whose line range falls in the diff) and a **summary** (everything else, rendered into the review body). Posting is controlled by these inputs:

- **`sticky-summary`** — the review carrying the summary is located by its marker (`<!-- ocr-review-summary -->`) and its body is **updated in place** on subsequent runs instead of posting a fresh summary review. Inline comments always go to fresh reviews, because GitHub does not allow adding comments to an existing review. On the first run, body + comments are posted in a single review.
- **`incremental`** (on by default) — skips inline comments that duplicate comments the bot already posted. A comment is a duplicate when it targets the same path as a previous Bot-type comment **and** either:
  - its line span overlaps (same single line, or multi-line ranges whose intersection-over-union exceeds `incremental-overlap-threshold`), **or**
  - its content matches (with `content-based-deduplication`, normalized exact match or token Jaccard similarity at-or-above `content-similarity-threshold`), so the same concern is not re-posted even if the LLM reports it on a different line.
    Only comments from **Bot-type** users count as history (this is what GitHub App tokens post as); single-line vs. multi-line spans are never considered line-duplicates.
- **`review-comment-batch-size`** — maximum number of inline comments packed into one `createReview` call. Larger reviews are split deterministically (path → start line → end line → original order), so reruns produce identical batches and the summary travels on the first batch.
- **`route-severity-below` / `route-categories`** — route findings to the summary instead of inline: findings whose severity is at-or-below the configured severity (e.g. `low` routes `medium` and `low`) or whose category matches the comma-separated list. Routing is fail-open: unknown/empty values disable it and a finding is never dropped.

## Action outputs

| Output                | Description                            |
| --------------------- | -------------------------------------- |
| `comments_total`      | Total findings processed               |
| `comments_inline`     | Inline comments posted                 |
| `comments_skipped`    | Inline comments skipped as overlapping |
| `comments_routed`     | Findings routed to the summary         |
| `comments_failed`     | Comments that failed to post           |
| `summary_comment_url` | URL of the review carrying the summary |

## Limitations

- The workflow triggers on PR **`opened`**, **`synchronize`**, and **`reopened`**, and on created comments. Each PR event posts a fresh inline review; duplicate inline comments are suppressed by `incremental` (on by default) plus content-based dedup.
- **Sticky summaries live in the review body**, not a pinned issue comment: when new inline comments arrive, a fresh review is posted alongside and the summary review is updated — the timeline therefore keeps multiple reviews, and the summary is not pinned at the top of the conversation.
- **Incremental dedup is Bot-type based**: comments posted by a non-Bot user are never treated as duplicates, regardless of content. Content-based dedup compares posted bodies, so it cannot detect a duplicate concern that the LLM reworded entirely (different vocabulary).
- The standard `pull_request` workflow cannot use repository secrets for fork PRs. As a result, automatic reviews are supported for PRs from the same repository; supporting fork PRs requires a separate, security-reviewed `pull_request_target` design.
- The `runner-ref` input pins which version of the runner CLI is used; pin to a release tag for stability.

## License

This project is licensed under the [BSD 3-Clause License](LICENSE).
