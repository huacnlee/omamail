// Escape-dismissable ui surfaces with a field inside, for overlays.test.tsx:
// none closes on an Escape an input method takes, and nested overlays close
// one per Escape, the topmost first.
import { mount, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { Button, Input } from "../Controls";
import { Dialog, Sheet } from "../Dialog";
import { OverlayPanel } from "../OverlayPanel";
import { Popover } from "../Popover";
import { Select } from "../Select";
import { setThemeMode, startTheme } from "../theme";
import { TEXT } from "../tokens";

mount(() => {
  setThemeMode("dark");
  startTheme();
  const popover = signal(false);
  const dialog = signal(false);
  const sheet = signal(false);
  const panel = signal(false);
  const inner = signal(false);
  const state = () =>
    [popover() && "popover", dialog() && "dialog", inner() && "inner", sheet() && "sheet", panel() && "panel"].filter((x) => x).join(",") || "none";
  return (
    <Window id="overlays" title="Overlays" defaultSize={{ width: 720, height: 640 }}>
      {() => (
        <View class="gap-3 p-4 bg-background grow">
          <Text testID="state" class={TEXT.body}>{`Open: ${state()}`}</Text>
          <View class="flex-row gap-2">
            <Popover
              testID="pop"
              open={popover()}
              onOpenChange={(e) => popover.set(e.open)}
              trigger={<Button testID="open-pop" label="Popover..." />}
            >
              <Input testID="pop-field" placeholder="Filter" />
            </Popover>
            <Button testID="open-dialog" label="Dialog..." onPress={() => dialog.set(true)} />
            <Button testID="open-sheet" label="Sheet..." onPress={() => sheet.set(true)} />
            <Button testID="open-panel" label="Panel..." onPress={() => panel.set(true)} />
          </View>
          <Dialog testID="dlg" title="Dialog" open={dialog()} onOpenChange={(e) => dialog.set(e.open)}>
            <Input testID="dlg-field" placeholder="Name" />
            <Select
              testID="dlg-select"
              accessibilityLabel="Theme"
              placeholder="Choose"
              items={[
                { value: "a", label: "Alpha" },
                { value: "b", label: "Beta" },
              ]}
            />
            <Popover
              testID="inner"
              open={inner()}
              onOpenChange={(e) => inner.set(e.open)}
              trigger={<Button testID="open-inner" label="Inner..." />}
            >
              <Text>Inside the dialog</Text>
            </Popover>
          </Dialog>
          <Sheet testID="sht" title="Sheet" open={sheet()} onOpenChange={(e) => sheet.set(e.open)}>
            <Input testID="sheet-field" placeholder="Note" />
          </Sheet>
          <OverlayPanel testID="pnl" title="Panel" open={panel()} onOpenChange={(open) => panel.set(open)} headerAccessory={<Input testID="panel-field" placeholder="Filter" />}>
            <Text>Panel content</Text>
          </OverlayPanel>
        </View>
      )}
    </Window>
  );
});
