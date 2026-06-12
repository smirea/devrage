## 1. Pricing Catalog Infrastructure

- [x] 1.1 Add a pricing catalog module that resolves the devrage cache path across macOS, Linux, and Windows.
- [x] 1.2 Implement models.dev fetch with timeout, JSON validation, cache write, and cache metadata.
- [x] 1.3 Implement stale-cache fallback and embedded fallback rates for high-value OpenAI and Anthropic models.
- [x] 1.4 Add `--refresh-prices` parsing and pass the refresh option into cost estimation.

## 2. Shared Cost Estimation

- [x] 2.1 Add a shared `UsageRecord` type and pricing aggregator that produces per-agent and per-model summaries.
- [x] 2.2 Implement provider/model normalization for OpenCode model IDs and common OpenAI/Anthropic aliases.
- [x] 2.3 Apply models.dev `input`, `output`, `cache_read`, and `cache_write` rates to token categories without double-counting.
- [x] 2.4 Preserve and report agent-stored billed cost separately from API-equivalent estimated cost.
- [x] 2.5 Include pricing source and freshness in summaries for catalog, stale catalog, fallback, stored-only, and unknown pricing.

## 3. OpenCode Cost Integration

- [x] 3.1 Change OpenCode cost extraction from grouped SQL totals to per-message usage records.
- [x] 3.2 Query provider ID, model ID, timestamp, billed cost, and token categories from OpenCode message JSON.
- [x] 3.3 Apply `--since` to OpenCode usage rows before aggregation.
- [x] 3.4 Verify subscription-backed `gpt-5.5` rows produce nonzero estimated cost while billed cost remains zero.

## 4. Cursor Adapter

- [x] 4.1 Add `src/adapters/cursor.ts` with OS-specific Cursor user-data root discovery.
- [x] 4.2 Discover global and workspace `state.vscdb` files and read `ItemTable` plus `cursorDiskKV` candidate keys read-only.
- [x] 4.3 Implement schema-tolerant JSON extractors for `composer.composerData`, `aiService.prompts`, `aiService.generations`, and `workbench.panel.composerChatViewPane.*`.
- [x] 4.4 Yield only confident user-authored messages with session/workspace context and timestamps when available.
- [x] 4.5 Register the Cursor adapter and update scan help text to include `cursor`.

## 5. Verification

- [x] 5.1 Run `npm run typecheck`.
- [x] 5.2 Run `npm run build`.
- [x] 5.3 Run touched-file lint and format checks.
- [x] 5.4 Run `node dist/cli.js scan --agent opencode --cost` and confirm `gpt-5.5` appears in the cost breakdown when present.
- [x] 5.5 Run `node dist/cli.js scan --agent opencode --cost --since 2026-06-01` and confirm cost filtering applies.
- [x] 5.6 Run `node dist/cli.js scan --agent cursor` and confirm Cursor is skipped cleanly when no messages are extractable or reports messages when fixtures/local storage provide them.
- [x] 5.7 Run `npm test` fixture coverage for OpenCode pricing and Cursor extraction.
