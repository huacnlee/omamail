// Finder-style surfaces for finder.test.tsx and screenshots: a finder
// Dialog (a FinderPanel field with its count, then a Results panel), a
// titled Popover (an account switcher), and a Titled panel on `muted`.
import { Text, View, mount, signal } from "nsh";
import { Window } from "nsh/desktop";
import { Button, Input } from "../Controls";
import { Dialog } from "../Dialog";
import { setOmarchyFont } from "../font";
import { PickerRow } from "../PickerRow";
import { Popover } from "../Popover";
import { setThemeMode, startTheme } from "../theme";
import { FinderPanel, Titled } from "../Titled";
import { cx, TEXT } from "../tokens";

const open = signal(false);
const picked = signal("none");

function Finder() {
  return (
    <Dialog
      testID="finder"
      variant="finder"
      title="Move to"
      width={420}
      open={open()}
      onOpenChange={(e) => open.set(e.open)}
    >
      <FinderPanel testID="finder-field" title="Folder" count="3 / 12" bodyClass={cx("p-2")}>
        <Input testID="finder-input" variant="plain" placeholder="Type to filter..." />
      </FinderPanel>
      <Titled testID="finder-results" title="Results" bodyClass={cx("p-1 pt-2")}>
        <PickerRow label="Archive" icon="archive" selected onPress={() => { picked.set("Archive"); open.set(false); }} />
        <PickerRow label="Work" icon="folder" onPress={() => { picked.set("Work"); open.set(false); }} />
        <PickerRow label="Receipts" icon="folder" onPress={() => { picked.set("Receipts"); open.set(false); }} />
      </Titled>
    </Dialog>
  );
}

function App() {
  return (
    <View class="flex-1 bg-background">
      <View class={cx("flex-row flex-wrap items-center gap-2 p-4")}>
        <Button testID="base-14" label="Base 14" size="small" onPress={() => setOmarchyFont({ family: null, baseSize: 14 })} />
        <Button testID="base-16" label="Base 16" size="small" onPress={() => setOmarchyFont({ family: null, baseSize: 16 })} />
        <Button testID="theme-dark" label="Ink" size="small" onPress={() => setThemeMode("dark")} />
        <Button testID="theme-light" label="Paper" size="small" onPress={() => setThemeMode("light")} />
        <Button testID="theme-omarchy" label="Omarchy" size="small" onPress={() => setThemeMode("omarchy")} />
        <Button testID="open-finder" label="Move to..." onPress={() => open.set(true)} />
        <Text testID="picked" class={TEXT.caption}>{`Picked: ${picked()}`}</Text>
      </View>
      <View class={cx("flex-row gap-6 p-6")}>
        <View testID="dock" class={cx("w-72 p-4 pt-6 bg-muted")}>
          <Titled testID="muted-panel" title="Proposal" surface="muted" bodyClass={cx("p-3 gap-1")}>
            <Text class={TEXT.body}>Archive 12 newsletters.</Text>
            <Text class={TEXT.caption}>On muted, the knockout is muted too.</Text>
          </Titled>
        </View>
        <View class={cx("flex-1 justify-end")}>
          <Popover
            testID="switcher"
            title="Accounts"
            placement="top"
            width={250}
            padded={false}
            trigger={<Button testID="switcher-trigger" label="Switch account..." size="small" />}
          >
            <View class={cx("p-1")}>
              <PickerRow label="Jane Doe" detail="jane@example.com" icon="inbox" selected />
              <PickerRow label="Work" detail="jane@work.example" icon="inbox" />
            </View>
          </Popover>
        </View>
      </View>
      <Finder />
    </View>
  );
}

mount(() => {
  setThemeMode("dark");
  startTheme();
  return (
    <Window id="finder-app" title="Omamail finder" defaultSize={{ width: 820, height: 640 }}>
      {() => <App />}
    </Window>
  );
});
