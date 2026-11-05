// Claude Code usage in Herdr, from what each session hands its status line. Two views of the
// same mod, chosen by props.view:
//   "agents" (default): a row per Claude Code agent with its model, effort and how full its
//                       context is. Click a row to go to the agent; right-click it for its
//                       details and to change its effort or model.
//   "quota":            the account's limits (5 hours, 7 days, and a model's weekly one when
//                       the usage cache has it), each with the time left until it resets.
// The status line script writes the feed (see README.md): ~/.claude/statusline/<session>.json,
// latest.json (the newest of them) and, optionally, usage.json (Claude's usage endpoint).
// Agents are matched to sessions through ~/.claude/sessions/<pid>.json, Claude Code's own.

import { View, div } from "gpui-kit";
import { h_flex, v_flex, Popover } from "gpui-base";
import { agents, spaces, terminals, props, run, theme, home, readTextFile, watchFolder, hc, notify } from "herdr";
import { label, tabsById, sessionPids, sessionIdOf, agentInfo, rateLimits, modelWeekly, fmtTokens, fmtCost, fmtDuration, shortPath, fmtLeft, level, tier, family } from "./logic.js";

// Fill colors by level (see logic.js), readable on light and dark themes.
const LEVEL_COLORS = ["#2ea043", "#d4a72c", "#e36209", "#d73a49"];
// Model colors by price tier, as in the status line: opus red, sonnet orange, haiku green.
const TIER_COLORS = { opus: "#d73a49", sonnet: "#e36209", haiku: "#2ea043", other: "#a371f7" };
// The model whose weekly limit the quota view shows, when usage.json has one.
const WEEKLY_MODEL = { match: "fable", label: "Fable" };
// What the details panel offers: `/effort <level>` and `/model <alias>`, typed into the agent.
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MODELS = [["fable", "Fable"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"]];
// Re-read now and then: new agents, and the time left until each limit resets.
const TICK = 30000;

function bar(t, pct, w) {
  const p = Math.max(0, Math.min(100, pct ?? 0));
  return div().flex_none().w(w).h(4).rounded(2).bg(t.border)
    .child(div().h_full().w(`${p}%`).rounded(2).bg(LEVEL_COLORS[level(p)]));
}

const when = (at) => new Date(at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

export default class ClaudeUsage extends View {
  init(_props, cx) {
    this.view = props()?.view === "quota" ? "quota" : "agents";
    this.dir = `${home()}/.claude/statusline`;
    this.sessions = `${home()}/.claude/sessions`;
    this.info = new Map(); // address -> agentInfo, or null while its session has no feed yet
    this.latest = null; // latest.json's text
    this.usage = null; // usage.json's text
    this.key = ""; // what was last shown, to repaint only on a change
    this.menu = null; // the address whose details panel is open
    this.watch(cx, this.dir);
    if (this.view === "agents") this.watch(cx, this.sessions);
    cx.timer.every(TICK, (cx) => {
      this.reload(cx);
      if (this.view === "quota") cx.notify(); // the time left ticks
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
      [this.latest, this.usage] = await Promise.all([text(`${this.dir}/latest.json`), text(`${this.dir}/usage.json`)]);
      key = `${this.latest}\n${this.usage}`;
    } else {
      const pairs = sessionPids(agents(), terminals());
      const ids = await Promise.all(pairs.map(([, pid]) => text(`${this.sessions}/${pid}.json`).then(sessionIdOf)));
      const feeds = await Promise.all(ids.map((id) => (id ? text(`${this.dir}/${id}.json`) : null)));
      this.info = new Map();
      pairs.forEach(([address], i) => {
        if (ids[i]) this.info.set(address, agentInfo(feeds[i]));
      });
      key = JSON.stringify([...this.info]);
    }
    if (key === this.key) return;
    this.key = key;
    cx.notify();
  }

  render() {
    return this.view === "quota" ? this.quota() : this.agents();
  }

  // ---- quota view: a strip for the status bar --------------------------------------------

  quota() {
    const t = theme();
    const now = Date.now();
    const { five, seven } = rateLimits(this.latest, now);
    const weekly = modelWeekly(this.usage, WEEKLY_MODEL.match, now);
    const items = [["5h", "5-hour limit", five], ["7d", "7-day limit", seven], [WEEKLY_MODEL.label, `${WEEKLY_MODEL.label} weekly limit`, weekly]]
      .filter(([, , l]) => l)
      .map(([name, what, l]) => this.limit(t, name, what, l, now));
    return h_flex().id("cu-quota").size_full().px(14).gap(16).items_center().justify_end()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .when(items.length === 0, (el) => el.child(div().text_color(t.dim).child("No Claude usage yet")))
      .children(items);
  }

  limit(t, name, what, l, now) {
    const left = l.resetsAt ? fmtLeft(l.resetsAt, now) : null;
    const tip = `${what}: ${Math.round(l.pct)}% used${l.resetsAt ? `, resets ${when(l.resetsAt)} (in ${left})` : ""}`;
    return h_flex().id(`cu-${name}`).flex_none().gap(6).items_center().tooltip(tip)
      .child(div().text_color(t.dim).child(name))
      .child(bar(t, l.pct, 36))
      .child(div().font_medium().text_color(LEVEL_COLORS[level(l.pct)]).child(`${Math.round(l.pct)}%`))
      .when(Boolean(left), (el) => el.child(div().text_color(t.dim).child(left)));
  }

  // ---- agents view: a row per Claude Code agent ------------------------------------------

  agents() {
    const t = theme();
    const tabs = tabsById(spaces());
    const list = agents().filter((a) => this.info.has(a.address));
    return v_flex().id("cu-agents").size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border).text_size(12)
      .child(h_flex().px(16).h(41).pt(14).pb(5).flex_none().items_center()
        .child(div().flex_1().text_size(11.5).font_medium().text_color(t.dim).child("Claude")))
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
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(name));
    if (!info) {
      // A Claude Code session without a feed file: its status line hasn't run, or doesn't write it.
      return el.tooltip(`${a.space_name} · no status line data yet (see the mod's README)`)
        .child(head.child(div().flex_none().text_size(11).text_color(t.dim).child("—")));
    }
    const pct = info.ctxPct;
    const tip = [
      a.space_name,
      info.name,
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
        .when(info.cost !== null, (h) => h.child(div().flex_none().text_color(t.muted).child(fmtCost(info.cost))))
        .when(info.ctxTokens !== null, (h) => h.child(div().flex_none().text_color(t.dim).child(fmtTokens(info.ctxTokens)))))
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
      .when(busy, (el) => el.child(div().text_size(11).text_color(t.dim).child("Working: wait until it's idle to change these.")));
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
