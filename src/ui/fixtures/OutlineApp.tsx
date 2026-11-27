// The outlined ToolButton beside the ghost one, for toolbutton-outline.test.tsx
// and a look: `nsh run src/ui/fixtures/OutlineApp.tsx`. Synthetic labels only.
import { mount, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { ToolButton } from "../ActionBar";
import { setThemeMode, startTheme, type ThemeMode } from "../theme";
import { TEXT } from "../tokens";

mount(() => {
  setThemeMode("dark");
  startTheme();
  const open = signal(false);
  const presses = signal(0);
  return (
    <Window id="outline" title="Outline" defaultSize={{ width: 520, height: 260 }}>
      {() => (
        <View testID="outline" class="flex-1 bg-background p-6 gap-4">
          <View class="flex-row items-center gap-3">
            <ToolButton testID="ghost" label="2 attachments" icon="attachment" />
            <ToolButton testID="outlined" outline label="2 attachments" icon="attachment" />
            <ToolButton testID="outlined-plain" outline label="2 attachments" />
          </View>
          <View class="flex-row items-center gap-3">
            <ToolButton
              testID="toggle"
              outline
              icon="attachment"
              label={open() ? "Hide" : "Show"}
              selected={open()}
              onPress={() => {
                open.set(!open());
                presses.update((n) => n + 1);
              }}
            />
            <ToolButton testID="outlined-danger" outline variant="danger" label="Delete..." icon="trash" />
            <ToolButton testID="outlined-icon" outline iconOnly label="Attachments" icon="attachment" />
          </View>
          <View class="flex-row gap-2">
            {([["dark", "Ink"], ["light", "Paper"], ["omarchy", "Omarchy"]] as [ThemeMode, string][]).map(([mode, label]) => (
              <ToolButton testID={`mode-${mode}`} label={label} onPress={() => setThemeMode(mode)} />
            ))}
          </View>
          <Text testID="presses" class={TEXT.caption}>{"Presses: " + presses()}</Text>
        </View>
      )}
    </Window>
  );
});
