// An ActionBar in the window's title band, laid out as compose's header (a
// first button, a spacer, ghost buttons and a primary button each wrapped in
// a view), for titleband-macos.test.tsx: a centre press on every item must
// land (see ActionBar's STOPGAP).
import { mount, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { ActionBar, ActionBarGroup, ActionBarSeparator, ActionBarSpacer, ToolButton } from "../ActionBar";
import { Button, TitleBar } from "../Controls";
import { setThemeMode, startTheme } from "../theme";
import { TEXT } from "../tokens";

mount(() => {
  setThemeMode("dark");
  startTheme();
  const hits = signal<Record<string, number>>({});
  const hit = (key: string) => hits.set({ ...hits(), [key]: (hits()[key] ?? 0) + 1 });
  return (
    <Window id="band" title="Title band" defaultSize={{ width: 1100, height: 400 }}>
      {() => (
        <View class="flex-1 bg-background">
          <TitleBar title={null}>
            <View class="flex-1">
              <ActionBar testID="band-bar" label="Compose" edge="none">
                <View><ToolButton testID="back" label="Back" icon="back" iconOnly onPress={() => hit("back")} /></View>
                <ActionBarSpacer />
                <View><ToolButton testID="detach" label="Detach" icon="window" onPress={() => hit("detach")} /></View>
                <View><ToolButton testID="ask" label="Ask AI" icon="sparkles" iconOnly onPress={() => hit("ask")} /></View>
                <ActionBarGroup label="More">
                  <ToolButton testID="discard" label="Discard" icon="trash" iconOnly onPress={() => hit("discard")} />
                </ActionBarGroup>
                <ActionBarSeparator />
                <View><Button testID="send" label="Send" variant="primary" onPress={() => hit("send")} /></View>
              </ActionBar>
            </View>
          </TitleBar>
          <Text testID="hits" class={TEXT.body}>{`hits=${JSON.stringify(hits())}`}</Text>
        </View>
      )}
    </Window>
  );
});
