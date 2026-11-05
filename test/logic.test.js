import { test } from "node:test";
import assert from "node:assert/strict";
import { clean, label, sessionPids, sessionIdOf, agentInfo, rateLimits, modelWeekly, fmtTokens, fmtLeft, level, tier } from "../mods/claude-usage/logic.js";

const feed = {
  session_id: "s1",
  session_name: "Fix login",
  effort: { level: "high" },
  model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
  cost: { total_cost_usd: 1.35 },
  context_window: {
    total_input_tokens: 92412,
    context_window_size: 1000000,
    current_usage: { input_tokens: 2, cache_creation_input_tokens: 283, cache_read_input_tokens: 92127 },
    used_percentage: 9,
  },
  fast_mode: false,
  rate_limits: { five_hour: { used_percentage: 28, resets_at: 2000 }, seven_day: { used_percentage: 40, resets_at: 9000 } },
};

test("label: a named tab, else the cleaned title, else the space", () => {
  const a = { tab: "t1", title: "✳ Fix login", space_name: "app" };
  assert.equal(label(a, { t1: { named: true, name: "review" } }), "review");
  assert.equal(label(a, {}), "Fix login");
  assert.equal(label({ ...a, title: "✳ " }, {}), "app");
  assert.equal(clean("⠂ hi"), "hi");
});

test("sessionPids: local agents with a foreground pid", () => {
  const list = [{ address: "a" }, { address: "b" }, { address: "m/c" }];
  const terms = [{ address: "a", foreground: { pid: 10 } }, { address: "b" }, { address: "m/c", foreground: { pid: 11 } }];
  assert.deepEqual(sessionPids(list, terms), [["a", 10]]);
});

test("sessionIdOf reads Claude Code's session file", () => {
  assert.equal(sessionIdOf('{"sessionId":"abc","pid":1}'), "abc");
  assert.equal(sessionIdOf("{}"), null);
  assert.equal(sessionIdOf("not json"), null);
  assert.equal(sessionIdOf(null), null);
});

test("agentInfo: model, effort and context from the status line input", () => {
  assert.deepEqual(agentInfo(JSON.stringify(feed)), {
    model: "Opus 5.5",
    effort: "high",
    fast: false,
    ctxPct: 9,
    ctxTokens: 92412,
    ctxSize: 1000000,
    cost: 1.35,
    name: "Fix login",
  });
  assert.equal(agentInfo(null), null);
  assert.equal(agentInfo("{"), null);
});

test("agentInfo: sums current_usage without total_input_tokens, and tolerates missing fields", () => {
  const cw = { current_usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 } };
  assert.equal(agentInfo(JSON.stringify({ context_window: cw })).ctxTokens, 60);
  const bare = agentInfo("{}");
  assert.equal(bare.model, null);
  assert.equal(bare.effort, null);
  assert.equal(bare.ctxPct, null);
  assert.equal(bare.ctxTokens, null);
});

test("rateLimits: percent and reset time in ms; a window that reset reads 0%", () => {
  const text = JSON.stringify(feed);
  assert.deepEqual(rateLimits(text, 1000_000), { five: { pct: 28, resetsAt: 2000_000 }, seven: { pct: 40, resetsAt: 9000_000 } });
  assert.deepEqual(rateLimits(text, 3000_000).five, { pct: 0, resetsAt: null });
  assert.deepEqual(rateLimits("{}", 0), { five: null, seven: null });
  assert.deepEqual(rateLimits(null, 0), { five: null, seven: null });
});

test("modelWeekly: a model's weekly limit from the usage endpoint", () => {
  const usage = JSON.stringify({
    limits: [
      { kind: "five_hour", percent: 50 },
      { kind: "weekly_scoped", percent: 12, resets_at: "2026-11-08T00:59:59.443+00:00", scope: { model: { display_name: "Fable 5.1" } } },
    ],
  });
  const now = Date.parse("2026-11-05T00:00:00Z");
  assert.deepEqual(modelWeekly(usage, "fable", now), { pct: 12, resetsAt: Date.parse("2026-11-08T00:59:59.443Z") });
  assert.equal(modelWeekly(usage, "opus", now), null);
  assert.deepEqual(modelWeekly(usage, "fable", Date.parse("2026-11-09T00:00:00Z")), { pct: 0, resetsAt: null });
  // The endpoint answers errors in the same file when rate limited.
  assert.equal(modelWeekly('{"error":{"type":"rate_limit_error"}}', "fable", now), null);
});

test("fmtTokens and fmtLeft", () => {
  assert.equal(fmtTokens(950), "950");
  assert.equal(fmtTokens(4322), "4.3K");
  assert.equal(fmtTokens(200000), "200K");
  assert.equal(fmtTokens(1200000), "1.2M");
  const h = 3600_000;
  assert.equal(fmtLeft(0, 1), "now");
  assert.equal(fmtLeft(45 * 60_000, 0), "45m");
  assert.equal(fmtLeft(4 * h + 13 * 60_000, 0), "4h13m");
  assert.equal(fmtLeft(51 * h, 0), "2d3h");
});

test("level and tier", () => {
  assert.deepEqual([0, 49, 50, 75, 90, 100].map(level), [0, 0, 1, 2, 3, 3]);
  assert.equal(tier("Opus 5.5"), "opus");
  assert.equal(tier("Sonnet 5.5"), "sonnet");
  assert.equal(tier("Haiku 5.5"), "haiku");
  assert.equal(tier("Fable 5.1"), "other");
  assert.equal(tier(null), "other");
});
