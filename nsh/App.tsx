// Omamail: three panes, mailboxes, the list and the reader.
import { mount, View } from "nsh";
import { Window } from "nsh/desktop";
import { ResizablePanel, ResizablePanelGroup, TitleBar } from "nsh-omarchy";
import { MessageList } from "./src/screens/MessageList";
import { Reader } from "./src/screens/Reader";
import { Sidebar } from "./src/screens/Sidebar";

function App() {
  return (
    <View class="flex-1 bg-background">
      <TitleBar title="Omamail" />
      <ResizablePanelGroup class="flex-1">
        <ResizablePanel size={200} minSize={160} maxSize={320}>
          <Sidebar />
        </ResizablePanel>
        <ResizablePanel size={360} minSize={260}>
          <MessageList />
        </ResizablePanel>
        <ResizablePanel minSize={360}>
          <Reader />
        </ResizablePanel>
      </ResizablePanelGroup>
    </View>
  );
}

mount(() => (
  <Window id="main" title="Omamail" defaultSize={{ width: 1200, height: 760 }}>
    {App}
  </Window>
));
