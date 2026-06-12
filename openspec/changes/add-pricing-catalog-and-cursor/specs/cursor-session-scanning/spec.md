## ADDED Requirements

### Requirement: Cursor adapter registration
The system SHALL support Cursor as a first-class scan adapter.

#### Scenario: User selects Cursor explicitly
- **WHEN** the user runs `devrage scan --agent cursor`
- **THEN** the system MUST create the Cursor adapter and scan Cursor messages only

#### Scenario: User scans all agents
- **WHEN** the user runs `devrage scan` without `--agent`
- **THEN** the system MUST include Cursor in the adapter list

#### Scenario: User asks for help
- **WHEN** the user runs `devrage scan --help`
- **THEN** the help text MUST list `cursor` as an available agent

### Requirement: Cursor local storage discovery
The Cursor adapter MUST discover Cursor's local state stores across supported operating systems.

#### Scenario: macOS Cursor storage exists
- **WHEN** Cursor storage exists under `~/Library/Application Support/Cursor/User`
- **THEN** the adapter MUST inspect global and workspace state databases beneath that directory

#### Scenario: Linux Cursor storage exists
- **WHEN** Cursor storage exists under `$XDG_CONFIG_HOME/Cursor/User` or `~/.config/Cursor/User`
- **THEN** the adapter MUST inspect global and workspace state databases beneath that directory

#### Scenario: Windows Cursor storage exists
- **WHEN** Cursor storage exists under `%APPDATA%/Cursor/User`
- **THEN** the adapter MUST inspect global and workspace state databases beneath that directory

### Requirement: Cursor message extraction
The Cursor adapter SHALL extract user-authored AI/composer prompts from Cursor state databases while avoiding non-message state.

#### Scenario: Composer data contains user messages
- **WHEN** a Cursor workspace `state.vscdb` stores user-authored composer messages
- **THEN** the adapter MUST yield each non-empty user message with session/workspace context when available

#### Scenario: Cursor state contains only metadata
- **WHEN** Cursor keys such as `composer.composerData` contain only metadata and no user-authored message text
- **THEN** the adapter MUST skip that content without yielding false messages

#### Scenario: Cursor schema varies by version
- **WHEN** Cursor stores chat data under recognized keys such as `composer.composerData`, `aiService.prompts`, `aiService.generations`, or `workbench.panel.composerChatViewPane.*`
- **THEN** the adapter MUST use schema-tolerant JSON traversal and candidate extractors instead of assuming one fixed JSON shape

### Requirement: Cursor since filtering
The Cursor adapter SHALL apply `--since` to messages when reliable timestamps are available.

#### Scenario: Cursor message has timestamp
- **WHEN** a Cursor user message has a parseable timestamp before the `--since` date
- **THEN** the adapter MUST skip that message

#### Scenario: Cursor message has no timestamp
- **WHEN** a Cursor user message has no reliable timestamp
- **THEN** the adapter MUST follow existing adapter behavior and include the message rather than silently dropping it

### Requirement: Cursor storage failure handling
The Cursor adapter MUST fail soft when Cursor is absent or a database cannot be read.

#### Scenario: Cursor is not installed
- **WHEN** no Cursor storage directory exists
- **THEN** the adapter MUST yield no messages and avoid printing warnings

#### Scenario: Cursor database is locked or malformed
- **WHEN** an individual Cursor database cannot be opened or parsed
- **THEN** the adapter MUST skip that database and continue scanning other Cursor stores
