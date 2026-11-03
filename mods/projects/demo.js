// Documentation screenshots: `~/.config/herdr-app/data/projects.demo` (JSON) opens the picker
// already in a given view, so each screen can be captured the same way every time. Absent by default.
//   { "view": "list|edit|delete|name|worktrees|backup|duplicate|busy|launch (Enter on the named project)", "project": "api-gateway", "query": "apgw",
//     "focus": "name", "tab": 1, "pane": 0, "text": "fix login", "tick": true, "confirm": true, "notes": ["…"],
//     "detail": true|false (show or hide the detail card), "layout": "agent-terminal" (a layout picked for the launch) }
import * as fs from "fs/promises";
import { appHome } from "herdr";

export async function readDemo() {
  const path = `${appHome()}/data/projects.demo`;
  try {
    if (!(await fs.exists(path))) return null;
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch { return null; }
}
