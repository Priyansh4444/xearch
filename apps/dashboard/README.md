# Dashboard

Read-only Cloudflare Worker that shows collection pilot runs from the `xearch-runs` R2 bucket: live runs (pushed while `pnpm collect:pilot` is acquiring) and archived runs (mirrored by `pnpm collect:sync`), their progress, acceptance, normalization counts, smoke thresholds, and how much data each holds.

- `/` server-rendered HTML, refreshes every 60s
- `/api/runs` the same data as JSON

It only ever reads `<run-id>/manifest.json`, `<run-id>/report.json`, and `_live/<run-id>/{manifest,report}.json`, plus a bucket listing for the object/byte total. Raw pages are never loaded. There are no npm dependencies; wrangler bundles `src/index.ts` directly.

## Deploy

```sh
cd apps/dashboard
wrangler deploy          # needs `wrangler login` once; binding xearch_runs -> bucket xearch-runs
```

Typecheck from the repo root with `node_modules/.bin/tsc -p apps/dashboard/tsconfig.json` (uses the root TypeScript install; R2 types are declared inline in `src/index.ts`).

Deployed at https://xearch-dashboard.pcstyle.workers.dev

## How status gets there

- Archived runs: `pnpm collect:sync` mirrors `data/old/<run-id>/` to `<run-id>/` in the bucket (`apps/collector/scripts/sync-runs.sh`).
- Live runs: `pnpm collect:push-status` copies `data/runs/*/manifest.json` (and `report.json` if present) to `_live/<run-id>/` (`apps/collector/scripts/push-status.sh`). It snapshots the files before upload because the collector rewrites the manifest continuously. Both scripts read credentials from `.env.r2` at the repo root; the Worker itself uses the R2 binding and holds no keys.

While a run is active, push every minute:

```sh
while pnpm collect:push-status; do sleep 60; done
```

`_live/<run-id>/` is never deleted by the scripts; after a run is archived the last live snapshot stays next to the archived copy. Remove it manually with `wrangler r2 object delete` if you want it gone.
