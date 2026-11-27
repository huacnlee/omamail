// The ui DatePicker beside nsh-omarchy's, at a chosen base size, for
// datepicker.test.tsx and a look: `nsh run src/ui/fixtures/DatePickerApp.tsx`.
import { mount, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { DatePicker as OmDatePicker, Omarchy } from "nsh-omarchy";
import { DatePicker } from "../DatePicker";
import { scaled, setOmarchyFont } from "../font";
import { setThemeMode, startTheme } from "../theme";
import { SegmentedControl } from "../SegmentedControl";
import { TEXT } from "../tokens";

mount(() => {
  setThemeMode("dark");
  startTheme();
  const baseSize = signal(14);
  const day = signal<string | null>(null);
  return (
    <Window id="datepicker" title="Date picker" defaultSize={{ width: 700, height: 520 }}>
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
            <Text testID="picked" class={TEXT.body}>{`Picked: ${day() ?? "none"}`}</Text>
          </View>
          <View class="flex-row items-start gap-6">
            {/* The trigger fills its slot: this column is nsh-omarchy's 240pt. */}
            <View class="gap-2" style={{ width: scaled(240) }}>
              <Text class={TEXT.caption}>ui</Text>
              <DatePicker testID="ui-picker" accessibilityLabel="Start date" value={day()} onChange={(e) => day.set(e.value)} />
              <DatePicker testID="ui-set" value="2026-11-19" />
              {/* The event editor's row: a date slot beside a fixed time field,
                  in a row that does not grow with the base size. */}
              <View testID="ui-slot-row" class="flex-row items-center gap-2" style={{ width: 200 }}>
                <View class="flex-1 min-w-0">
                  <DatePicker testID="ui-slot" value="2026-11-19" />
                </View>
                <View
                  testID="ui-time"
                  class="shrink-0 border border-border"
                  style={{ width: scaled(68), height: scaled(30) }}
                />
              </View>
            </View>
            <View class="gap-2">
              <Text class={TEXT.caption}>nsh-omarchy</Text>
              <OmDatePicker testID="om-picker" />
              <OmDatePicker testID="om-set" value="2026-11-19" />
            </View>
          </View>
        </View>
      )}
    </Window>
  );
});
