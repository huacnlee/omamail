// Omamail: three panes, mailboxes, the list and the reader.
import { keymap, mount, View } from "nsh";
import { Window } from "nsh/desktop";
import { TitleBar } from "nsh-omarchy";
import { MessageList } from "./src/screens/MessageList";
import { Reader } from "./src/screens/Reader";
import { Sidebar } from "./src/screens/Sidebar";
import { act, moveSelection } from "./src/store/mail";

function App() {
  keymap.bind({
    j: () => moveSelection(1),
    down: () => moveSelection(1),
    k: () => moveSelection(-1),
    up: () => moveSelection(-1),
    e: () => act("archive"),
    "shift+3": () => act("trash"),
    s: () => act("star"),
  });
  return (
    <View class="flex-1 bg-background">
      <TitleBar title="Omamail" />
      {/* Fixed widths, not nsh-omarchy's ResizablePanelGroup: on the Linux
          host its later panels do not get presses (the message rows never
          opened). Go back to it once that is fixed in NSH. */}
      <View class="flex-1 flex-row">
        <View class="w-[200px] border-r border-border">
          <Sidebar />
        </View>
        <View class="w-[360px] border-r border-border">
          <MessageList />
        </View>
        <View class="flex-1">
          <Reader />
        </View>
      </View>
    </View>
  );
}

mount(() => (
  <Window id="main" title="Omamail" defaultSize={{ width: 1200, height: 760 }}>
    {App}
  </Window>
));
