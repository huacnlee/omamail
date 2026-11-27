// The Omarchy mode at startup, its content mounted behind `themeReady()`, for
// ui.test.tsx: the first frame that shows content already has every role.
import { mount, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { setThemeMode, startTheme, themeReady } from "../theme";
import { cx, LINE, TEXT } from "../tokens";

mount(() => {
  setThemeMode("omarchy");
  startTheme();
  return (
    <Window id="omarchy-start" title="Omarchy start" defaultSize={{ width: 400, height: 300 }}>
      {() => (
        <View testID="root" class="flex-1 bg-background p-4 gap-2">
          <If when={themeReady()}>
            <Text class={TEXT.body}>Ready</Text>
            <View testID="swatch-raised" class="size-6 bg-surface-raised" />
            <View testID="swatch-divider" class={cx("size-6", LINE.dividerFill)} />
            <View testID="swatch-border" class={cx("size-6", LINE.hairline)} />
          </If>
        </View>
      )}
    </Window>
  );
});
