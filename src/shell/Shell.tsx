// The window: header, body (navigation, collection, content), status bar and
// the overlay layer, in the regions docs/DESIGN.md fixes. Owner: the shell
// agent. Features are slotted in by their exported components; the shell
// decides only where each sits and when it shows.
import { cleanup, effect, signal, untracked, View, windowSize, type KeyEvent } from "nsh";
import { currentWindow } from "nsh/desktop";
import { loadAccounts } from "../app/bootstrap";
import { persistPrefs, prefs } from "../app/prefs";
import { app } from "../app/store";
import { AccountSetup, startAccounts } from "../features/accounts";
import { AssistantDock } from "../features/assistant";
import { CalendarService, CalendarView } from "../features/calendar";
import { ComposeSurface, openCompose } from "../features/compose";
import { MessageList } from "../features/list";
import { MailboxSidebar, MailboxTabs, mailboxStore } from "../features/mailbox";
import { Reader } from "../features/reader";
import { SettingsPage, settings } from "../features/settings";
import { keyReport, registerCommand } from "../keys/commands";
import { keyContext, mouseBack, useKeyRouter } from "../keys/router";
import { isApple } from "../keys/labels";
import { ConfirmHost, cx, FILL, SplitPane, SplitPanel, Toaster, uiScale } from "../ui";
import { Header } from "./Header";
import { migrateLegacyMailClient, startLaunchLinks } from "./launch";
import { bodyFor, LIST, listWidthFor, modeFor, SIDEBAR, sidebarVisible, sidebarWidthFor, type BodyState } from "./layout";
import { animateNextLayout } from "./motion";
import { ShortcutHelp } from "./ShortcutHelp";
import { hidesOnClose } from "./windowFocus";
import { StatusBar } from "./StatusBar";
import { checkForUpdatesQuietly } from "./updates";

export interface ShellProps {
  /** The window is the app's own, so the menu offers Quit. */
  canQuit?: boolean;
  onQuit?: () => void;
  /** Read the launch's and later launches' mailto: links (default true).
   * Fixtures turn it off: this process's arguments are not theirs. */
  launchLinks?: boolean;
  /** Look for a newer release once at launch (default true). */
  updates?: boolean;
}

export function Shell(props: ShellProps) {
  persistPrefs();
  useKeyRouter();
  void loadAccounts();
  // Stored settings (appearance, undo window, list paging) apply from the
  // start, not from the first visit to Settings; both calls are idempotent.
  void settings.load();
  startAccounts();
  // A second launch with a mailto: link (Linux, Windows) opens a draft here.
  if (props.launchLinks !== false) {
    const stopLinks = startLaunchLinks((request) => openCompose(request));
    cleanup(stopLinks);
    // A Qt-era plugin user's SUPER+SHIFT+E and mailto: default still point
    // at the old plugin; this app takes them over once (Linux only).
    migrateLegacyMailClient();
  }
  if (props.updates !== false) checkForUpdatesQuietly();

  // `[` and the status bar's switch fold the sidebar with a layout ease.
  registerCommand("toggleSidebar", () => {
    animateNextLayout();
    app.toggleSidebar();
  });

  const mode = () => modeFor(windowSize().width, keyReport().assistantWidth ?? 0, uiScale());
  const state = (): BodyState => ({
    mode: mode(),
    showPage: app.showPage(),
    composing: app.composing(),
    calendarVisible: app.calendarVisible(),
    readerOpen: app.readerOpen(),
  });
  const body = () => bodyFor(state());
  const compact = () => mode() === "compact";

  // Back on a root closes the window, as the Qt client's requestClose did;
  // on macOS it hides it, as the close button does (the app stays in the Dock).
  const window = currentWindow();
  effect(() => {
    if (app.closeRequests() > 0) untracked(() => (hidesOnClose() ? window.hide() : window.close()));
  });

  // Holding the mailbox digits' modifier (Ctrl; Command on Apple platforms,
  // where the table's Ctrl is bound as Command) names every rail row. A
  // modifier alone binds nothing, so it is read off the raw key events and
  // accepts nothing. Losing the window's focus clears it: the release can
  // land in another window, and the numbers would stay painted on.
  const held = signal(false);
  const heldKey = () => (isApple() ? "Meta" : "Control");
  const onKey = (e: KeyEvent, down: boolean) => {
    if (e.key === heldKey()) held.set(down);
    else if (down && !(isApple() ? e.modifiers.platform : e.modifiers.control)) held.set(false);
  };
  window.on("focusChange", (e) => {
    if (!e.focused) held.set(false);
  });
  effect(() => {
    const context = keyContext();
    const show = held() && (context === "list" || context === "reader");
    untracked(() => mailboxStore.setSlotHintsVisible(show));
  });

  return (
    <View
      class="flex-1 bg-background"
      onKeyDown={(e) => onKey(e, true)}
      onKeyUp={(e) => onKey(e, false)}
      onMouseUp={(e) => {
        // The mouse's back button carries Escape's intent (MouseBack.qml).
        if (e.button === "back") mouseBack();
      }}
    >
      <If when={!app.composing()}>
        <Header mode={mode()} sidebarToggle={sidebarVisible(state())} canQuit={props.canQuit === true} onQuit={() => props.onQuit?.()} />
      </If>
      <View class="flex-1 flex-row">
        <View class="flex-1">
          <If when={body() === "page"}>
            <If when={app.navPage().kind === "settings"} else={<AccountSetup />}>
              <SettingsPage />
            </If>
          </If>
          <If when={body() === "compose"}>
            <ComposeSurface />
          </If>
          <If when={body() !== "page" && body() !== "compose"}>
            <SplitPane
              label="Sidebar width"
              onResize={(sizes) => {
                if (sidebarVisible(state()) && !app.sidebarCollapsed() && sizes.length > 1) prefs.setSidebarWidth(sizes[0]);
              }}
              onReset={() => prefs.setSidebarWidth(0)}
            >
              <SplitPanel
                testID="sidebar-pane"
                visible={sidebarVisible(state())}
                fixed
                size={sidebarWidthFor(prefs.sidebarWidth(), app.sidebarCollapsed(), uiScale())}
                minSize={(app.sidebarCollapsed() ? SIDEBAR.rail : SIDEBAR.min) * uiScale()}
                maxSize={(app.sidebarCollapsed() ? SIDEBAR.rail : SIDEBAR.max) * uiScale()}
              >
                {/* The column sits on the muted well (v2 Materials); its one
                    hairline is the split's separator, owned here. */}
                <View class={cx("flex-1", FILL.inset)}>
                  <MailboxSidebar />
                </View>
              </SplitPanel>
              <SplitPanel testID="main-pane">
                <If when={body() === "calendar"} else={<MailPanes compact={compact()} />}>
                  <CalendarView />
                </If>
              </SplitPanel>
            </SplitPane>
          </If>
        </View>
        <View testID="assistant-slot" class="h-full">
          <AssistantDock />
        </View>
      </View>
      <StatusBar mode={mode()} />
      <ShortcutHelp />
      {/* Reminders, the event composer and delete confirm, on every page. */}
      <CalendarService />
      <Toaster />
      {/* Where ui confirm() asks: the main window only, not compose's. */}
      <ConfirmHost />
    </View>
  );
}

/** The list and the reader: side by side with a stored split, or in compact
 * mode one at a time. */
function MailPanes(props: { compact: boolean }) {
  const width = signal(0);
  const listShown = () => !(props.compact && app.readerOpen());
  const readerShown = () => !props.compact || app.readerOpen();
  return (
    <View class="flex-1" onLayout={(e) => width.set(e.bounds.size.width)}>
      <SplitPane
        label="Message list width"
        disabled={props.compact}
        onResize={(sizes) => {
          if (!props.compact && sizes.length > 1) prefs.setListWidth(sizes[0]);
        }}
        onReset={() => prefs.setListWidth(0)}
      >
        <SplitPanel
          testID="list-pane"
          visible={listShown()}
          size={props.compact ? null : listWidthFor(prefs.listWidth(), width(), uiScale())}
          minSize={LIST.min * uiScale()}
        >
          <View class="flex-1">
            {/* No sidebar in compact mode: the mailboxes ride above the list. */}
            <If when={props.compact}>
              <MailboxTabs />
            </If>
            <MessageList />
          </View>
        </SplitPanel>
        <SplitPanel testID="reader-pane" visible={readerShown()} minSize={LIST.readerMin * uiScale()}>
          <View class="flex-1">
            {/* One column: the reader's Back bar does what Escape does here,
                one step back off the reader to the list. */}
            <Reader onBack={props.compact ? () => app.back() : undefined} />
          </View>
        </SplitPanel>
      </SplitPane>
    </View>
  );
}
