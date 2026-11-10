# herdr-claude-usage

Herdr mod (GPUI via gpui-kit, plain JavaScript, no build step). See [README.md](README.md)
for what it does, the status line feed it reads, and the layout blocks.

- Herdr runs a **copy** of `mods/claude-usage` in `~/.config/herdr-app/mods/claude-usage`.
  Edit here, never there. `npm run dev` re-copies on every save (the app hot reloads);
  otherwise run `tools/install.sh` after changing anything.
- The API types are `mods/claude-usage/gpui-kit.d.ts` and `~/.config/herdr-app/herdr.d.ts`;
  `~/.config/herdr-app/AGENTS.md` is Herdr's own guide. They're the truth over memory.
- The data is Claude Code's status line input, saved by the user's status line script into
  `~/.claude/statusline/`. Check a real file there before relying on a field.
- Keep `logic.js` free of `herdr` / `gpui-*` imports so `npm test` runs it under Node.
- Before calling a change done: `npm test`, `npm run check`, and look at it in the app
  (`herdr-app shot`). The check only covers the first render.
- Mind performance: no `.loop()` animations, and no timer faster than the 30 s one.
- [RECIPE.md](RECIPE.md) and `preview.png` are what herdr.dev/mods shows (the brief format
  is in Herdr's `AGENTS.md`). Update them when what the mod shows or does changes.
