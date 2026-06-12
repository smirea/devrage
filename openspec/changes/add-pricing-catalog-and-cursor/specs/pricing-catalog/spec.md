## ADDED Requirements

### Requirement: models.dev pricing catalog
The system MUST resolve token pricing from the first-party provider entries in `https://models.dev/api.json` when estimating API-equivalent costs.

#### Scenario: Resolve first-party OpenAI model pricing
- **WHEN** cost estimation needs pricing for provider `openai` and model `gpt-5.5`
- **THEN** the system MUST resolve the `openai.models.gpt-5.5.cost` entry from the models.dev catalog

#### Scenario: Resolve first-party Anthropic model pricing
- **WHEN** cost estimation needs pricing for provider `anthropic` and model `claude-opus-4-7`
- **THEN** the system MUST resolve the `anthropic.models.claude-opus-4-7.cost` entry from the models.dev catalog

### Requirement: aggressive local pricing cache
The system SHALL cache the downloaded models.dev catalog in a devrage-owned file and use cached data for normal scans without requiring a network request every run.

#### Scenario: Fresh cache is available
- **WHEN** `--cost` runs and the cache age is within the configured freshness window
- **THEN** the system MUST use the cached catalog without fetching models.dev

#### Scenario: Cache refresh succeeds
- **WHEN** `--cost` runs and the cache is stale or missing
- **THEN** the system MUST fetch models.dev, write the response to the cache file, and use the refreshed catalog

#### Scenario: Cache refresh fails with stale cache available
- **WHEN** models.dev cannot be fetched and a stale cache exists
- **THEN** the system MUST use the stale cache and mark pricing as stale in the cost summary metadata

#### Scenario: Cache refresh fails without cache
- **WHEN** models.dev cannot be fetched and no cache exists
- **THEN** the system MUST use an embedded fallback price table for known high-value models and mark unresolved models as unpriced

### Requirement: pricing cache control
The system SHALL provide a way to force a pricing catalog refresh without deleting cache files manually.

#### Scenario: User forces refresh
- **WHEN** the user runs `devrage scan --cost --refresh-prices`
- **THEN** the system MUST attempt to fetch models.dev regardless of cache freshness

### Requirement: model alias normalization
The system MUST normalize local model identifiers to models.dev provider/model keys before pricing.

#### Scenario: OpenCode model uses direct provider and model IDs
- **WHEN** an OpenCode usage row contains provider `openai` and model `gpt-5.5`
- **THEN** the pricing resolver MUST look up provider `openai` and model `gpt-5.5`

#### Scenario: Local model omits provider
- **WHEN** a usage row has no provider but the model name matches a known provider pattern such as `gpt-*` or `claude-*`
- **THEN** the pricing resolver MUST infer the provider before declaring the row unpriced

### Requirement: token price calculation
The system MUST calculate estimated cost from token categories using the resolved per-million-token prices.

#### Scenario: Cached input tokens are present
- **WHEN** usage includes cache-read input tokens and the model price includes `cache_read`
- **THEN** the system MUST price those tokens using `cache_read` instead of the normal input rate

#### Scenario: Reasoning tokens are present
- **WHEN** usage includes reasoning output tokens
- **THEN** the system MUST price reasoning output tokens with the model output rate unless a future catalog field provides a distinct reasoning rate

#### Scenario: Price is unavailable
- **WHEN** no catalog or fallback price is available for a usage row
- **THEN** the system MUST exclude that row from estimated cost and include it in the unpriced request count

### Requirement: billed cost remains visible
The system SHALL keep agent-stored billed cost separate from API-equivalent estimated cost.

#### Scenario: Stored billed cost differs from estimated cost
- **WHEN** OpenCode records `cost: 0` for subscription-backed `gpt-5.5` usage but token prices are available
- **THEN** the report MUST show a nonzero estimated cost and a separate OpenCode billed cost of zero for that model's contribution
