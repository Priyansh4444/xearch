# Implementation checks

## Collector acquisition and Effect 4

The HTTP client now exposes `fetchTimelinePageEffect` and `fetchProfileEffect`.
The existing Promise methods execute those programs for the pilot and probe
callers. `FxTwitterError` carries a tag and a `kind` discriminator:

- `transport`: network or response-body read failure, eligible for bounded retry.
- `http`: preserves status and body; only 429 and 5xx are retried.
- `decode`: malformed JSON or provider envelope; not retried.

Each execution owns its attempt counter. The retry policy preserves exponential
backoff and the bounded Retry-After override. Default retry waits use Effect's
interruptible sleep. Fetch combines Effect cancellation with the per-request
timeout. A custom sleep remains injectable for existing tests.

The acquisition tests cover retry exhaustion, permanent errors, malformed
responses, no-content and missing-profile outcomes, cancellation, Effect reuse,
and a real local HTTP connection returning 503 then success. These checks do not
prove the reliability of the live upstream provider.

## Tokenizer measurement

Criterion is a dev-only dependency. The benchmark runs the 12 existing shared
golden texts with an empty stopword set. It measures tokenizer CPU time, not disk
access, ingestion mutations, network throughput, or a representative corpus.

Commands from the repository root:

```sh
cargo +nightly-2026-08-28 bench --manifest-path indexer/Cargo.toml --bench tokenizer -- --save-baseline before-url-scan
# After changing the tokenizer:
cargo +nightly-2026-08-28 bench --manifest-path indexer/Cargo.toml --bench tokenizer -- --baseline before-url-scan
```

After the URL scan and checked-indexing changes, the batch estimate changed
from 28.469 µs to 8.1438 µs. Criterion reported a 72–75% time reduction. The URL scanner now
borrows UTF-8 suffixes and iterates characters instead of allocating prefix
vectors at each character. Batching, checkpoint order, and Convex writes remain
sequential and unchanged.

This gives a measured improvement without Rayon or a transport migration.
Parallel batching still needs a bounded implementation, serial-equivalence
tests, and corpus-scale measurements before adoption.

The new scanner intentionally preserves existing Rust behavior for bare URL
prefixes. There is a pre-existing mismatch: Rust strips a bare `https://` or
`www.`, whereas the TypeScript regex requires a non-whitespace suffix. The
shared goldens do not cover that case. Correcting it requires an explicit
tokenizer-version/reindex decision, not a silent performance refactor.

## Remaining gates

- Strict Clippy runs with warnings denied across all targets.
- The earlier authority and boost implementations need algorithm-specific tests;
  existing tokenizer/backfill tests do not validate them.
- React Doctor reports no issues after separating query orchestration into
  `useSearchPage` and pure result presentation into `presentResults`.
- The Effect migration is incomplete beyond config loading and acquisition.
- Live Convex deployment, browser interactions, corpus ingestion, and upstream
  collection have not been exercised in this pass.

The frontend build now uses the React Compiler Babel plugin supported by
`@vitejs/plugin-react` v5. The Vite config is included in frontend typechecking.
The previous `reactCompilerPreset` import belonged to a newer plugin API and
failed at build time despite the old typecheck passing.
