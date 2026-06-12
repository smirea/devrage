## Context

devrage currently has an experimental OpenCode-only `--cost` path that reads OpenCode's local SQLite database. OpenCode records a `cost` field, but that value is actual billed cost. For subscription-backed or provider-pass-through models such as `gpt-5.5`, OpenCode records `cost: 0` while still storing token usage. That makes the current report misleading if it sorts by stored cost or uses a small hardcoded rate table.

models.dev provides a machine-readable catalog at `https://models.dev/api.json` with first-party `openai` and `anthropic` model entries. Those entries include per-million-token `cost` fields such as `input`, `output`, `cache_read`, and `cache_write`, plus context-tier metadata for some models.

Cursor stores AI state in VS Code-style local storage. On macOS, the relevant roots are under `~/Library/Application Support/Cursor/User/globalStorage` and `~/Library/Application Support/Cursor/User/workspaceStorage/*`. The observed local databases contain `ItemTable` and `cursorDiskKV`, with candidate AI/composer keys including `composer.composerData`, `aiService.prompts`, `aiService.generations`, and `workbench.panel.composerChatViewPane.*`.

## Goals / Non-Goals

**Goals:**

- Make `--cost` estimate API-equivalent token spend using a real catalog, not hardcoded rates.
- Aggressively cache models.dev data so normal scans are fast and work offline.
- Keep agent-stored billed cost visible separately from estimated token-price cost.
- Add Cursor as a first-class adapter for profanity scans.
- Keep dependencies minimal and preserve current behavior for existing adapters.

**Non-Goals:**

- Do not implement billing-account reconciliation or subscription amortization.
- Do not guarantee perfect Cursor extraction for every historical Cursor schema in the first pass.
- Do not add a remote service or analytics collection.
- Do not require network access for non-cost scans.
- Do not add a test framework unless the implementation needs one beyond TypeScript validation and focused fixtures.

## Decisions

### Use models.dev as the primary pricing source

Use `https://models.dev/api.json` instead of scraping provider pricing pages. It has first-party provider sections for `openai` and `anthropic`, exact model IDs such as `gpt-5.5` and `claude-opus-4-7`, normalized per-million-token cost fields, and context-tier metadata.

Alternative considered: LiteLLM's `model_prices_and_context_window.json`. It is broad and battle-tested, but its schema uses per-token floats and aliases are noisier for this CLI. Keep it as a future fallback candidate if models.dev is unavailable or missing models.

Alternative considered: scraping OpenAI and Anthropic docs. This is more official but less stable and more brittle. Avoid it.

### Cache catalog files aggressively

Create a small pricing module with cache-path resolution and catalog loading. Use OS-appropriate cache roots:

- `$XDG_CACHE_HOME/devrage/models.dev.json` when `XDG_CACHE_HOME` is set.
- `~/Library/Caches/devrage/models.dev.json` on macOS.
- `%LOCALAPPDATA%/devrage/models.dev.json` on Windows when available.
- `~/.cache/devrage/models.dev.json` as a Unix fallback.

Cache payload should include metadata, not just raw catalog:

```ts
interface PricingCacheFile {
  source: "models.dev";
  fetchedAt: string;
  schemaVersion: 1;
  catalog: unknown;
}
```

Default behavior:

- Use cache without network when it is fresh.
- Treat cache as fresh for a long TTL, initially 7 days.
- If stale, try a short network refresh, initially a 2 second timeout.
- If refresh fails, use stale cache indefinitely and mark it stale.
- If no cache exists, use an embedded minimal fallback table for known high-impact models.

Add `--refresh-prices` to force refresh for users who want current rates immediately.

### Price individual usage records before aggregation

Move from grouped SQL totals to per-message usage records for OpenCode. Per-row pricing keeps timestamps, providers, models, token categories, and future context-tier handling accurate. The current OpenCode database has roughly tens of thousands of usage rows, which is small enough for in-process aggregation.

Usage record shape:

```ts
interface UsageRecord {
  agent: string;
  provider?: string;
  model?: string;
  timestamp?: string;
  session?: string;
  billedCost?: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
```

Adapters can expose `usage(options)` or `costSummary(options, pricing)`; prefer `usage(options)` plus a shared pricing aggregator so future adapters do not duplicate pricing logic.

### Preserve billed cost as a separate concept

`billedCost` is what the local tool says was charged. `estimatedCost` is API-equivalent token pricing. Reports should show both when they materially differ. This explains cases like OpenCode plus OpenAI subscription access where billed cost is zero but API-equivalent usage is nonzero.

### Normalize provider/model IDs centrally

Add a resolver that maps usage records to models.dev provider/model keys:

- Use explicit `providerID` and `modelID` fields when available.
- Infer `openai` for `gpt-*`, `o*` OpenAI-style names, and known OpenAI aliases.
- Infer `anthropic` for `claude-*` names.
- Preserve exact model IDs first; apply alias maps only when direct lookup fails.

OpenCode should query both top-level and nested model fields:

- `$.providerID`
- `$.modelID`
- `$.model.providerID`
- `$.model.modelID`

### Implement Cursor as a tolerant state-store adapter

Cursor storage has version variance and may contain metadata-only keys. The first implementation should separate discovery, extraction, and message yielding:

1. Discover Cursor roots per OS.
2. Find `state.vscdb` files in `globalStorage` and each `workspaceStorage/*` directory.
3. Open each SQLite DB read-only with `better-sqlite3`.
4. Read candidate keys from `ItemTable` and `cursorDiskKV`.
5. Parse JSON values only when valid.
6. Apply a small set of candidate extractors for known chat/composer structures.
7. Yield only objects confidently identified as user-authored messages.

Avoid dumping or logging message text during discovery errors. Skip unreadable stores quietly, matching existing adapter behavior.

## Risks / Trade-offs

- Pricing catalog availability -> Use stale cache indefinitely and embed fallback rates for known models.
- Pricing drift -> Show pricing source/freshness and support `--refresh-prices`.
- Context-tier precision -> Price per usage row and implement best-effort tier selection using available token counts; document if exact request context is unavailable.
- Double-counting cache tokens -> Keep token categories separate and apply provider catalog fields explicitly. Do not price cache reads at normal input rate when `cache_read` exists.
- Cursor schema churn -> Keep extraction schema-tolerant, add fixtures from observed schemas, and skip uncertain metadata to avoid false positives.
- SQLite native dependency -> Reuse existing `better-sqlite3`; if unavailable, skip SQLite-backed adapters with existing warning behavior.

## Migration Plan

1. Introduce pricing catalog/cache module without changing adapter behavior.
2. Convert OpenCode cost summary to shared usage-record pricing and verify current `gpt-5.5` estimate remains visible.
3. Add Cursor adapter behind normal adapter registration.
4. Update help text and exported types.
5. Run `npm run typecheck`, `npm run build`, touched-file lint/format, and representative CLI commands:
   - `node dist/cli.js scan --agent opencode --cost`
   - `node dist/cli.js scan --agent opencode --cost --since 2026-06-01`
   - `node dist/cli.js scan --agent cursor`
6. Leave existing full-repo lint cleanup out of scope unless required by touched files.

Rollback is straightforward: remove the new pricing module and Cursor adapter registration, then restore the previous OpenCode-only cost summary behavior.

## Open Questions

- Should the cache TTL be user-configurable via environment variable in the first implementation, or is `--refresh-prices` enough?
- Should reports show catalog freshness by default, or only when pricing is stale/fallback/unpriced?
- Which Cursor schemas should be fixture-backed first beyond the observed local keys?
