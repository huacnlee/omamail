// The keyboard reference: every row of the keymap in balanced columns, so
// the sheet never needs a scrollbar down the middle of the window. Port of
// omarchy/ui/components/ShortcutHelp.qml. `?` toggles it, Escape closes it,
// and behind it j/k (or the arrows) scroll it.
import { signal, Text, untracked, View, windowSize, type ScrollRef } from "nsh";
import { app } from "../app/store";
import { keyReport, pushKeyLayer, registerCommand } from "../keys/commands";
import * as Keys from "../keys/keymap";
import { keyCaps } from "../keys/labels";
import { Kbd, OverlayPanel, scaled, TEXT, TYPE, uiScale, cx } from "../ui";
import { headerHeight } from "./Header";
import { helpColumnCount } from "./layout";

/** Rows the sheet leaves out where their feature is absent. */
export const AGENT_ROWS = ["askAgent", "assistantSend", "assistantChooseCommand", "assistantCommandNext", "assistantCommandPrevious"];

const STEP = 48;

export function ShortcutHelp() {
  let scroll: ScrollRef | undefined;
  let offset = 0;
  const by = (direction: number) => {
    offset = Math.max(0, offset + direction * scaled(STEP));
    scroll?.scrollTo({ y: offset, animated: true });
  };
  const hidden = () => (keyReport().hasAgent === false ? AGENT_ROWS : []);
  const columns = () => Keys.helpColumns(helpColumnCount(windowSize().width, uiScale()), hidden());

  // Only while the sheet is up. The panel's content scrolls itself on the
  // arrows, the page keys and Home / End while it has the focus; j / k and
  // Shift+J / K are the app's, as in Qt. Behind the sheet the list's cursor
  // and scroll commands do nothing, so a key the panel does not take cannot
  // move the list.
  const Scroller = () => {
    pushKeyLayer({ j: () => by(1), k: () => by(-1), "shift+j": () => by(1), "shift+k": () => by(-1) });
    for (const id of ["cursorDown", "scrollDown", "cursorUp", "scrollUp"]) registerCommand(id, () => {});
    return null;
  };

  return (
    <OverlayPanel
      testID="shortcut-help"
      title="Keyboard shortcuts"
      // Over the panes, under the header, as Qt's sheet filled the content area.
      top={headerHeight()}
      open={app.helpOpen()}
      scrollRef={(r) => (scroll = r)}
      onScroll={(e) => (offset = e.offset.y)}
      onOpenChange={(open) => {
        if (!open && app.helpOpen()) app.toggleHelp();
      }}
    >
      <If when={app.helpOpen()}>
        <Scroller />
      </If>
      <View class={cx("flex-row gap-8 px-1 pb-8")}>
        <Each of={columns()} key="index">
          {(column) => (
            <View class={cx("flex-1 gap-4")}>
              <Each of={column()} key={(g) => g.name}>
                {(group) => {
                  // The lane is as wide as this section's widest row of caps,
                  // measured, so the actions line up beside their keys.
                  const widest = signal(0);
                  return (
                    <View class={cx("gap-1.5")}>
                      <Text class={TEXT.section} role="header">{group().name}</Text>
                      <Each of={group().rows} key="index">
                        {(row) => (
                          <View class={cx("flex-row items-start gap-4")}>
                            <View style={{ minWidth: widest() }}>
                              {/* One cap per key, as this platform writes it (⇧J, ⌘↩). */}
                              <View
                                testID={`help-keys-${group().name}-${group().rows.indexOf(row())}`}
                                class={cx("flex-row gap-1 self-start")}
                                onLayout={(e) => {
                                  const width = Math.ceil(e.bounds.size.width);
                                  if (width > untracked(widest)) widest.set(width);
                                }}
                              >
                                <Each of={keyCaps(row().keys)} key="index">
                                  {(cap) => <Kbd keys={cap()} />}
                                </Each>
                              </View>
                            </View>
                            <Text
                              testID={`help-action-${group().name}-${group().rows.indexOf(row())}`}
                              class={cx("flex-1 self-center", TYPE.md, "text-foreground")}
                            >
                              {row().action}
                            </Text>
                          </View>
                        )}
                      </Each>
                    </View>
                  );
                }}
              </Each>
            </View>
          )}
        </Each>
      </View>
    </OverlayPanel>
  );
}
