// The roving focus's event order, driven by hand, for roving.test.tsx: a
// row's view is a stand-in whose focus() reports a focus-in only when asked,
// so a move whose focus never arrives (Tab took it out of the list) can be
// played without a platform.
import { mount, signal, Text, View, type ViewRef } from "nsh";
import { Window } from "nsh/desktop";
import { Button } from "../Controls";
import { useRovingFocus, type RovingKey } from "../roving";
import { setThemeMode, startTheme } from "../theme";
import { TEXT } from "../tokens";

mount(() => {
  setThemeMode("dark");
  startTheme();
  const bound = signal(false);
  const opened = signal("a");
  // Whether a moved-to row reports its focus-in (as a real focus move does).
  const focusArrives = signal(true);
  let keys: Record<RovingKey, () => void> | undefined;
  const roving = useRovingFocus({
    targets: () => ["a", "b", "c"].map((key) => ({ key, opens: true, depth: 0, folds: false, expanded: false })),
    selectedKey: opened,
    open: (t) => opened.set(t.key),
    bindKeys: (k) => {
      keys = k;
      bound.set(true);
      return () => bound.set(false);
    },
  });
  for (const key of ["a", "b", "c"]) {
    roving.register(key, {
      focus: () => {
        if (focusArrives()) roving.focusIn();
      },
      reveal: () => {},
    } as unknown as ViewRef);
  }
  return (
    <Window id="roving" title="Roving" defaultSize={{ width: 480, height: 320 }}>
      {() => (
        <View class="gap-2 p-4 bg-background grow">
          <Text class={TEXT.body}>{`Bound: ${bound() ? "yes" : "no"}`}</Text>
          <Text class={TEXT.body}>{`Open: ${opened()}`}</Text>
          <Button testID="in" label="Focus in" onPress={() => roving.focusIn()} />
          <Button testID="out" label="Focus out" onPress={() => roving.focusOut()} />
          <Button
            testID="down-away"
            label="Down, then the focus leaves before the row takes it"
            onPress={() => {
              focusArrives.set(false);
              keys?.down();
              roving.focusOut();
            }}
          />
          <Button
            testID="down-macos"
            label="Down, out before in"
            onPress={() => {
              focusArrives.set(true);
              keys?.down();
              roving.focusOut();
            }}
          />
        </View>
      )}
    </Window>
  );
});
