// The clickable "Projects" button that opens the Projects picker (the key combo keeps working).
// It sits in one of three layout blocks (sidebar footer, status bar, tab bar); props().slot says which.
// Only the slot chosen in the picker ("Launcher: …", saved in shared("projects.launcher")) shows;
// the others hide their own block, so no empty space is left behind.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, props, shared } from "herdr";

const SETTING = "projects.launcher";
const BLOCK = { sidebar: "projects-launch-sidebar", status: "projects-launch-status", tabs: "projects-launch-tabs" };
const open = () => run("mod.open", { name: "projects" });

export default class ProjectPresetsLauncher extends View {
  render() {
    const t = theme();
    const slot = props()?.slot ?? "sidebar";
    const chosen = shared(SETTING) ?? "sidebar";
    if (chosen !== slot) {
      // Not this one's turn: close the block (the picker opens it again when it is chosen).
      if (!this.hid) { this.hid = true; run("layout.hide", { id: BLOCK[slot] }); }
      return div();
    }
    this.hid = false;
    const icon = (n) => svg("mods/workspace-chrome/folder.svg").size(n).flex_none();
    if (slot === "sidebar") {
      return h_flex().size_full().bg(t.chrome).px(8).items_center().child(
        h_flex().id("pp-launch").h(28).w_full().px(8).gap(9).items_center().rounded(8).text_size(13).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(open).child(icon(14)).child("Projects"));
    }
    if (slot === "status") {
      return h_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).items_center().child(
        h_flex().id("pp-launch").h(20).px(8).gap(6).items_center().rounded(5).text_size(11.8).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(open).child(icon(13)).child("Projects"));
    }
    return h_flex().size_full().bg(t.chrome).border_b(1).border_color(t.border).pr(6).items_center().child(
      div().id("pp-launch").size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(open).child(icon(15)));
  }
}
