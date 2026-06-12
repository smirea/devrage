## ADDED Requirements

### Requirement: adapter usage records
The system SHALL allow adapters to expose usage records independently from user-message records.

#### Scenario: Adapter supports usage records
- **WHEN** an adapter implements usage reporting
- **THEN** `devrage scan --cost` MUST consume those records to build cost summaries

#### Scenario: Adapter does not support usage records
- **WHEN** an adapter does not implement usage reporting
- **THEN** `devrage scan --cost` MUST continue scanning messages and report cost as unavailable for that adapter

### Requirement: OpenCode per-message usage pricing
The system MUST estimate OpenCode cost from individual message usage rows rather than only grouped model totals.

#### Scenario: OpenCode usage rows exist
- **WHEN** OpenCode message rows contain `modelID`, `providerID`, `tokens`, and `cost`
- **THEN** the system MUST read per-row token categories, price each row, and aggregate by agent and model

#### Scenario: Context-tier pricing applies
- **WHEN** a pricing catalog entry includes context-dependent tiers and an individual usage row crosses a tier threshold
- **THEN** the system MUST apply the tier to that row before aggregation

### Requirement: cost report confidence
The system SHALL make pricing confidence visible enough to explain estimate quality.

#### Scenario: Estimated from catalog
- **WHEN** a model is priced from a fresh or stale models.dev catalog
- **THEN** the model breakdown MUST identify the price source as catalog-estimated

#### Scenario: Estimated from fallback table
- **WHEN** a model is priced from the embedded fallback table
- **THEN** the model breakdown MUST identify the price source as fallback-estimated

#### Scenario: Unpriced rows exist
- **WHEN** one or more usage rows cannot be priced
- **THEN** the report MUST show the count of unpriced requests and list the highest-volume unpriced models

### Requirement: since filtering for cost records
The system MUST apply `--since` consistently to message scans and cost summaries.

#### Scenario: Since filter is provided
- **WHEN** the user runs `devrage scan --agent opencode --cost --since 2026-06-01`
- **THEN** the cost summary MUST include only usage records with timestamps on or after the provided date
