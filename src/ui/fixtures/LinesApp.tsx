// A window's regions and their lines, for shots.test.tsx and a look:
// `nsh run src/ui/fixtures/LinesApp.tsx`. Structural dividers (header,
// split, action bar, status line) beside content borders (a field, a card).
import { mount, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { ActionBar, ToolButton } from "../ActionBar";
import { Button, Input } from "../Controls";
import { SplitPane, SplitPanel } from "../SplitPane";
import { setThemeMode, startTheme, type ThemeMode } from "../theme";
import { cx, LINE, TEXT } from "../tokens";

mount(() => {
  setThemeMode("dark");
  startTheme();
  const modes: [ThemeMode, string][] = [["dark", "Ink"], ["light", "Paper"], ["omarchy", "Omarchy"]];
  return (
    <Window id="lines" title="Lines" defaultSize={{ width: 720, height: 420 }}>
      {() => (
        <View testID="lines" class="flex-1 bg-background">
          <View class={cx("h-11 flex-row items-center gap-2 px-3 border-b", LINE.divider)}>
            <Text class={cx(TEXT.title, "flex-1")}>Header</Text>
            {modes.map(([mode, label]) => (
              <Button testID={`mode-${mode}`} size="small" label={label} onPress={() => setThemeMode(mode)} />
            ))}
          </View>
          <View class="flex-1 min-h-0">
          <SplitPane label="Sidebar width">
            <SplitPanel size={180} minSize={120}>
              <View class="flex-1 bg-muted p-3 gap-2">
                <Text class={TEXT.section}>Sidebar</Text>
              </View>
            </SplitPanel>
            <SplitPanel minSize={200}>
              <View class="flex-1">
                <ActionBar edge="top" label="Actions">
                  <ToolButton label="Archive" icon="archive" />
                </ActionBar>
                <View class="flex-1 p-3 gap-3">
                  <Input placeholder="A field keeps its border" />
                  <View class={cx("p-3 bg-surface-raised", LINE.border)}>
                    <Text class={TEXT.body}>A card keeps its border.</Text>
                  </View>
                  <View class="flex-row gap-2">
                    <ToolButton label="Attachments" icon="attachment" outline />
                    <ToolButton label="Attachments" icon="attachment" />
                  </View>
                </View>
              </View>
            </SplitPanel>
          </SplitPane>
          </View>
          <View class={cx("h-6 flex-row items-center px-3 border-t", LINE.divider)}>
            <Text class={TEXT.caption}>Status line</Text>
          </View>
        </View>
      )}
    </Window>
  );
});
