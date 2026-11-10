// Pure logic: no Herdr or GPUI imports, so test/logic.test.js runs it under plain Node.

// The terminal title without the spinner or status glyphs Claude Code puts in front.
export const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

// The tab's name if someone named it, else the terminal's title, its space or its program.
export function label(a, tabs) {
  const tab = tabs[a.tab];
  if (tab?.named && tab.name) return tab.name;
  return clean(a.title) || a.space_name || a.program?.name || "";
}

export function tabsById(spaces) {
  const out = {};
  for (const s of spaces) for (const t of s.tabs) out[t.id] = t;
  return out;
}

// Each Claude Code session writes ~/.claude/sessions/<pid>.json, with the pid of its process:
// the agent terminal's foreground program. Pairs [address, pid] for local agents that have one.
export function sessionPids(list, terms) {
  const pid = new Map(terms.map((t) => [t.address, t.foreground?.pid]));
  return list
    .filter((a) => !a.address.includes("/") && Number.isInteger(pid.get(a.address)))
    .map((a) => [a.address, pid.get(a.address)]);
}

function parse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The session id in a ~/.claude/sessions/<pid>.json, or null.
export function sessionIdOf(text) {
  const id = parse(text)?.sessionId;
  return typeof id === "string" && id ? id : null;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// What the agent row shows, from a session's status line input (the feed file), or null.
// ctxTokens: what's in the context window now (total_input_tokens already adds the cache).
export function agentInfo(text) {
  const j = parse(text);
  if (!j || typeof j !== "object") return null;
  const cw = j.context_window ?? {};
  const u = cw.current_usage ?? {};
  const summed = (num(u.input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0) + (num(u.cache_read_input_tokens) ?? 0);
  return {
    model: j.model?.display_name || j.model?.id || null,
    effort: j.effort?.level || null,
    fast: j.fast_mode === true,
    ctxPct: num(cw.used_percentage),
    ctxTokens: num(cw.total_input_tokens) ?? (summed > 0 ? summed : null),
    ctxSize: num(cw.context_window_size),
    cost: num(j.cost?.total_cost_usd),
    name: j.session_name || null,
    modelId: j.model?.id || null,
    cwd: j.workspace?.current_dir || j.cwd || null,
    version: j.version || null,
    durationMs: num(j.cost?.total_duration_ms),
    apiMs: num(j.cost?.total_api_duration_ms),
    linesAdded: num(j.cost?.total_lines_added),
    linesRemoved: num(j.cost?.total_lines_removed),
  };
}

// The 5-hour and 7-day limits in a status line input: { five, seven }, each { pct, resetsAt }
// (resetsAt in ms) or null. A window that has already reset reads 0%.
export function rateLimits(text, now) {
  const rl = parse(text)?.rate_limits;
  const one = (w) => {
    const pct = num(w?.used_percentage);
    if (pct === null) return null;
    const at = num(w?.resets_at);
    const resetsAt = at === null ? null : at * 1000;
    return resetsAt !== null && resetsAt <= now ? { pct: 0, resetsAt: null } : { pct, resetsAt };
  };
  return { five: one(rl?.five_hour), seven: one(rl?.seven_day) };
}

// A model's weekly limit in Claude's usage endpoint response ({ limits: [...] }), as
// { pct, resetsAt } or null. `model` matches the limit's model name, case-insensitive.
export function modelWeekly(text, model, now) {
  const limits = parse(text)?.limits;
  if (!Array.isArray(limits)) return null;
  const re = new RegExp(model, "i");
  const l = limits.find((x) => x?.kind === "weekly_scoped" && re.test(x?.scope?.model?.display_name ?? ""));
  const pct = num(l?.percent);
  if (pct === null) return null;
  const at = Date.parse(l.resets_at ?? "");
  const resetsAt = Number.isNaN(at) ? null : at;
  return resetsAt !== null && resetsAt <= now ? { pct: 0, resetsAt: null } : { pct, resetsAt };
}

// The share of the weekly limit a model may use, from the usage endpoint's
// weekly_scoped_shares (allowance_percent_of_weekly), or null.
export function modelShare(text, model) {
  const j = parse(text);
  if (!Array.isArray(j?.limits) || !Array.isArray(j?.weekly_scoped_shares)) return null;
  const re = new RegExp(model, "i");
  const i = j.limits.findIndex((x) => x?.kind === "weekly_scoped" && re.test(x?.scope?.model?.display_name ?? ""));
  if (i < 0) return null;
  return num(j.weekly_scoped_shares.find((s) => s?.limit_index === i)?.allowance_percent_of_weekly);
}

// Extra usage (credits past the plan's limits): { enabled, used } with `used` in the
// currency's units (or null), or null when the response doesn't say.
export function extraUsage(text) {
  const j = parse(text);
  if (typeof j?.extra_usage?.is_enabled !== "boolean") return null;
  const u = j.spend?.used;
  const minor = num(u?.amount_minor);
  const used = minor === null ? null : { amount: minor / 10 ** (num(u.exponent) ?? 2), currency: u.currency || "USD" };
  return { enabled: j.extra_usage.is_enabled, used };
}

// Where a limit is heading at its current rate, for a window `windowMs` long that ends at
// l.resetsAt: { elapsedPct, projected, fullAt }. projected is the % it would reach by the
// reset; fullAt (ms) is when it would hit 100% if that's before the reset, else null.
// null without a reset time, or in the window's first 5%, when the rate means little.
export function pace(l, windowMs, now) {
  if (!l?.resetsAt) return null;
  const start = l.resetsAt - windowMs;
  const elapsed = now - start;
  if (elapsed <= 0 || elapsed > windowMs) return null;
  const frac = elapsed / windowMs;
  if (frac < 0.05) return null;
  const fullAt = l.pct > 0 ? start + (elapsed * 100) / l.pct : null;
  return {
    elapsedPct: frac * 100,
    projected: l.pct / frac,
    fullAt: fullAt !== null && fullAt < l.resetsAt ? fullAt : null,
  };
}

// The fullest of `count` layouts (0 the fullest) that fits `avail` px, given the widths
// measured so far (level -> px). A level not measured yet is tried; if none fits, the last.
export function fitLevel(widths, avail, count) {
  for (let i = 0; i < count; i++) if (widths[i] === undefined || widths[i] <= avail) return i;
  return count - 1;
}

// What's worth a notification about a limit now, most serious first: past 90%, past 75%,
// or (from 25%) filling up before it resets. Each has an id unique to its window, so it's
// sent once per window. `l` is { name, what, pct, resetsAt }, `p` its pace (or null).
export function limitAlerts(l, p, now) {
  if (!l?.resetsAt) return [];
  const id = (kind) => `${l.name}@${l.resetsAt}:${kind}`;
  const pct = Math.round(l.pct);
  const resets = `resets ${fmtWhen(l.resetsAt, now)} (in ${fmtLeft(l.resetsAt, now)})`;
  const full = p?.fullAt ? `At this rate, full ${fmtWhen(p.fullAt, now)}, ${resets}` : null;
  const out = [];
  if (l.pct >= 90) out.push({ id: id(90), level: "error", title: `Claude ${l.what} at ${pct}%`, body: full ?? `It ${resets}` });
  if (l.pct >= 75) out.push({ id: id(75), level: "warning", title: `Claude ${l.what} at ${pct}%`, body: full ?? `It ${resets}` });
  if (full && l.pct >= 25 && l.pct < 90) {
    out.push({ id: id("pace"), level: "warning", title: `Claude ${l.what} filling up: ${pct}% used`, body: full });
  }
  return out;
}

// Which alert to send from limitAlerts' list, given the ids already sent: the most serious
// one if it's new, else none. `mark` is every id in the list, so a lesser one isn't sent
// after a worse one (or alongside it) in the same window.
export function pickAlert(alerts, sent) {
  if (alerts.length === 0 || sent.has(alerts[0].id)) return { alert: null, mark: [] };
  return { alert: alerts[0], mark: alerts.map((a) => a.id) };
}

// 4322 -> "4.3K", 200000 -> "200K", 1200000 -> "1.2M".
export function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return String(Math.round(n));
}

// A session's cost: 0.1713 -> "$0.17", 12.345 -> "$12.35", 123.4 -> "$123".
export function fmtCost(usd) {
  return `$${usd >= 100 ? Math.round(usd) : usd.toFixed(2)}`;
}

// A duration, short: 45000 -> "45s", 754000 -> "12m", 7500000 -> "2h5m".
export function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

// A path with the home folder as "~".
export function shortPath(path, home) {
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

// Time left until `at` (ms), short: "2d3h", "4h13m", "45m", "now".
export function fmtLeft(at, now) {
  const left = Math.floor((at - now) / 1000);
  if (left <= 0) return "now";
  const d = Math.floor(left / 86400);
  const h = Math.floor((left % 86400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

// A moment soon, in local time: "14:40" today, "tomorrow 09:05", else "Sat 02:00".
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function fmtWhen(at, now) {
  const d = new Date(at);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = (x) => new Date(x).setHours(0, 0, 0, 0);
  const days = Math.round((day(at) - day(now)) / 86400000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  return `${DAYS[d.getDay()]} ${time}`;
}

// How full, as a step for its color: 0 fine, 1 half, 2 three quarters, 3 nearly full.
export function level(pct) {
  if (pct >= 90) return 3;
  if (pct >= 75) return 2;
  if (pct >= 50) return 1;
  return 0;
}

// The model's price tier, for its color: "opus", "sonnet", "haiku" or "other".
export function tier(model) {
  const m = (model ?? "").toLowerCase();
  return ["opus", "sonnet", "haiku"].find((t) => m.includes(t)) ?? "other";
}

// The model's family, as the alias `/model` takes: "fable", "opus", "sonnet", "haiku", or null.
export function family(model) {
  const m = (model ?? "").toLowerCase();
  return ["fable", "opus", "sonnet", "haiku"].find((f) => m.includes(f)) ?? null;
}
