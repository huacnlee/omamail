// The window menu behind the header's menu button. Port of
// omarchy/ui/components/AppMenu.qml: the rows, their order and their
// conditions are the Qt menu's. Rows that open another surface end in "...".
// While it is open, j / k and Up / Down walk a cursor that starts nowhere (no
// row reads as "where you are"), and Return or o runs the row under it.
import { batch, openUrl, signal, View } from "nsh";
import { app } from "../app/store";
import { hasCommand, keyReport, pushKeyLayer, registerEscape, runCommand } from "../keys/commands";
import { chordLabel } from "../keys/labels";
import { Kbd, NavRow, Popover, Separator, sizedBox, ToolButton, type IconKey, cx } from "../ui";
import { nextSelectable } from "./menuCursor";

export const PROJECT_URL = "https://github.com/huacnlee/omamail";
export const AUTHOR_URL = "https://x.com/huacnlee";

async function openExternal(url: string) {
  try {
    const result = await openUrl(url);
    if (!result.opened) app.setNotice("No app opened " + url);
  } catch {
    app.setNotice("Could not open " + url);
  }
}

export interface AppMenuProps {
  /** Quit is offered where the window is the app's own (standalone). */
  canQuit: boolean;
  onQuit: () => void;
}

interface Row {
  id: string;
  label: string;
  icon?: IconKey;
  /** The key that does the same from anywhere, as the keymap writes it. */
  keys?: string;
  visible: boolean;
  enabled: boolean;
  /** A rule above it. */
  separated?: boolean;
  run: () => void;
}

export function AppMenu(props: AppMenuProps) {
  const open = signal(false);
  const cursor = signal(-1);
  const signedIn = () => app.accounts().length > 0;
  const rows = (): Row[] => [
    { id: "inbox", label: "Inbox", icon: "inbox", visible: true, enabled: true, run: () => app.openMailbox("inbox") },
    {
      id: "calendar", label: "Calendar", icon: "calendar", visible: keyReport().calendarAvailable !== false,
      enabled: true, run: () => app.openPage("calendar"),
    },
    {
      id: "markRead", label: "Mark these read", icon: "read", visible: true, separated: true,
      enabled: signedIn() && hasCommand("markAllRead"), run: () => runCommand("markAllRead"),
    },
    {
      id: "web", label: "Open web inbox...", icon: "browser", visible: keyReport().canOpenWebInbox === true,
      enabled: signedIn(), run: () => runCommand("openWebInbox"),
    },
    {
      id: "switch", label: "Switch account...", icon: "people", keys: "Alt+A", visible: app.accounts().length > 1,
      enabled: true, run: () => runCommand("switchAccount"),
    },
    { id: "settings", label: "Settings...", icon: "settings", keys: "Ctrl+,", visible: true, enabled: true, run: () => app.openPage("settings") },
    {
      id: "keyboard", label: "Keyboard...", icon: "keyboard", keys: "?", visible: true, enabled: true, separated: true,
      run: () => app.openOverlay("shortcuts"),
    },
    { id: "github", label: "GitHub...", icon: "code", visible: true, enabled: true, run: () => void openExternal(PROJECT_URL) },
    { id: "twitter", label: "Twitter...", icon: "browser", visible: true, enabled: true, run: () => void openExternal(AUTHOR_URL) },
    { id: "quit", label: "Quit", icon: "logout", visible: props.canQuit, enabled: true, separated: true, run: () => props.onQuit() },
  ];
  const setOpen = (value: boolean) =>
    batch(() => {
      open.set(value);
      cursor.set(-1);
    });
  const choose = (row: Row | undefined) => {
    if (!row || !row.visible || !row.enabled) return;
    setOpen(false);
    row.run();
  };
  return (
    <Popover
      testID="app-menu"
      open={open()}
      placement="bottom"
      align="start"
      onOpenChange={(e) => setOpen(e.open)}
      trigger={<ToolButton icon="menu" iconOnly label="Menu" selected={open()} popupOpen={open()} testID="app-menu-button" />}
    >
      <If when={open()}>
        <MenuKeys
          onMove={(step) => cursor.set(nextSelectable(rows(), cursor(), step))}
          onRun={() => choose(rows()[cursor()])}
          onClose={() => setOpen(false)}
        />
        {/* At least 210 points, wider when a larger base size or a wide font
            needs it: a row's label is never cut. */}
        <View class={sizedBox("min-w-[210px]", "min-w", 210) + " gap-0.5 p-1"} role="menu" accessibilityLabel="Menu">
          <Each of={rows()} key={(row: Row) => row.id}>
            {(row: () => Row, index: () => number) => (
              <If when={row().visible}>
                <If when={row().separated}>
                  <View class={cx("my-1")}><Separator /></View>
                </If>
                <NavRow
                  testID={"app-menu-" + row().id}
                  label={row().label}
                  icon={row().icon}
                  selected={cursor() === index()}
                  dimmed={!row().enabled}
                  trailing={row().keys ? <Kbd keys={chordLabel(row().keys!)} /> : undefined}
                  onPress={() => choose(row())}
                />
              </If>
            )}
          </Each>
        </View>
      </If>
    </Popover>
  );
}

/** The menu's keys, taken from the router while it is open. */
function MenuKeys(props: { onMove: (step: number) => void; onRun: () => void; onClose: () => void }) {
  pushKeyLayer({
    j: () => props.onMove(1),
    down: () => props.onMove(1),
    k: () => props.onMove(-1),
    up: () => props.onMove(-1),
    enter: () => props.onRun(),
    o: () => props.onRun(),
  });
  registerEscape(() => {
    props.onClose();
    return true;
  });
  return null;
}
