// The header: the app's name and menu, the search field centred on the
// window, and the mailbox's own actions (check mail, compose). The sidebar
// toggle sits beside the menu, as in Qt's header. Port of
// App.qml's `header`. Hidden while composing: the draft has its own bar.
import { cleanup, signal, Text, View, type JSX } from "nsh";
import { app } from "../app/store";
import { hasCommand, keyReport, runCommand } from "../keys/commands";
import { Button, cx, LINE, sizedBox, TEXT, TitleBar, ToolButton, Tooltip, uiScale } from "../ui";
import { AppMenu } from "./AppMenu";
import type { Mode } from "./layout";
import { releaseSearchFocus, SearchBar } from "./SearchBar";

export interface HeaderProps {
  mode: Mode;
  /** The sidebar can show here (not compact, not composing): its toggle's
   * one home is the header, next to the menu (DESIGN.md v2, "One control
   * per command"); `[` and the app menu reach it too. */
  sidebarToggle: boolean;
  canQuit: boolean;
  onQuit: () => void;
}

const height = signal(0);

/** The header's height in base-14 points (unscaled), 0 while it is not shown:
 * what panels over the window leave uncovered (the shortcut sheet). */
export function headerHeight(): number {
  return height() / uiScale();
}

// STOPGAP (SearchBar.tsx releaseSearchFocus; remove with it): on macOS a
// press in the title bar's area is lost while the search field has the
// focus. The pointer coming over one of the header's buttons (each button,
// not the gaps between them), or a touch on one, releases the field first;
// releaseSearchFocus does nothing unless the field holds the focus.
function ReleasesSearch(props: { children: JSX.Element }) {
  return (
    <View onMouseEnter={() => releaseSearchFocus()} onTouchStartCapture={() => releaseSearchFocus()}>
      {props.children}
    </View>
  );
}

export function Header(props: HeaderProps) {
  cleanup(() => height.set(0));
  const mailTools = () => !app.showPage() && !app.composing() && !app.calendarVisible();
  const ready = () => app.accounts().length > 0;
  const loading = () => keyReport().listLoading === true;
  return (
    <View onLayout={(e) => height.set(e.bounds.size.height)}>
    <TitleBar title={props.mode === "compact" ? null : "Omamail"} class={cx(sizedBox("h-11", "h", 44), LINE.divider)}>
      <View class={cx("flex-1 flex-row items-center gap-3")}>
        <View class={cx("flex-row items-center gap-1")}>
          <ReleasesSearch>
            <AppMenu canQuit={props.canQuit} onQuit={props.onQuit} />
          </ReleasesSearch>
          <If when={props.sidebarToggle}>
            <ReleasesSearch>
              <ToolButton
                testID="header-sidebar-toggle"
                icon="sidebar"
                iconOnly
                // Ghost at rest: the label says which way it goes, and the
                // sidebar itself shows whether it is out.
                label={app.sidebarCollapsed() ? "Show the sidebar" : "Hide the sidebar"}
                shortcut="["
                onPress={() => {
                  if (!runCommand("toggleSidebar")) app.toggleSidebar();
                }}
              />
            </ReleasesSearch>
          </If>
        </View>
        <View class="flex-1 flex-row justify-center">
          <If when={mailTools()}>
            <View class={"w-full " + sizedBox("max-w-[340px]", "max-w", 340) + " " + sizedBox("min-w-[120px]", "min-w", 120)}>
              <SearchBar />
            </View>
          </If>
        </View>
        <If when={mailTools()}>
          <View class={cx("flex-row items-center gap-2")}>
            <ReleasesSearch>
              <ToolButton
                icon="refresh"
                iconOnly
                label={loading() ? "Checking for mail" : "Check mail"}
                loading={loading()}
                disabled={!ready() || loading() || !hasCommand("refresh")}
                shortcut="f5"
                onPress={() => runCommand("refresh")}
              />
            </ReleasesSearch>
            <ReleasesSearch>
              <Button
                label="Compose"
                size="small"
                disabled={!ready()}
                tooltip={<Tooltip label="Compose" shortcut="c" />}
                onPress={() => {
                  if (!runCommand("compose")) app.openOverlay("compose");
                }}
              />
            </ReleasesSearch>
          </View>
        </If>
        <If when={!ready() && app.showPage()}>
          <Text class={TEXT.caption}>Add a mailbox to start</Text>
        </If>
      </View>
    </TitleBar>
    </View>
  );
}
