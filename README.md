# herdr-claude-usage

A [Herdr](https://herdr.dev) mod that shows Claude Code's usage, from what each session
hands its status line:

- **Agents** (`props: { "view": "agents" }`, the default): a row per Claude Code agent with
  a dot for its status, its label, model (colored by tier: Opus red, Sonnet orange, Haiku
  green, others purple), effort, cost so far, and how full its context is (percent, tokens
  and a bar: green, yellow from 50%, orange from 75%, red from 90%). Blocked agents come
  first, and the header shows what they've cost together. The tooltip adds its space,
  status, session name and context size. Click a row to go to the agent. Right-click it for
  a panel with all it knows (model id, context, cost, time, lines changed, folder, Claude
  Code version) and to change its effort or model (or, from 75% context, compact it). It
  types `/effort <level>`, `/model <alias>` or `/compact` into the agent with `hc send`,
  only while the agent isn't working. An agent shows `—` until its status line has run once
  with the feed below, and a new session shows `—` until its first turn. It notifies once
  when an agent's context reaches 90%; clicking the notification goes to it. Press
  `cmd-shift-o` to open in the browser the open PRs of the focused agent's branch (with
  `gh pr list --head <branch>` in its folder); add `"cmd-shift-o": "claude-usage.pr"` to
  `global` in `~/.config/herdr-app/keys.json`.
- **Quota** (`props: { "view": "quota" }`): the account's 5-hour and 7-day limits, plus each
  model's weekly limit when `usage.json` has them (Fable, say), each with a bar and the time
  left until it resets (exact time in the tooltip). Click it for a panel with each limit's
  reset time, how much of its window has gone, where it's heading at the current rate (or
  when it fills up first), each model's share of the weekly limit, whether extra usage is
  on, and how old the data is. It dims when no session has updated the limits for 30
  minutes. When the block is too narrow, it drops the time left, then the bars. It posts a
  notification once per window when a limit passes 75% or 90%, or (from 25%) is on course
  to fill up before it resets. Meant for the bottom bar, next to `workspace-status`.

Both follow light and dark themes (darker colors on light ones).

It doesn't call any API on its own: it reads files, runs `stat` on `latest.json` for its age,
runs `hc send` only when you click a chip, and `gh pr list` only when you press the PR key. It refreshes when the feed folder changes
(`watchFolder`), plus a 30 s timer for new agents and the countdowns.

### Options (props)

| Prop | Values | Default |
|---|---|---|
| `view` | `"agents"` or `"quota"` | `"agents"` |
| `weekly` | `true` (every model's weekly limit), `false` (none), or names: `["fable"]` | `true` |
| `alerts` | `false` (no notifications), or `{ "warn", "critical", "pace", "context" }`: percents, or `false` for one | `{ "warn": 75, "critical": 90, "pace": 25, "context": 90 }` |

For example `{ "mod": "claude-usage", "props": { "view": "quota", "alerts": { "pace": false } } }`.
The agents view uses `alerts.context`, the quota view the rest.

## The feed

Claude Code gives the status line command its data (model, effort, context, limits) on
stdin and nowhere else, so your status line script saves a copy where the mod can read it.
Add this right after the script reads its input (`input=$(cat)`):

```sh
feed="$HOME/.claude/statusline"
sid=$(echo "$input" | jq -r '.session_id // empty')
if [ -n "$sid" ] && mkdir -p "$feed" 2>/dev/null; then
  printf '%s' "$input" > "$feed/$sid.json.tmp" && mv "$feed/$sid.json.tmp" "$feed/$sid.json"
  printf '%s' "$input" > "$feed/latest.json.tmp" && mv "$feed/latest.json.tmp" "$feed/latest.json"
  find "$feed" -name '*.json' -mtime +2 -delete 2>/dev/null
fi
```

Without a status line yet, a script with just `input=$(cat)`, that block and an `echo` of
whatever you want to see is enough; point `statusLine` in `~/.claude/settings.json` at it:

```json
"statusLine": { "type": "command", "command": "sh ~/.claude/statusline-command.sh" }
```

Files in `~/.claude/statusline/`:

| File | What | Used for |
|---|---|---|
| `<session_id>.json` | each session's latest status line input | agents view |
| `latest.json` | the newest input of any session | 5-hour and 7-day limits |
| `usage.json` (optional) | Claude's usage endpoint (`/api/oauth/usage`) response, as `/usage` reads it | per-model weekly limits, extra usage |

The mod matches agents to sessions with Claude Code's own `~/.claude/sessions/<pid>.json`
(the agent terminal's foreground pid → `sessionId`). Only agents on this machine.

`usage.json` is for scripts that already query the usage endpoint (with the OAuth token
from the keychain) and cache the answer: cache it at that path. Only cache real answers
(with `.limits`): an error response would replace the last good one. (The mod keeps the
last good answer it has read anyway, until it restarts.)

## Install

```sh
tools/install.sh
```

This copies `mods/claude-usage` into `~/.config/herdr-app/mods/claude-usage`. Then put its
blocks in your layout (`~/.config/herdr-app/layouts/<name>.json`; clone a shipped layout
first, they're overwritten by Herdr: `herdr-app do layout.clone '{"name":"main","as":"my-main"}'`).

The agents list, e.g. under `sidebar-lists` in a clone of `main`:

```json
{ "id": "claude", "type": "block", "content": { "mod": "claude-usage" }, "size": { "weight": 1 }, "min": 90 }
```

The limits, next to the status bar: turn `main`'s `status` block into a row.

```json
{
  "id": "status-row",
  "type": "row",
  "size": { "px": 28 },
  "children": [
    { "id": "status", "type": "block", "content": { "mod": "workspace-status" }, "size": { "weight": 1 } },
    { "id": "quota", "type": "block", "content": { "mod": "claude-usage", "props": { "view": "quota" } }, "size": { "px": 450 } }
  ]
}
```

Check `~/.config/herdr-app/layout.error` afterwards.

### Install with an agent

Open an agent (Claude Code, for one) in this repo and paste:

```text
Install the Herdr mod in this repo (herdr-claude-usage). Read README.md and
~/.config/herdr-app/AGENTS.md first; they win over what you think you know.

1. The feed: look at "statusLine" in ~/.claude/settings.json. If it runs a script, show me
   README.md's feed block and where you'd add it in that script (right after it reads its
   input), and add it once I agree. If I have no status line, offer to create
   ~/.claude/statusline-command.sh with just the feed block and a short line of output,
   and point "statusLine" at it.
2. Run tools/install.sh (it copies the mod into ~/.config/herdr-app/mods/claude-usage).
3. Find my active layout. If it's one of Herdr's (main, terminals, win98), clone it with
   `herdr-app do layout.clone '{"name":"main","as":"my-main"}'` (with its name); if it's
   already mine, edit that one, keeping a backup copy next to it.
4. Add README.md's "claude" block to the sidebar (under sidebar-lists in a clone of main),
   and turn the status bar block into README.md's "status-row" with the "quota" block.
   If my layout has no sidebar or status bar, ask me where to put them.
5. Check there's no ~/.config/herdr-app/layout.error, run
   `herdr-app check ~/.config/herdr-app/mods/claude-usage`, and take a `herdr-app shot`
   to see both blocks. Agents show "—" until their status line runs once with the feed.
```

## Develop

```sh
npm run dev           # copy into Herdr on every save, so the app hot reloads as you edit
npm test              # pure logic (mods/claude-usage/logic.js) under node --test
npm run check         # herdr-app check: loads the mod once
npm run install-mod   # one-off copy into Herdr (tools/install.sh)
```

| File | What |
|---|---|
| `mods/claude-usage/main.js` | both views, reading the feed |
| `mods/claude-usage/logic.js` | pure functions: parsing the feed, formats, colors' levels |
| `test/logic.test.js` | tests for `logic.js` |

`gpui-kit.d.ts` (the API types) is written by Herdr and not tracked.
