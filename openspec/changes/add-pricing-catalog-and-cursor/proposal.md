## Why

The experimental `--cost` output currently mixes OpenCode's stored billed cost with hardcoded token-price estimates, so subscription-backed models such as `gpt-5.5` can be hidden or mispriced. devrage also lacks Cursor support even though Cursor stores AI/composer state locally in VS Code-style storage.

## What Changes

- Replace hardcoded model rates with a `models.dev` pricing catalog client that caches pricing data aggressively on disk and falls back safely when offline.
- Change cost estimation to price usage from per-message token counts with provider/model-specific rates while still reporting any agent-stored billed cost separately.
- Add a Cursor adapter that discovers Cursor workspace/global state databases and extracts user-authored AI/composer prompts for profanity scanning.
- Add CLI/help support for `--agent cursor` and ensure Cursor participates in all-agent scans.
- Keep the feature dependency-light: use Node built-ins and existing `better-sqlite3` only.

## Capabilities

### New Capabilities

- `pricing-catalog`: Resolves model token prices from `models.dev`, maintains a local cache, and provides offline fallback behavior for cost estimation.
- `agent-cost-estimation`: Estimates API-equivalent token cost from local agent usage records and reports pricing/billing confidence clearly.
- `cursor-session-scanning`: Discovers Cursor local AI session storage and yields user-authored messages through the adapter interface.

### Modified Capabilities

- None.

## Impact

- Affected code: `src/adapters/index.ts`, `src/adapters/opencode.ts`, new pricing module(s), new `src/adapters/cursor.ts`, and `src/commands/scan.ts`.
- Runtime data access: reads `models.dev` over HTTPS when refreshing prices; reads/writes a devrage-owned pricing cache under the user's cache directory.
- Local storage access: reads Cursor SQLite state databases in Cursor's user data directory.
- CLI behavior: `devrage scan --cost` reports API-equivalent estimated cost separately from stored billed cost; `--agent cursor` becomes valid.
