// Screenshot entry: the shell's own chrome (header, panes, status line, the
// shortcut sheet) around placeholder panes, with no backend behind it.
import { keymap, mount, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { prefs } from "../../app/prefs";
import { app } from "../../app/store";
import { useKeyRouter } from "../../keys/router";
import { followOmarchyFont, Omarchy, setOmarchyFont, SplitPane, SplitPanel } from "../../ui";
import { Header } from "../Header";
import { ShortcutHelp } from "../ShortcutHelp";
import { StatusBar } from "../StatusBar";

function Pane(props: { name: string }) {
  return (
    <View class="flex-1 items-center justify-center">
      <Text class="text-xs text-text-secondary">{props.name}</Text>
    </View>
  );
}

function Chrome() {
  useKeyRouter();
  app.setAccounts([
    { id: "a", email: "jane@example.com", provider: "imap", label: "jane" },
    { id: "b", email: "work@example.com", provider: "gmail", label: "Work", name: "Work" },
  ]);
  app.setNotice("");
  // Screenshots switch to a light palette with this.
  keymap.bind("mod+shift+l", () => Omarchy.applyTheme("flexoki-light"), { when: "always" });
  // ...and to Omarchy's base size 16 with this (a larger shell.toml base-size).
  keymap.bind("mod+shift+b", () => setOmarchyFont({ family: null, baseSize: 16 }), { when: "always" });
  return (
    <View class="flex-1 bg-background">
      <Header mode="wide" sidebarToggle canQuit onQuit={() => {}} />
      <View class="flex-1">
        <SplitPane label="Sidebar width">
          <SplitPanel fixed size={148} minSize={110} maxSize={360}>
            <Pane name="Sidebar" />
          </SplitPanel>
          <SplitPanel>
            <SplitPane label="Message list width">
              <SplitPanel size={380} minSize={100}>
                <Pane name="Message list" />
              </SplitPanel>
              <SplitPanel minSize={200}>
                <Pane name="Reader" />
              </SplitPanel>
            </SplitPane>
          </SplitPanel>
        </SplitPane>
      </View>
      <StatusBar mode="wide" />
      <ShortcutHelp />
    </View>
  );
}

// A fixture never reads or writes the user's window.json.
prefs.useMemory();

mount(() => {
  Omarchy.followSystem();
  followOmarchyFont({ poll: false });
  return <Window id="main" defaultSize={{ width: 1180, height: 760 }}>{() => <Chrome />}</Window>;
});
