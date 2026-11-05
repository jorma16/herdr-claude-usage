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

// 4322 -> "4.3K", 200000 -> "200K", 1200000 -> "1.2M".
export function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return String(Math.round(n));
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
