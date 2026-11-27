// The ui Calendar beside nsh-omarchy's, at a chosen base size, for
// calendar.test.tsx and a look: `nsh run src/ui/fixtures/CalendarApp.tsx`.
import { mount, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { Calendar as OmCalendar, Omarchy } from "nsh-omarchy";
import { Calendar } from "../Calendar";
import { setOmarchyFont } from "../font";
import { setThemeMode, startTheme } from "../theme";
import { SegmentedControl } from "../SegmentedControl";
import { TEXT } from "../tokens";

mount(() => {
  setThemeMode("dark");
  startTheme();
  const baseSize = signal(14);
  const day = signal<string | null>("2026-11-19");
  const picked = signal("none");
  return (
    <Window id="calendar" title="Calendar" defaultSize={{ width: 700, height: 520 }}>
      {() => (
        <View class="gap-4 p-4 bg-background grow">
          <View class="flex-row items-center gap-3">
            <SegmentedControl
              testID="base-size"
              label="Base size"
              value={String(baseSize())}
              options={[
                { value: "14", label: "14" },
                { value: "16", label: "16" },
              ]}
              onChange={(v) => {
                baseSize.set(Number(v));
                setOmarchyFont({ family: null, baseSize: Number(v) });
              }}
            />
            <Text testID="picked" class={TEXT.body}>{`Picked: ${picked()}`}</Text>
          </View>
          <View class="flex-row items-start gap-6">
            <View class="gap-2">
              <Text class={TEXT.caption}>ui</Text>
              <Calendar
                testID="ui-cal"
                value={day()}
                min="2026-11-03"
                onChange={(e) => {
                  day.set(e.value);
                  picked.set(e.value);
                }}
              />
            </View>
            <View class="gap-2">
              <Text class={TEXT.caption}>nsh-omarchy</Text>
              <OmCalendar testID="om-cal" value="2026-11-19" min="2026-11-03" />
            </View>
          </View>
        </View>
      )}
    </Window>
  );
});
