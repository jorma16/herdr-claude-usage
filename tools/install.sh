#!/bin/sh
# Copies the mod into Herdr's mods folder. A copy, not a symlink: Herdr only loads images
# whose real path is inside its home, and doesn't hot reload on changes it sees through a
# symlink. For live editing, run `npm run dev` (copies again on every save).
# An older symlinked install is replaced; Herdr's own gpui-kit.d.ts is left alone.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
mods="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods"
target="$mods/claude-usage"

mkdir -p "$mods"
[ -L "$target" ] && rm "$target"
rsync -a --delete --exclude gpui-kit.d.ts "$repo/mods/claude-usage/" "$target/"
echo "installed: $target"
if [ "${1:-}" != "--quiet" ] && command -v herdr-app >/dev/null; then
  herdr-app check "$target"
fi
