// Watches mods/claude-usage and copies it into Herdr's mods folder on every change, so the app
// hot reloads as you edit here. Standard library only. Run from the repo root: npm run dev
import { watch } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(repo, "mods/claude-usage");
const install = join(repo, "tools/install.sh");

function sync() {
  try {
    execFileSync(install, ["--quiet"], { stdio: "inherit" });
  } catch {
    // install.sh already printed why; keep watching.
  }
}

sync();
let pending = null;
watch(src, { recursive: true }, (_event, file) => {
  if (file?.endsWith("gpui-kit.d.ts")) return;
  clearTimeout(pending); // an editor save can fire several events: copy once
  pending = setTimeout(sync, 150);
});
console.log(`watching ${src} (ctrl-c to stop)`);
