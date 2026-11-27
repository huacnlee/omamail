// The ui layer's redrawn nsh-omarchy components beside nsh-omarchy's own, at
// a chosen base size, for parity.test.tsx and a look:
// `nsh run src/ui/fixtures/ParityApp.tsx`.
import { mount, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import {
  Checkbox as OmCheckbox,
  ListItem as OmListItem,
  Omarchy,
  Switch as OmSwitch,
  Tab as OmTab,
  Tabs as OmTabs,
  Tooltip as OmTooltip,
} from "nsh-omarchy";
import { Button, ListItem } from "../Controls";
import { ConfirmHost, confirm } from "../Confirm";
import { setOmarchyFont } from "../font";
import { setThemeMode, startTheme } from "../theme";
import { SegmentedControl } from "../SegmentedControl";
import { Tab, Tabs } from "../Tabs";
import { Checkbox, Switch } from "../Toggles";
import { Tooltip } from "../Tooltip";
import { TEXT } from "../tokens";

function Side(props: { name: string; children: unknown }) {
  return (
    <View class="gap-2 items-start">
      <Text class={TEXT.caption}>{props.name}</Text>
      {props.children as never}
    </View>
  );
}

mount(() => {
  setThemeMode("dark");
  startTheme();
  const baseSize = signal(14);
  const tab = signal("inbox");
  const answer = signal("none");
  return (
    <Window id="parity" title="Parity" defaultSize={{ width: 900, height: 700 }}>
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
            <Button
              testID="ask"
              label="Delete..."
              onPress={() =>
                void confirm({ title: "Delete this label?", description: "Messages keep their other labels.", actionLabel: "Delete", tone: "danger" })
                  .then((yes) => answer.set(yes ? "yes" : "no"))
              }
            />
            <Text testID="answer" class={TEXT.body}>{`Answer: ${answer()}`}</Text>
          </View>
          <View class="flex-row gap-8">
            <Side name="ui">
              <View testID="ui-cb"><Checkbox label="Remember" checked /></View>
              <View testID="ui-cb-off"><Checkbox label="Unread only" /></View>
              <View testID="ui-cb-mixed"><Checkbox label="Select all" indeterminate /></View>
              <View testID="ui-sw"><Switch label="Notify" checked /></View>
              <View testID="ui-sw-off"><Switch label="Sounds" /></View>
              <View testID="ui-tip"><Tooltip label="Compose" shortcut="c" /></View>
              <View testID="ui-tabs">
                <Tabs value={tab()} variant="segmented" size="small" accessibilityLabel="Mailboxes" onChange={(e) => tab.set(e.value)}>
                  <Tab value="inbox" label="Inbox" />
                  <Tab value="sent" label="Sent" />
                </Tabs>
              </View>
              <View testID="ui-tabs-line">
                <Tabs accessibilityLabel="Sections">
                  <Tab value="a" label="General" />
                  <Tab value="b" label="Accounts" />
                </Tabs>
              </View>
              <View testID="ui-li" class="w-[200px]"><ListItem selected accessibilityLabel="Row"><Text class={TEXT.body}>Row</Text></ListItem></View>
            </Side>
            <Side name="nsh-omarchy">
              <View testID="om-cb"><OmCheckbox label="Remember" checked /></View>
              <View testID="om-cb-off"><OmCheckbox label="Unread only" /></View>
              <View testID="om-cb-mixed"><OmCheckbox label="Select all" indeterminate /></View>
              <View testID="om-sw"><OmSwitch label="Notify" checked /></View>
              <View testID="om-sw-off"><OmSwitch label="Sounds" /></View>
              <View testID="om-tip"><OmTooltip label="Compose" shortcut="c" /></View>
              <View testID="om-tabs">
                <OmTabs value={tab()} variant="segmented" size="small" accessibilityLabel="Mailboxes">
                  <OmTab value="inbox" label="Inbox" />
                  <OmTab value="sent" label="Sent" />
                </OmTabs>
              </View>
              <View testID="om-tabs-line">
                <OmTabs accessibilityLabel="Sections">
                  <OmTab value="a" label="General" />
                  <OmTab value="b" label="Accounts" />
                </OmTabs>
              </View>
              <View testID="om-li" class="w-[200px]"><OmListItem selected accessibilityLabel="Row"><Text class={TEXT.body}>Row</Text></OmListItem></View>
            </Side>
          </View>
          <ConfirmHost />
        </View>
      )}
    </Window>
  );
});
