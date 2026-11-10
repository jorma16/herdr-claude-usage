// Claude Code usage in Herdr, from what each session hands its status line. Two views of the
// same mod, chosen by props.view:
//   "agents" (default): a row per Claude Code agent with its status, model, effort, cost and
//                       how full its context is, blocked ones first. Click a row to go to the
//                       agent; right-click it for its details and to change its effort or
//                       model (or compact it). It warns once when an agent's context nears full.
//                       The "pr" key command opens the focused agent's open PRs (gh).
//   "quota":            the account's limits (5 hours, 7 days, and the per-model weekly ones
//                       when the usage cache has them), each with the time left until it
//                       resets, dimmed when the data is old.
//                       Click it for each limit's reset time and where it's heading. When
//                       narrow, it drops the time left, then the bars. It also posts a
//                       notification once per window when a limit passes 75% or 90%, or is
//                       on course to fill up before it resets.
// The status line script writes the feed (see README.md): ~/.claude/statusline/<session>.json,
// latest.json (the newest of them) and, optionally, usage.json (Claude's usage endpoint).
// Agents are matched to sessions through ~/.claude/sessions/<pid>.json, Claude Code's own.
// Props: view, weekly (true, false or model names), alerts (false, or { warn, critical,
// pace, context }: percents, or false for one of them). See README.md.

import { View, div } from "gpui-kit";
import { h_flex, v_flex, Popover } from "gpui-base";
import { agents, spaces, panes, terminals, props, nextCommand, run, theme, home, readTextFile, watchFolder, hc, exec, notify, shared, setShared } from "herdr";
import { label, tabsById, sessionPids, sessionIdOf, agentInfo, rateLimits, weeklyLimits, pickWeekly, usageOk, isFresh, totalCost, blockedFirst, alertOptions, contextAlerts, fmtAgo, extraUsage, pace, fitLevel, limitAlerts, pickAlert, fmtTokens, fmtCost, fmtDuration, shortPath, fmtLeft, fmtWhen, isLight, level, tier, family, prUrls } from "./logic.js";

// Colors by level (see logic.js) and by model price tier (as in the status line: opus red,
// sonnet orange, haiku green), with darker ones that stay readable on a light theme.
const PALETTES = {
  dark: { level: ["#2ea043", "#d4a72c", "#e36209", "#d73a49"], tier: { opus: "#d73a49", sonnet: "#e36209", haiku: "#2ea043", other: "#a371f7" } },
  light: { level: ["#1a7f37", "#9a6700", "#bc4c00", "#cf222e"], tier: { opus: "#cf222e", sonnet: "#bc4c00", haiku: "#1a7f37", other: "#8250df" } },
};
// The palette for the theme in use; set at the start of every render.
let LEVEL_COLORS = PALETTES.dark.level;
let TIER_COLORS = PALETTES.dark.tier;
// How long each limit's window is, for its pace.
const HOUR = 3600000;
const WINDOW = { five: 5 * HOUR, seven: 7 * 24 * HOUR };
// What the details panel offers: `/effort <level>` and `/model <alias>`, typed into the agent.
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MODELS = [["fable", "Fable"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"]];
// The quota strip's layouts, fullest first: everything, without the time left, without bars.
const FIT = { full: 0, noLeft: 1, noBars: 2, count: 3 };
// Where the quota view keeps the alerts it has sent (id -> the window's reset time), so a
// reload doesn't send them again.
const SENT_KEY = "claude-usage.alerts";
// The sessions warned about a nearly full context (see contextAlerts in logic.js).
const CTX_KEY = "claude-usage.context-alerts";
// From this context percent, the details panel offers /compact.
const COMPACT_AT = 75;
// Limits older than this are dimmed: no session has run its status line since.
const STALE = 30 * 60000;
// Re-read now and then: new agents, and the time left until each limit resets.
const TICK = 30000;

function bar(t, pct, w) {
  const p = Math.max(0, Math.min(100, pct ?? 0));
  return div().flex_none().w(w).h(4).rounded(2).bg(t.border)
    .child(div().h_full().w(`${p}%`).rounded(2).bg(LEVEL_COLORS[level(p)]));
}

// When a file was last written (ms), with `stat` (BSD flags first, then GNU), or null.
async function modified(path) {
  for (const args of [["-f", "%m", path], ["-c", "%Y", path]]) {
    const r = await exec("stat", args).catch(() => null);
    const secs = Number.parseInt(r?.stdout?.trim() ?? "", 10);
    if (r?.code === 0 && Number.isFinite(secs)) return secs * 1000;
  }
  return null;
}

export default class ClaudeUsage extends View {
  init(_props, cx) {
    this.view = props()?.view === "quota" ? "quota" : "agents";
    this.weekly = props()?.weekly; // which per-model weekly limits to show (pickWeekly)
    this.opts = alertOptions(props()?.alerts); // null: no notifications
    this.dir = `${home()}/.claude/statusline`;
    this.sessions = `${home()}/.claude/sessions`;
    this.info = new Map(); // address -> agentInfo, or null while its session has no feed yet
    this.latest = null; // latest.json's text
    this.usage = null; // usage.json's text
    this.updatedAt = null; // when latest.json was written (ms), if stat could say
    this.key = ""; // what was last shown, to repaint only on a change
    this.menu = null; // the address whose details panel is open, or "quota"
    this.avail = null; // the quota strip's width for its items, once laid out
    this.widths = {}; // quota layout level -> the items' measured width
    this.watch(cx, this.dir);
    if (this.view === "agents") {
      this.watch(cx, this.sessions);
      // Key commands ("cmd-shift-o": "claude-usage.pr" in keys.json). Only this view's copy
      // takes them, so a docked quota strip doesn't open the PRs twice.
      cx.spawn(async () => {
        for (;;) if ((await nextCommand()) === "pr") this.openPrs();
      });
    }
    cx.timer.every(TICK, (cx) => {
      this.reload(cx);
      if (this.view === "quota") {
        this.alert(Date.now());
        cx.notify(); // the time left ticks
      }
    });
  }

  // Reads again whenever a file in `dir` changes. Without the folder, the timer still reads.
  watch(cx, dir) {
    cx.spawn(async (cx) => {
      for (;;) {
        await this.read(cx);
        try {
          await watchFolder(dir);
        } catch {
          return;
        }
      }
    });
  }

  reload(cx) {
    cx.spawn((cx) => this.read(cx));
  }

  async read(cx) {
    const text = (path) => readTextFile(path).catch(() => null);
    let key;
    if (this.view === "quota") {
      let usage;
      [this.latest, usage, this.updatedAt] = await Promise.all([
        text(`${this.dir}/latest.json`), text(`${this.dir}/usage.json`), modified(`${this.dir}/latest.json`),
      ]);
      // An error answer (rate limited, say) in usage.json keeps the last real one.
      if (usageOk(usage) || !usageOk(this.usage)) this.usage = usage;
      key = `${this.latest}\n${this.usage}\n${this.updatedAt}`;
      this.alert(Date.now());
    } else {
      const pairs = sessionPids(agents(), terminals());
      const ids = await Promise.all(pairs.map(([, pid]) => text(`${this.sessions}/${pid}.json`).then(sessionIdOf)));
      const feeds = await Promise.all(ids.map((id) => (id ? text(`${this.dir}/${id}.json`) : null)));
      this.info = new Map();
      pairs.forEach(([address], i) => {
        if (ids[i]) this.info.set(address, agentInfo(feeds[i]));
      });
      this.contextAlert(pairs.map(([address], i) => ({ address, sessionId: ids[i], ctxPct: this.info.get(address)?.ctxPct ?? null })));
      key = JSON.stringify([...this.info]);
    }
    if (key === this.key) return;
    this.key = key;
    cx.notify();
  }

  render() {
    const p = isLight(theme().chrome) ? PALETTES.light : PALETTES.dark;
    LEVEL_COLORS = p.level;
    TIER_COLORS = p.tier;
    return this.view === "quota" ? this.quota() : this.agents();
  }

  // ---- quota view: a strip for the status bar --------------------------------------------

  quota() {
    const t = theme();
    const now = Date.now();
    const limits = this.limits(now);
    const open = this.menu === "quota";
    const fit = this.avail === null ? FIT.full : fitLevel(this.widths, this.avail, FIT.count);
    const age = this.updatedAt === null ? null : Math.max(0, now - this.updatedAt);
    const stale = age !== null && age > STALE;
    const items = limits.map((l) => this.limit(t, l, now, !open, fit, stale ? age : null));
    const strip = h_flex().id("cu-quota").size_full().px(14).items_center().justify_end()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      // The items may eat into the 14px padding, down to 4px a side.
      .on_size_change((size, cx) => this.measure(cx, "avail", size.width - 8));
    if (items.length === 0) return strip.child(div().text_color(t.dim).child("No Claude usage yet"));
    const trigger = h_flex().id("cu-limits").flex_none().h_full().px(6).gap(fit === FIT.full ? 16 : 12).items_center()
      .rounded(4).cursor_pointer()
      .when(stale, (el) => el.opacity(0.55))
      .when(open, (el) => el.bg(t.hover))
      .hover((s) => s.bg(t.hover))
      .on_size_change((size, cx) => this.measure(cx, fit, size.width))
      .children(items);
    return strip.child(Popover.new("cu-pop-quota").anchor("bottom_right")
      .open(open)
      .on_open_change((o, cx) => {
        this.menu = o ? "quota" : null;
        cx.notify();
      })
      .trigger(trigger)
      .content(this.quotaDetails(t, limits, now, age, stale)));
  }

  // The limits there's data for: { name, what, pct, resetsAt, window, share? }.
  limits(now) {
    const { five, seven } = rateLimits(this.latest, now);
    const weekly = pickWeekly(weeklyLimits(this.usage, now), this.weekly)
      .map((w) => [w.model, `${w.model} weekly limit`, w, WINDOW.seven]);
    return [
      ["5h", "5-hour limit", five, WINDOW.five],
      ["7d", "7-day limit", seven, WINDOW.seven],
      ...weekly,
    ].filter(([, , l]) => l).map(([name, what, l, window]) => ({ name, what, window, ...l }));
  }

  // Keeps a width from on_size_change (the strip's room, or the items' width at a layout
  // level) and repaints when that changes which layout fits.
  measure(cx, what, width) {
    const w = Math.ceil(width);
    if (what === "avail" ? this.avail === w : this.widths[what] === w) return;
    const before = this.avail === null ? null : fitLevel(this.widths, this.avail, FIT.count);
    if (what === "avail") this.avail = w;
    else this.widths[what] = w;
    if (fitLevel(this.widths, this.avail, FIT.count) !== before) cx.notify();
  }

  // Posts what limitAlerts finds new, at most one per limit, and remembers it until the
  // window resets.
  alert(now) {
    if (!this.opts) return;
    const stored = shared(SENT_KEY);
    const sent = Object.fromEntries(Object.entries(stored && typeof stored === "object" ? stored : {})
      .filter(([, at]) => typeof at === "number" && at > now));
    let changed = Object.keys(sent).length !== Object.keys(stored ?? {}).length;
    for (const l of this.limits(now)) {
      const { alert, mark } = pickAlert(limitAlerts(l, pace(l, l.window, now), now, this.opts), new Set(Object.keys(sent)));
      if (!alert) continue;
      notify({ title: alert.title, body: alert.body, level: alert.level });
      for (const id of mark) sent[id] = l.resetsAt;
      changed = true;
    }
    if (changed) setShared(SENT_KEY, sent);
  }

  limit(t, l, now, tooltip, fit, staleAge) {
    const left = l.resetsAt ? fmtLeft(l.resetsAt, now) : null;
    const tip = `${l.what}: ${Math.round(l.pct)}% used${l.resetsAt ? `, resets ${fmtWhen(l.resetsAt, now)} (in ${left})` : ""}`
      + (staleAge !== null ? ` · as of ${fmtAgo(staleAge)}` : "");
    return h_flex().id(`cu-${l.name}`).flex_none().gap(6).items_center()
      .when(tooltip, (el) => el.tooltip(`${tip} · click for details`))
      .child(div().text_color(t.dim).child(l.name))
      .when(fit < FIT.noBars, (el) => el.child(bar(t, l.pct, 36)))
      .child(div().font_medium().text_color(LEVEL_COLORS[level(l.pct)]).child(`${Math.round(l.pct)}%`))
      .when(Boolean(left) && fit < FIT.noLeft, (el) => el.child(div().text_color(t.dim).child(left)));
  }

  // The click panel: each limit with its reset time and pace, then the plan's extras.
  quotaDetails(t, limits, now, age, stale) {
    const extra = extraUsage(this.usage);
    const section = (l) => {
      const p = pace(l, l.window, now);
      const color = LEVEL_COLORS[level(l.pct)];
      const lines = [
        l.resetsAt ? `Resets ${fmtWhen(l.resetsAt, now)} · in ${fmtLeft(l.resetsAt, now)}` : "Not started: the window opens with your next message",
        p ? `${Math.round(p.elapsedPct)}% of the window gone` : null,
        typeof l.share === "number" ? `Can use up to ${l.share}% of the 7-day limit` : null,
      ].filter(Boolean);
      // At this rate: full before the reset (warn), or the % it reaches by then.
      const heading = !p || l.pct === 0 ? null
        : p.fullAt ? [`At this rate, full ${fmtWhen(p.fullAt, now)} (in ${fmtLeft(p.fullAt, now)})`, LEVEL_COLORS[3]]
        : [`At this rate, ~${Math.round(p.projected)}% by the reset`, LEVEL_COLORS[level(p.projected)]];
      return v_flex().gap(4)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().text_color(t.foreground).child(l.what))
          .child(div().font_medium().text_color(color).child(`${Math.round(l.pct)}% used`)))
        .child(this.paceBar(t, l.pct, p?.elapsedPct ?? null))
        .child(v_flex().gap(2).text_size(11).text_color(t.dim).children(lines.map((x) => div().child(x))))
        .when(Boolean(heading), (el) => el.child(div().text_size(11).text_color(heading[1]).child(heading[0])));
    };
    const extraLine = !extra ? null
      : extra.enabled ? `Extra usage on${extra.used ? ` · ${extra.used.amount.toFixed(2)} ${extra.used.currency} used` : ""}`
      : "Extra usage off: you stop at the plan's limits";
    return v_flex().id("cu-quota-details").w(300).p(12).gap(12).rounded(8).border(1).border_color(t.border)
      .bg(t.popover).shadow_lg().text_size(12)
      .child(v_flex().gap(2)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().font_medium().text_color(t.foreground).child("Claude usage"))
          .when(age !== null, (h) => h.child(div().text_size(11).text_color(stale ? LEVEL_COLORS[1] : t.dim).child(`Updated ${fmtAgo(age)}`))))
        .when(stale, (el) => el.child(div().text_size(11).text_color(t.dim)
          .child("No session has run its status line since: limits used elsewhere don't show yet."))))
      .children(limits.map(section))
      .when(Boolean(extraLine), (el) => el.child(div().pt(8).border_t(1).border_color(t.border).text_size(11).text_color(t.dim).child(extraLine)));
  }

  // A full-width bar with a tick where the time is: past the tick, usage runs ahead of time.
  paceBar(t, pct, elapsedPct) {
    const b = bar(t, pct, "100%").relative();
    if (elapsedPct === null) return b;
    return b.child(div().absolute().top(-2).h(8).w(2).rounded(1).bg(t.foreground).left(`${Math.min(100, elapsedPct)}%`));
  }

  // ---- agents view: a row per Claude Code agent ------------------------------------------

  agents() {
    const t = theme();
    const tabs = tabsById(spaces());
    const list = blockedFirst(agents().filter((a) => this.info.has(a.address)));
    const total = totalCost(list.map((a) => this.info.get(a.address)));
    return v_flex().id("cu-agents").size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border).text_size(12)
      .child(h_flex().px(16).h(41).pt(14).pb(5).flex_none().items_center()
        .child(div().flex_1().text_size(11.5).font_medium().text_color(t.dim).child("Claude"))
        .when(total > 0, (h) => h.child(div().id("cu-total").flex_none().text_size(11.5).text_color(t.muted)
          .tooltip("What the agents listed have cost so far").child(fmtCost(total)))))
      .when(list.length === 0, (el) => el.child(div().px(16).text_size(12).text_color(t.dim).child("No Claude Code agents")))
      .child(v_flex().id("cu-list").flex_1().min_h(0).px(8).gap(2).overflow_y_scrollbar()
        .children(list.map((a) => this.row(t, a, label(a, tabs), this.info.get(a.address)))));
  }

  row(t, a, name, info) {
    const focus = () => (a.pane ? run("pane.focus", { pane: a.pane }) : run("agent.focus", { terminal: a.address }));
    const el = v_flex().id(`cu-${a.address}`).px(8).py(5).gap(3).rounded(6)
      .when(a.focused, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click(focus);
    const head = h_flex().gap(6).items_center()
      .child(div().flex_none().size(6).rounded_full().bg(t[a.status] ?? t.unknown))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(name));
    if (!info) {
      // A Claude Code session without a feed file: its status line hasn't run, or doesn't write it.
      return el.tooltip(`${a.space_name} · no status line data yet (see the mod's README)`)
        .child(head.child(div().flex_none().text_size(11).text_color(t.dim).child("—")));
    }
    const fresh = isFresh(info);
    const pct = fresh ? null : info.ctxPct;
    const tip = [
      a.space_name,
      a.status,
      info.name,
      fresh ? "no turns yet" : null,
      info.ctxTokens !== null && info.ctxSize ? `context ${fmtTokens(info.ctxTokens)} of ${fmtTokens(info.ctxSize)}` : null,
      info.cost !== null ? `${fmtCost(info.cost)} this session` : null,
    ].filter(Boolean).join(" · ");
    const model = [info.model, info.effort, info.fast ? "fast" : null].filter(Boolean);
    const shown = el.tooltip(tip)
      .child(head.when(pct !== null, (h) => h.child(div().flex_none().text_size(11.5).font_medium().text_color(LEVEL_COLORS[level(pct)]).child(`${Math.round(pct)}%`))))
      .child(h_flex().gap(6).items_center().text_size(11)
        .child(div().flex_none().text_color(TIER_COLORS[tier(info.model)]).child(model[0] ?? "?"))
        .when(model.length > 1, (h) => h.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(model.slice(1).join(" · "))))
        .when(model.length <= 1, (h) => h.child(div().flex_1()))
        .when(fresh, (h) => h.child(div().flex_none().text_color(t.dim).child("—")))
        .when(!fresh && info.cost !== null, (h) => h.child(div().flex_none().text_color(t.muted).child(fmtCost(info.cost))))
        .when(!fresh && info.ctxTokens !== null, (h) => h.child(div().flex_none().text_color(t.dim).child(fmtTokens(info.ctxTokens)))))
      .when(pct !== null, (el) => el.child(bar(t, pct, "100%")));
    return Popover.new(`cu-pop-${a.address}`).mouse_button("right")
      .open(this.menu === a.address)
      .on_open_change((open, cx) => {
        this.menu = open ? a.address : null;
        cx.notify();
      })
      .trigger(shown)
      .content(this.details(t, a, name, info));
  }

  // The right-click panel: everything the feed says about the agent, and its effort and model.
  details(t, a, name, info) {
    const busy = a.status === "working" || a.status === "blocked";
    const facts = [
      ["Space", a.space_name],
      ["Session", info.name],
      ["Model", info.modelId && info.modelId !== info.model ? `${info.model} · ${info.modelId}` : info.model],
      ["Effort", [info.effort, info.fast ? "fast" : null].filter(Boolean).join(" · ")],
      ["Context", info.ctxTokens !== null ? `${fmtTokens(info.ctxTokens)}${info.ctxSize ? ` of ${fmtTokens(info.ctxSize)}` : ""}${info.ctxPct !== null ? ` (${Math.round(info.ctxPct)}%)` : ""}` : null],
      ["Cost", info.cost !== null ? fmtCost(info.cost) : null],
      ["Time", info.durationMs !== null ? `${fmtDuration(info.durationMs)}${info.apiMs !== null ? ` · API ${fmtDuration(info.apiMs)}` : ""}` : null],
      ["Lines", info.linesAdded !== null ? `+${info.linesAdded} −${info.linesRemoved ?? 0}` : null],
      ["Folder", info.cwd ? shortPath(info.cwd, home()) : null],
      ["Version", info.version ? `Claude Code ${info.version}` : null],
    ].filter(([, v]) => v);
    const fact = ([k, v]) => h_flex().gap(8)
      .child(div().w(56).flex_none().text_color(t.dim).child(k))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(v));
    const chip = (key, text, active, command) => div().id(`cu-${a.address}-${key}`).px(7).py(2).rounded(4).border(1)
      .border_color(active ? t.accent : t.border).text_color(active ? t.foreground : t.muted)
      .when(active, (c) => c.bg(t.selected))
      .when(busy && !active, (c) => c.opacity(0.5))
      .when(!busy && !active, (c) => c.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.send(cx, a, command)))
      .child(text);
    const choices = (title, chips) => v_flex().gap(4)
      .child(div().text_size(11).text_color(t.dim).child(title))
      .child(h_flex().flex_wrap().gap(4).children(chips));
    return v_flex().id(`cu-details-${a.address}`).w(280).p(12).gap(10).rounded(8).border(1).border_color(t.border)
      .bg(t.popover).shadow_lg().text_size(12)
      .child(div().font_medium().truncate().text_color(t.foreground).child(name))
      .child(v_flex().gap(3).text_size(11.5).children(facts.map(fact)))
      .child(choices("Effort", EFFORTS.map((e) => chip(`effort-${e}`, e, e === info.effort, `/effort ${e}`))))
      .child(choices("Model", MODELS.map(([alias, text]) => chip(`model-${alias}`, text, alias === family(info.model), `/model ${alias}`))))
      .when(info.ctxPct >= COMPACT_AT, (el) => el.child(choices(`Context ${Math.round(info.ctxPct)}% full`, [chip("compact", "Compact now", false, "/compact")])))
      .when(busy, (el) => el.child(div().text_size(11).text_color(t.dim).child("Working: wait until it's idle to change these.")));
  }

  // Warns about agents whose context is nearly full (contextAlerts), once each; clicking the
  // notification goes to the agent. rows: { address, sessionId, ctxPct } for every agent.
  contextAlert(rows) {
    if (!this.opts || this.opts.context === false) return;
    const tabs = tabsById(spaces());
    const byAddress = new Map(agents().map((a) => [a.address, a]));
    const stored = shared(CTX_KEY);
    const sent = new Set(Array.isArray(stored) ? stored : []);
    const labelled = rows.map((r) => ({ ...r, label: byAddress.has(r.address) ? label(byAddress.get(r.address), tabs) : r.address }));
    const out = contextAlerts(labelled, sent, this.opts.context);
    for (const a of out.alerts) {
      notify({ title: a.title, body: a.body, level: "warning", action: { name: "agent.focus", args: { terminal: a.address } } });
    }
    const same = out.sent.size === sent.size && [...out.sent].every((id) => sent.has(id));
    if (!same) setShared(CTX_KEY, [...out.sent]);
  }

  // Opens in the browser the open PRs of the focused terminal's branch (`gh pr list`, run in its
  // folder on its machine), or says why there's none.
  async openPrs() {
    const say = (title, body, lvl = "info") => notify({ title, body, level: lvl });
    const pane = panes().find((p) => p.focused && p.terminal);
    if (!pane?.cwd || !pane.branch) return say("No branch here", "The focused pane isn't a terminal in a git repo.");
    const machine = spaces().find((s) => s.tabs.some((t) => t.id === pane.tab))?.machine ?? null;
    let r;
    try {
      r = await exec("gh", ["pr", "list", "--head", pane.branch, "--state", "open", "--json", "url"], { cwd: pane.cwd, on: machine });
    } catch (e) {
      return say("Couldn't run gh", String(e?.message ?? e), "error");
    }
    if (r.code !== 0) return say("gh pr list failed", r.stderr.trim() || `gh exited with ${r.code}`, "error");
    const urls = prUrls(r.stdout);
    if (urls.length === 0) return say("No open PR", `Nothing open for ${pane.branch}.`);
    for (const url of urls) {
      await exec("open", [url]).catch(() => exec("xdg-open", [url]).catch(() => say("Couldn't open the PR", url, "error")));
    }
  }

  // Types a slash command into the agent (hc pastes it and presses Enter), then closes the panel.
  send(cx, a, command) {
    this.menu = null;
    cx.notify();
    const fail = (why) => notify({ title: `Couldn't send ${command}`, body: why, level: "error" });
    hc(["send", a.address, command])
      .then((r) => r.code === 0 || fail(r.stderr.trim() || `hc exited with ${r.code}`))
      .catch((e) => fail(String(e?.message ?? e)));
  }
}
