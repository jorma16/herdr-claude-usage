import { test } from "node:test";
import assert from "node:assert/strict";
import { clean, label, sessionPids, sessionIdOf, agentInfo, rateLimits, modelWeekly, modelShare, extraUsage, pace, fitLevel, limitAlerts, pickAlert, fmtTokens, fmtCost, fmtDuration, shortPath, fmtLeft, fmtWhen, level, tier, family } from "../mods/claude-usage/logic.js";

const feed = {
  session_id: "s1",
  session_name: "Fix login",
  effort: { level: "high" },
  model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
  cost: { total_cost_usd: 1.35, total_duration_ms: 754000, total_api_duration_ms: 120000, total_lines_added: 12, total_lines_removed: 3 },
  cwd: "/home/me/other",
  workspace: { current_dir: "/home/me/app" },
  version: "2.1.318",
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
    modelId: "claude-opus-5-5",
    cwd: "/home/me/app",
    version: "2.1.318",
    durationMs: 754000,
    apiMs: 120000,
    linesAdded: 12,
    linesRemoved: 3,
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

test("modelShare: how much of the weekly limit a model may use", () => {
  const usage = JSON.stringify({
    limits: [
      { kind: "session", percent: 18 },
      { kind: "weekly_all", percent: 17 },
      { kind: "weekly_scoped", percent: 0, scope: { model: { display_name: "Fable" } } },
    ],
    weekly_scoped_shares: [{ limit_index: 2, used_percent_of_weekly: 0, allowance_percent_of_weekly: 50 }],
  });
  assert.equal(modelShare(usage, "fable"), 50);
  assert.equal(modelShare(usage, "opus"), null);
  assert.equal(modelShare('{"limits":[]}', "fable"), null);
  assert.equal(modelShare(null, "fable"), null);
});

test("extraUsage", () => {
  assert.deepEqual(extraUsage(JSON.stringify({ extra_usage: { is_enabled: false }, spend: { used: { amount_minor: 1250, currency: "EUR", exponent: 2 } } })),
    { enabled: false, used: { amount: 12.5, currency: "EUR" } });
  assert.deepEqual(extraUsage(JSON.stringify({ extra_usage: { is_enabled: true } })), { enabled: true, used: null });
  assert.equal(extraUsage('{"limits":[]}'), null);
});

test("pace: where a limit is heading at its current rate", () => {
  const H = 3600000;
  const resetsAt = 10 * H;
  // 5-hour window from 5h to 10h; at 7h, 40% of it has gone.
  const p = pace({ pct: 20, resetsAt }, 5 * H, 7 * H);
  assert.ok(Math.abs(p.elapsedPct - 40) < 1e-9);
  assert.ok(Math.abs(p.projected - 50) < 1e-9);
  assert.equal(p.fullAt, null);
  // 60% used at 40% of the window: full at 2/3 of it, before the reset.
  const q = pace({ pct: 60, resetsAt }, 5 * H, 7 * H);
  assert.ok(Math.abs(q.projected - 150) < 1e-9);
  assert.ok(Math.abs(q.fullAt - (5 * H + (10 * H) / 3)) < 1);
  // Nothing used: no full time.
  assert.equal(pace({ pct: 0, resetsAt }, 5 * H, 7 * H).fullAt, null);
  // Too early, outside the window, or without a reset time.
  assert.equal(pace({ pct: 5, resetsAt }, 5 * H, 5.1 * H), null);
  assert.equal(pace({ pct: 5, resetsAt }, 5 * H, 11 * H), null);
  assert.equal(pace({ pct: 5, resetsAt: null }, 5 * H, 7 * H), null);
});

test("fitLevel: the fullest layout that fits", () => {
  assert.equal(fitLevel({}, 400, 3), 0); // nothing measured: try the fullest
  assert.equal(fitLevel({ 0: 420 }, 400, 3), 1); // too wide: try the next
  assert.equal(fitLevel({ 0: 420, 1: 380 }, 400, 3), 1);
  assert.equal(fitLevel({ 0: 420, 1: 380 }, 450, 3), 0); // room again: back to the fullest
  assert.equal(fitLevel({ 0: 420, 1: 410, 2: 405 }, 400, 3), 2); // nothing fits: the last
});

test("limitAlerts and pickAlert: once per window, the most serious first", () => {
  const H = 3600000;
  const now = new Date(2026, 10, 10, 12, 0).getTime();
  const resetsAt = now + 2 * H;
  const l = (pct) => ({ name: "5h", what: "5-hour limit", pct, resetsAt });
  const p = (pct) => pace(l(pct), 5 * H, now); // 60% of the window gone
  assert.deepEqual(limitAlerts(l(20), p(20), now), []);
  // 40% used at 60% of the window: on course for ~67%, no alert.
  assert.deepEqual(limitAlerts(l(40), p(40), now), []);
  // 70%: full before the reset.
  const fast = limitAlerts(l(70), p(70), now);
  assert.deepEqual(fast.map((a) => a.id), [`5h@${resetsAt}:pace`]);
  assert.equal(fast[0].level, "warning");
  assert.match(fast[0].body, /^At this rate, full today 13:17, resets today 14:00 \(in 2h0m\)$/);
  // 80%: past 75%, and filling up.
  assert.deepEqual(limitAlerts(l(80), p(80), now).map((a) => a.id), [`5h@${resetsAt}:75`, `5h@${resetsAt}:pace`]);
  // 95%: past 90% and 75%; no pace alert on top.
  const worst = limitAlerts(l(95), p(95), now);
  assert.deepEqual(worst.map((a) => a.id), [`5h@${resetsAt}:90`, `5h@${resetsAt}:75`]);
  assert.equal(worst[0].level, "error");
  assert.equal(worst[0].title, "Claude 5-hour limit at 95%");
  // A window that hasn't started has nothing to say.
  assert.deepEqual(limitAlerts({ name: "5h", what: "5-hour limit", pct: 0, resetsAt: null }, null, now), []);

  // Sent once: the pace alert at 70%, then nothing new until 75%.
  const first = pickAlert(fast, new Set());
  assert.equal(first.alert.id, `5h@${resetsAt}:pace`);
  const sent = new Set(first.mark);
  assert.equal(pickAlert(fast, sent).alert, null);
  const at80 = pickAlert(limitAlerts(l(80), p(80), now), sent);
  assert.equal(at80.alert.id, `5h@${resetsAt}:75`);
  // Straight to 95% marks 75% too, so it isn't sent later.
  const jump = pickAlert(worst, new Set());
  assert.deepEqual(jump.mark, [`5h@${resetsAt}:90`, `5h@${resetsAt}:75`]);
  assert.equal(pickAlert(limitAlerts(l(80), p(80), now), new Set(jump.mark)).alert, null);
  // A new window starts over.
  const next = { ...l(80), resetsAt: resetsAt + 5 * H };
  assert.notEqual(pickAlert(limitAlerts(next, null, now), sent).alert, null);
  assert.deepEqual(pickAlert([], new Set()), { alert: null, mark: [] });
});

test("fmtWhen: local time, with the day only when it isn't today", () => {
  const now = new Date(2026, 10, 10, 11, 0).getTime(); // Tue
  assert.equal(fmtWhen(new Date(2026, 10, 10, 14, 40).getTime(), now), "today 14:40");
  assert.equal(fmtWhen(new Date(2026, 10, 11, 9, 5).getTime(), now), "tomorrow 09:05");
  assert.equal(fmtWhen(new Date(2026, 10, 14, 2, 0).getTime(), now), "Sat 02:00");
});

test("fmtCost", () => {
  assert.equal(fmtCost(0), "$0.00");
  assert.equal(fmtCost(0.1713673), "$0.17");
  assert.equal(fmtCost(12.345), "$12.35");
  assert.equal(fmtCost(123.4), "$123");
});

test("fmtDuration and shortPath", () => {
  assert.equal(fmtDuration(45000), "45s");
  assert.equal(fmtDuration(754000), "12m");
  assert.equal(fmtDuration(7500000), "2h5m");
  assert.equal(shortPath("/home/me/app", "/home/me"), "~/app");
  assert.equal(shortPath("/home/me", "/home/me"), "~");
  assert.equal(shortPath("/home/meow", "/home/me"), "/home/meow");
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

test("family: the alias /model takes", () => {
  assert.equal(family("Fable 5.1"), "fable");
  assert.equal(family("Opus 5.5"), "opus");
  assert.equal(family("claude-sonnet-5-5"), "sonnet");
  assert.equal(family("Haiku 5.5"), "haiku");
  assert.equal(family("GPT"), null);
  assert.equal(family(null), null);
});
