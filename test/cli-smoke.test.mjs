import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import Database from "better-sqlite3";

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repoRoot, "dist", "cli.js");
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

test("OpenCode cost uses cached models.dev pricing", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-opencode-"));
  const dataHome = join(root, "data");
  const cacheHome = join(root, "cache");
  const dbPath = join(dataHome, "opencode", "opencode.db");

  await mkdir(dirname(dbPath), { recursive: true });
  await writePricingCache(cacheHome);
  createOpenCodeFixture(dbPath);

  const output = stripAnsi(
    await runCli(["cost", "--agent", "opencode", "--since", "2026-06-01"], {
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
      XDG_DATA_HOME: dataHome,
    }),
  );

  assert.match(output, /devrage cost/);
  assert.match(output, /gpt-5\.5\s+\$35\.00/);
  assert.doesNotMatch(output, /billed/i);
});

test("cost command renders only the cost dashboard", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-cost-"));
  const dataHome = join(root, "data");
  const cacheHome = join(root, "cache");
  const dbPath = join(dataHome, "opencode", "opencode.db");

  await mkdir(dirname(dbPath), { recursive: true });
  await writePricingCache(cacheHome);
  createOpenCodeFixture(dbPath);

  const output = stripAnsi(
    await runCli(["cost", "--agent", "opencode", "--since", "2026-06-01"], {
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
      XDG_DATA_HOME: dataHome,
    }),
  );

  assert.match(output, /devrage cost/);
  assert.match(output, /\$35\.00/);
  assert.match(output, /1 req/);
  assert.match(output, /^  total$/m);
  assert.match(output, /models/);
  assert.match(output, /agents/);
  assert.match(output, /Report: file:\/\//);
  assert.match(output, /gpt-5\.5\s+\$35\.00/);
  assert.ok(output.indexOf("total") < output.indexOf("agents"));
  assert.ok(output.indexOf("agents") < output.indexOf("models"));
  assert.ok(output.indexOf("models") < output.indexOf("Report:"));
  assert.doesNotMatch(output, /daily/);
  assert.doesNotMatch(output, /estimated API-equivalent cost/);
  assert.doesNotMatch(output, /cost dashboard/);
  assert.doesNotMatch(output, /agent cost/);
  assert.doesNotMatch(output, /messages scanned/);
  assert.doesNotMatch(output, /total swears/);
  assert.doesNotMatch(output, /billed/i);
  assert.doesNotMatch(output, /agent language/);
  assert.doesNotMatch(output, /top words/);

  const report = await readReport(output);
  assert.match(report, /devrage cost report/);
  assert.match(report, /gpt-5\.5/);
  assert.match(report, /Daily/);
  assert.match(report, /bar-column/);
  assert.match(report, /column-fill/);
  assert.match(report, /data-tooltip/);
  assert.match(report, /id="tooltip"/);
  assert.doesNotMatch(report, /billed/i);
  assert.doesNotMatch(report, /bar-row/);
  assert.ok(report.indexOf("<h2>Agents</h2>") < report.indexOf("<h2>Models</h2>"));
  assert.ok(report.indexOf("<h2>Models</h2>") < report.indexOf("<h2>Daily</h2>"));
});

test("cost command has a cost-specific empty state", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-cost-empty-"));
  const cacheHome = join(root, "cache");

  await writePricingCache(cacheHome);

  const output = stripAnsi(
    await runCli(["cost", "--agent", "cursor"], {
      APPDATA: join(root, "appdata"),
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
    }),
  );

  assert.match(output, /devrage cost/);
  assert.match(output, /cursor/);
  assert.match(output, /no local usage found/);
  assert.doesNotMatch(output, /devrage report/);
  assert.doesNotMatch(output, /messages scanned/);
  assert.doesNotMatch(output, /total swears/);
  assert.doesNotMatch(output, /squeaky clean/);
});

test("cost command works when flags come before the subcommand", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-cost-before-flags-"));
  const cacheHome = join(root, "cache");

  await writePricingCache(cacheHome);

  const output = stripAnsi(
    await runCli(["--agent", "cursor", "cost"], {
      APPDATA: join(root, "appdata"),
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
    }),
  );

  assert.match(output, /devrage cost/);
  assert.match(output, /cursor/);
  assert.match(output, /no local usage found/);
  assert.doesNotMatch(output, /devrage report/);
  assert.doesNotMatch(output, /messages scanned/);
  assert.doesNotMatch(output, /squeaky clean/);
});

test("cost command caps terminal models to top 10", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-cost-model-cap-"));
  const dataHome = join(root, "data");
  const cacheHome = join(root, "cache");
  const dbPath = join(dataHome, "opencode", "opencode.db");
  const modelPricing = Object.fromEntries(
    Array.from({ length: 11 }, (_, index) => [
      `model-${String(index + 1).padStart(2, "0")}`,
      { cost: { input: 0, output: 1 } },
    ]),
  );

  await mkdir(dirname(dbPath), { recursive: true });
  await writePricingCache(cacheHome, modelPricing);
  createOpenCodeMultiModelFixture(dbPath);

  const output = stripAnsi(
    await runCli(["cost", "--agent", "opencode", "--since", "2026-06-01"], {
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
      XDG_DATA_HOME: dataHome,
    }),
  );

  assert.match(output, /model-10/);
  assert.doesNotMatch(output, /model-11/);

  const report = await readReport(output);
  assert.match(report, /model-11/);
});

test("cost range shortcuts default days to one day", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-cost-day-"));
  const dataHome = join(root, "data");
  const cacheHome = join(root, "cache");
  const dbPath = join(dataHome, "opencode", "opencode.db");

  await mkdir(dirname(dbPath), { recursive: true });
  await writePricingCache(cacheHome);
  createOpenCodeFixture(dbPath, Date.now());

  const dayOutput = stripAnsi(
    await runCli(["cost", "--agent", "opencode", "--day"], {
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
      XDG_DATA_HOME: dataHome,
    }),
  );
  const daysOutput = stripAnsi(
    await runCli(["cost", "--days", "--agent", "opencode"], {
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
      XDG_DATA_HOME: dataHome,
    }),
  );

  assert.match(dayOutput, /last 1 day/);
  assert.match(dayOutput, /\$35\.00/);
  assert.match(daysOutput, /last 1 day/);
  assert.match(daysOutput, /\$35\.00/);
});

test("cost range shortcuts accept explicit days", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-cost-days-"));
  const dataHome = join(root, "data");
  const cacheHome = join(root, "cache");
  const dbPath = join(dataHome, "opencode", "opencode.db");

  await mkdir(dirname(dbPath), { recursive: true });
  await writePricingCache(cacheHome);
  createOpenCodeFixture(dbPath, Date.now());

  const output = stripAnsi(
    await runCli(["cost", "--agent", "opencode", "--days", "3"], {
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
      XDG_DATA_HOME: dataHome,
    }),
  );

  assert.match(output, /last 3 days/);
  assert.match(output, /\$35\.00/);
});

test("cost range shortcuts include week and month", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-cost-week-month-"));
  const dataHome = join(root, "data");
  const cacheHome = join(root, "cache");
  const dbPath = join(dataHome, "opencode", "opencode.db");

  await mkdir(dirname(dbPath), { recursive: true });
  await writePricingCache(cacheHome);
  createOpenCodeFixture(dbPath, Date.now());

  const weekOutput = stripAnsi(
    await runCli(["cost", "--agent", "opencode", "--week"], {
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
      XDG_DATA_HOME: dataHome,
    }),
  );
  const monthOutput = stripAnsi(
    await runCli(["cost", "--agent", "opencode", "--month"], {
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
      XDG_DATA_HOME: dataHome,
    }),
  );

  assert.match(weekOutput, /last 7 days/);
  assert.match(weekOutput, /\$35\.00/);
  assert.match(monthOutput, /last 30 days/);
  assert.match(monthOutput, /\$35\.00/);
});

test("cost display floors dollar amounts to cents", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-cost-floor-"));
  const dataHome = join(root, "data");
  const cacheHome = join(root, "cache");
  const dbPath = join(dataHome, "opencode", "opencode.db");

  await mkdir(dirname(dbPath), { recursive: true });
  await writePricingCache(cacheHome);
  createOpenCodeFixture(dbPath, Date.now(), 1_000_333);

  const output = stripAnsi(
    await runCli(["cost", "--agent", "opencode", "--day"], {
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
      XDG_DATA_HOME: dataHome,
    }),
  );

  assert.match(output, /\$35\.00/);
  assert.doesNotMatch(output, /\$35\.01/);
});

test("Claude cost uses assistant usage once per streamed request", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-claude-"));
  const cacheHome = join(root, "cache");
  const sessionPath = join(root, ".claude", "projects", "fixture", "session.jsonl");

  await mkdir(dirname(sessionPath), { recursive: true });
  await writePricingCache(cacheHome);
  await writeFile(
    sessionPath,
    `${claudeUserLine()}\n${claudeAssistantLine()}\n${claudeAssistantLine()}\n`,
  );

  const output = stripAnsi(
    await runCli(["cost", "--agent", "claude"], {
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
    }),
  );

  assert.match(output, /claude\s+\$36\.75\s+1 req/);
  assert.match(output, /claude-opus-4-7\s+\$36\.75/);
});

test("Codex cost uses last token usage and skips non-billable updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-codex-"));
  const cacheHome = join(root, "cache");
  const sessionPath = join(root, ".codex", "sessions", "2026", "06", "02", "rollout-fixture.jsonl");

  await mkdir(dirname(sessionPath), { recursive: true });
  await writePricingCache(cacheHome);
  const actualUsage = codexUsage();
  const inflatedTotal = codexUsage({
    input_tokens: 11_100_000,
    cached_input_tokens: 10_100_000,
    total_tokens: 12_100_000,
  });
  const lines = [
    codexTurnContextLine(),
    codexUserLine(),
    codexTokenLine({ total: inflatedTotal, last: actualUsage }),
    codexTokenLine({ total: inflatedTotal, last: actualUsage }),
    codexTokenLine({
      timestamp: "2026-06-02T00:00:03.000Z",
      total: { total_tokens: 12_300_000 },
      last: { total_tokens: 200_000 },
    }),
  ];
  await writeFile(sessionPath, `${lines.join("\n")}\n`);

  const output = stripAnsi(
    await runCli(["cost", "--agent", "codex"], {
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
    }),
  );

  assert.match(output, /codex\s+\$35\.05\s+1 req/);
  assert.match(output, /gpt-5\.5\s+\$35\.05/);
});

test("Codex cost dedupes duplicate rollout files with the same session id", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-codex-rollbacks-"));
  const cacheHome = join(root, "cache");
  const sessionDir = join(root, ".codex", "sessions", "2026", "06", "02");
  const firstPath = join(
    sessionDir,
    "rollout-2026-06-02T00-00-00-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl",
  );
  const secondPath = join(
    sessionDir,
    "rollout-2026-06-02T00-00-03-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl",
  );
  const sessionId = "11111111-1111-1111-1111-111111111111";
  const lines = [
    codexSessionMetaLine(sessionId),
    codexTurnContextLine(),
    codexUserLine(),
    codexTokenLine(),
  ];

  await mkdir(sessionDir, { recursive: true });
  await writePricingCache(cacheHome);
  await writeFile(firstPath, `${lines.join("\n")}\n`);
  await writeFile(secondPath, `${lines.join("\n")}\n`);

  const output = stripAnsi(
    await runCli(["cost", "--agent", "codex"], {
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
    }),
  );

  assert.match(output, /codex\s+\$35\.05\s+1 req/);
  assert.match(output, /gpt-5\.5\s+\$35\.05/);
  assert.doesNotMatch(output, /\$70\.10/);
  assert.doesNotMatch(output, /2 req/);
});

test("Codex cost falls back to cumulative totals without last usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-codex-legacy-"));
  const cacheHome = join(root, "cache");
  const sessionPath = join(root, ".codex", "sessions", "2026", "06", "02", "rollout-fixture.jsonl");

  await mkdir(dirname(sessionPath), { recursive: true });
  await writePricingCache(cacheHome);
  await writeFile(
    sessionPath,
    `${[
      codexTurnContextLine(),
      codexUserLine(),
      codexTokenLine({ last: null }),
      codexTokenLine({ last: null }),
    ].join("\n")}\n`,
  );

  const output = stripAnsi(
    await runCli(["cost", "--agent", "codex"], {
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
    }),
  );

  assert.match(output, /codex\s+\$35\.05\s+1 req/);
  assert.match(output, /gpt-5\.5\s+\$35\.05/);
});

test("Amp cost reads nested usage ledger entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-amp-"));
  const dataHome = join(root, "data");
  const cacheHome = join(root, "cache");
  const threadPath = join(dataHome, "amp", "threads", "thread.json");

  await mkdir(dirname(threadPath), { recursive: true });
  await writePricingCache(cacheHome);
  await writeFile(threadPath, JSON.stringify(ampThreadFixture()));

  const output = stripAnsi(
    await runCli(["cost", "--agent", "amp"], {
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
      XDG_DATA_HOME: dataHome,
    }),
  );

  assert.match(output, /amp\s+\$35\.00\s+1 req/);
  assert.match(output, /gpt-5\.5\s+\$35\.00/);
});

test("Pi cost reads assistant usage from local sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-pi-"));
  const cacheHome = join(root, "cache");
  const sessionPath = join(root, ".pi", "agent", "sessions", "--fixture--", "session.jsonl");

  await mkdir(dirname(sessionPath), { recursive: true });
  await writePricingCache(cacheHome);
  await writeFile(sessionPath, piSessionFixture(Date.now()));

  const output = stripAnsi(
    await runCli(["cost", "--agent", "pi", "--day"], {
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
    }),
  );

  assert.match(output, /pi\s+\$35\.00\s+1 req/);
  assert.match(output, /gpt-5\.5\s+\$35\.00/);
});

test("Cursor scans user prompts and skips assistant-only state", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-cursor-"));
  const configHome = join(root, "config");
  const appData = join(root, "AppData", "Roaming");
  const cursorDirs = cursorUserDirs(root, configHome, appData);
  const statePath = join(
    cursorDirs.mac,
    "workspaceStorage",
    "ws",
    "state.vscdb",
  );

  await mkdir(dirname(statePath), { recursive: true });
  createCursorFixture(statePath);

  const output = stripAnsi(
    await runCli(["scan", "--agent", "cursor"], {
      APPDATA: appData,
      HOME: root,
      XDG_CONFIG_HOME: configHome,
    }),
  );

  assert.match(output, /messages scanned\s+3/);
  assert.match(output, /total swears\s+3/);
  assert.match(output, /fuck\s+1/);
  assert.match(output, /crap\s+2/);
  assert.doesNotMatch(output, /shit\s+1/);
});

test("Cursor discovers macOS, Linux, and Windows storage roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-cursor-roots-"));
  const configHome = join(root, "config");
  const appData = join(root, "AppData", "Roaming");
  const cursorDirs = cursorUserDirs(root, configHome, appData);

  for (const [platform, userDir] of Object.entries(cursorDirs)) {
    const statePath = join(userDir, "globalStorage", "state.vscdb");
    await mkdir(dirname(statePath), { recursive: true });
    createCursorPromptFixture(statePath, `${platform} fuck`);
  }

  const output = stripAnsi(
    await runCli(["scan", "--agent", "cursor"], {
      APPDATA: appData,
      HOME: root,
      XDG_CONFIG_HOME: configHome,
    }),
  );

  assert.match(output, /messages scanned\s+3/);
  assert.match(output, /total swears\s+3/);
  assert.match(output, /fuck\s+3/);
});

test("Cursor cost reads modern bubble token usage when present", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-cursor-cost-"));
  const cacheHome = join(root, "cache");
  const configHome = join(root, "config");
  const appData = join(root, "AppData", "Roaming");
  const cursorDirs = cursorUserDirs(root, configHome, appData);
  const statePath = join(cursorDirs.linux, "globalStorage", "state.vscdb");

  await mkdir(dirname(statePath), { recursive: true });
  await writePricingCache(cacheHome);
  createCursorCostFixture(statePath);

  const output = stripAnsi(
    await runCli(["cost", "--agent", "cursor", "--since", "2026-06-01"], {
      APPDATA: appData,
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
      XDG_CONFIG_HOME: configHome,
    }),
  );

  assert.match(output, /cursor\s+\$35\.00\s+1 req/);
  assert.match(output, /gpt-5\.5\s+\$35\.00/);
});

async function runCli(args, env) {
  const result = await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  return result.stdout;
}

async function readReport(output) {
  const match = output.match(/Report:\s+(file:\/\/\S+)/);
  assert.ok(match, "expected report file URL in cost output");
  assert.match(
    match[1],
    /cost-report-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.html$/,
  );
  return readFile(fileURLToPath(match[1]), "utf-8");
}

async function writePricingCache(cacheHome, extraOpenAiModels = {}) {
  const cacheDir = join(cacheHome, "devrage");
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    join(cacheDir, "models.dev.json"),
    `${JSON.stringify({
      source: "models.dev",
      fetchedAt: new Date().toISOString(),
      schemaVersion: 1,
      catalog: {
        openai: {
          models: {
            "gpt-5.5": { cost: { input: 5, output: 30, cache_read: 0.5 } },
            ...extraOpenAiModels,
          },
        },
        anthropic: {
          models: {
            "claude-opus-4-7": {
              cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
            },
          },
        },
      },
    })}\n`,
  );
}

function claudeUserLine() {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: "hello" },
    timestamp: "2026-06-02T00:00:00.000Z",
  });
}

function claudeAssistantLine() {
  return JSON.stringify({
    type: "assistant",
    requestId: "req-1",
    timestamp: "2026-06-02T00:00:01.000Z",
    message: {
      id: "msg-1",
      role: "assistant",
      model: "claude-opus-4-7",
      usage: {
        input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      },
    },
  });
}

function codexTurnContextLine() {
  return JSON.stringify({
    timestamp: "2026-06-02T00:00:00.000Z",
    type: "turn_context",
    payload: { model: "gpt-5.5" },
  });
}

function codexSessionMetaLine(id) {
  return JSON.stringify({
    timestamp: "2026-06-02T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id,
      timestamp: "2026-06-02T00:00:00.000Z",
      cwd: "/fixture",
      originator: "codex-tui",
      cli_version: "0.120.0",
      source: "cli",
      model_provider: "openai",
    },
  });
}

function codexUserLine() {
  return JSON.stringify({
    timestamp: "2026-06-02T00:00:01.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    },
  });
}

function codexUsage(overrides = {}) {
  return {
    input_tokens: 1_100_000,
    cached_input_tokens: 100_000,
    output_tokens: 1_000_000,
    reasoning_output_tokens: 500_000,
    total_tokens: 2_100_000,
    ...overrides,
  };
}

function codexTokenLine(options = {}) {
  const timestamp = options.timestamp ?? "2026-06-02T00:00:02.000Z";
  const total = Object.hasOwn(options, "total") ? options.total : codexUsage();
  const last = Object.hasOwn(options, "last") ? options.last : codexUsage();
  const info = {};

  if (total !== null) {
    info.total_token_usage = total;
  }
  if (last !== null) {
    info.last_token_usage = last;
  }

  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info,
    },
  });
}

function ampThreadFixture() {
  return {
    messages: [{ role: "user", content: "hello", timestamp: "2026-06-02T00:00:00.000Z" }],
    usageLedger: {
      entries: [
        {
          provider: "openai",
          model: "gpt-5.5",
          timestamp: "2026-06-02T00:00:01.000Z",
          usage: {
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
          },
        },
      ],
    },
  };
}

function piSessionFixture(timestamp) {
  const iso = new Date(timestamp).toISOString();
  return `${JSON.stringify({
    type: "session",
    id: "session-1",
    timestamp: iso,
    cwd: "/fixture",
  })}\n${JSON.stringify({
    type: "message",
    id: "user-1",
    parentId: null,
    timestamp: iso,
    message: {
      role: "user",
      content: "hello",
      timestamp,
    },
  })}\n${JSON.stringify({
    type: "message",
    id: "assistant-1",
    parentId: "user-1",
    timestamp: iso,
    message: {
      role: "assistant",
      provider: "openrouter",
      model: "auto",
      responseModel: "openai/gpt-5.5",
      content: [{ type: "text", text: "done" }],
      timestamp,
      usage: {
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2_000_000,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
    },
  })}\n`;
}

function createOpenCodeFixture(
  dbPath,
  timestamp = Date.parse("2026-06-02T00:00:00.000Z"),
  outputTokens = 1_000_000,
) {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        data TEXT
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        session_id TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        data TEXT
      );
    `);

    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
      "user-1",
      "session-1",
      timestamp,
      timestamp,
      JSON.stringify({ role: "user" }),
    );
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
      "part-1",
      "user-1",
      "session-1",
      timestamp,
      timestamp,
      JSON.stringify({ type: "text", text: "please fix this" }),
    );
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
      "assistant-1",
      "session-1",
      timestamp,
      timestamp,
      JSON.stringify({
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5.5",
        cost: 0,
        tokens: { input: 1_000_000, output: outputTokens, cache: { read: 0, write: 0 } },
      }),
    );
  } finally {
    db.close();
  }
}

function createOpenCodeMultiModelFixture(
  dbPath,
  timestamp = Date.parse("2026-06-02T00:00:00.000Z"),
) {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        data TEXT
      );
    `);

    const insertMessage = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
    for (let index = 0; index < 11; index++) {
      const rank = index + 1;
      insertMessage.run(
        `assistant-${rank}`,
        "session-1",
        timestamp + index,
        timestamp + index,
        JSON.stringify({
          role: "assistant",
          providerID: "openai",
          modelID: `model-${String(rank).padStart(2, "0")}`,
          cost: 0,
          tokens: { input: 0, output: 12_000_000 - rank * 1_000_000 },
        }),
      );
    }
  } finally {
    db.close();
  }
}

function cursorUserDirs(home, configHome, appData) {
  return {
    mac: join(home, "Library", "Application Support", "Cursor", "User"),
    linux: join(configHome, "Cursor", "User"),
    windows: join(appData, "Cursor", "User"),
  };
}

function createCursorFixture(dbPath) {
  const db = new Database(dbPath);
  try {
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)");
    db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run(
      "composer.composerData",
      JSON.stringify({
        composerId: "composer-1",
        messages: [
          { role: "user", content: "this is crap", timestamp: "2026-06-02T00:00:00.000Z" },
          { role: "assistant", content: "assistant says shit" },
        ],
      }),
    );
    db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run(
      "aiService.prompts",
      JSON.stringify("please fix this fuck"),
    );
    db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run(
      "composerData:composer-1",
      JSON.stringify({
        composerId: "composer-1",
        modelConfig: { modelName: "gpt-5.5" },
      }),
    );
    db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run(
      "bubbleId:composer-1:user-1",
      JSON.stringify({
        type: 1,
        bubbleId: "user-1",
        text: "modern cursor crap",
        createdAt: "2026-06-02T00:00:02.000Z",
        tokenCount: { inputTokens: 0, outputTokens: 0 },
      }),
    );
    db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run(
      "bubbleId:composer-1:assistant-1",
      JSON.stringify({
        type: 2,
        bubbleId: "assistant-1",
        text: "assistant says shit",
        createdAt: "2026-06-02T00:00:03.000Z",
        tokenCount: { inputTokens: 0, outputTokens: 0 },
      }),
    );
  } finally {
    db.close();
  }
}

function createCursorPromptFixture(dbPath, text) {
  const db = new Database(dbPath);
  try {
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
    db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run(
      "aiService.prompts",
      JSON.stringify(text),
    );
  } finally {
    db.close();
  }
}

function createCursorCostFixture(dbPath) {
  const db = new Database(dbPath);
  try {
    db.exec("CREATE TABLE cursorDiskKV (key TEXT, value BLOB)");
    db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run(
      null,
      JSON.stringify({ ignored: true }),
    );
    db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run(
      "composerData:composer-1",
      JSON.stringify({
        composerId: "composer-1",
        modelConfig: { modelName: "gpt-5.5" },
      }),
    );
    db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run(
      "bubbleId:composer-1:assistant-1",
      JSON.stringify({
        type: 2,
        bubbleId: "assistant-1",
        text: "done",
        createdAt: "2026-06-02T00:00:03.000Z",
        tokenCount: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      }),
    );
  } finally {
    db.close();
  }
}

function stripAnsi(value) {
  return value.replace(ANSI_PATTERN, "").replace(/\r/g, "");
}
