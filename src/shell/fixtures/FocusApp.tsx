// Test entry: the shortcut sheet over one focusable control that reports
// its focus, to show the sheet hands the focus back when it closes.
import { mount, signal, Text, View, type ViewRef } from "nsh";
import { Window } from "nsh/desktop";
import { prefs } from "../../app/prefs";
import { useKeyRouter } from "../../keys/router";
import { ShortcutHelp } from "../ShortcutHelp";

function Probe() {
  useKeyRouter();
  const focused = signal(false);
  let ref: ViewRef | undefined;
  return (
    <View class="flex-1 bg-background p-4 gap-2">
      <View
        testID="probe"
        role="button"
        accessibilityLabel="Probe"
        focusable
        onPress={() => ref?.focus()}
        onFocus={() => focused.set(true)}
        onBlur={() => focused.set(false)}
        ref={(r) => (ref = r)}
        class="p-2"
      >
        <Text class="text-foreground">Probe</Text>
      </View>
      <Text class="text-foreground">{focused() ? "probe has focus" : "probe lost focus"}</Text>
      <ShortcutHelp />
    </View>
  );
}

// A fixture never reads or writes the user's window.json.
prefs.useMemory();

mount(() => <Window id="main" defaultSize={{ width: 1000, height: 700 }}>{() => <Probe />}</Window>);
