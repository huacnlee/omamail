// The calendar page alone in a window, on one synthetic Gmail account whose
// Google calendar a stand-in backend answers. `theme` forces a palette:
// Omamail's own (Ink, Paper), or an Omarchy desktop's built-in one, drawn in
// the Omarchy mode; left out, the system's is followed.
import { Scroll, Storage, View, mount, signal } from "nsh";
import { prefs } from "../../../app/prefs";
import { Window } from "nsh/desktop";
import { app } from "../../../app/store";
import { KeyedWindow } from "../../../shell/KeyedWindow";
import { Omarchy, setOmarchyFont, setThemeMode } from "../../../ui";
import { startTheme } from "../../../ui/theme";
import { CalendarSettings, CalendarView } from "../index";

type OmarchyTheme = Parameters<typeof Omarchy.applyTheme>[0];
/** `ink` / `paper`: Omamail's palettes; any other name: that Omarchy palette. */
export type Theme = "ink" | "paper" | OmarchyTheme;
export type Page = "calendar" | "settings";

function applyTheme(theme: Theme | undefined): void {
  if (theme === "ink" || theme === "paper") setThemeMode(theme === "ink" ? "dark" : "light");
  else setThemeMode(theme ? "omarchy" : "system");
  startTheme();
  // The Omarchy mode follows the desktop as it starts; the palette lands after.
  if (theme && theme !== "ink" && theme !== "paper") setTimeout(() => Omarchy.applyTheme(theme), 0);
}

/** The calendar page, or with `page: "settings"` Settings → Calendars alone. */
export function mountCalendar(theme?: Theme, page: Page = "calendar"): void {
  // window.json is never touched by a test window.
  if (!prefs.inMemory()) prefs.useMemory();
  mount(() => {
    applyTheme(theme);
    return <CalendarWindow page={page} />;
  });
}

/** The palette, base size and page the test's storage names
 * (`calendar.palette`, `calendar.base`, `calendar.page`): the v2 shot matrix. */
export function mountStoredCalendar(): void {
  if (!prefs.inMemory()) prefs.useMemory();
  mount(() => {
    const ready = signal<Page | null>(null);
    void Promise.all([Storage.getItem("calendar.palette"), Storage.getItem("calendar.base"), Storage.getItem("calendar.page")])
      .then(([palette, base, page]) => {
        applyTheme((palette as Theme) || "ink");
        const size = Number(base || 14);
        if (size !== 14) setOmarchyFont({ family: null, baseSize: size });
        ready.set(page === "settings" ? "settings" : "calendar");
      });
    return (
      <Window id="main" title="Calendar" defaultSize={{ width: 1100, height: 800 }}>
        {() => <If when={ready() !== null}><CalendarContent page={ready()!} /></If>}
      </Window>
    );
  });
}

function CalendarWindow(props: { page: Page }) {
  return (
    <Window id="main" title="Calendar" defaultSize={{ width: 1100, height: 800 }}>
      {() => <CalendarContent page={props.page} />}
    </Window>
  );
}

/** The accounts the page needs, then the page in a keyed window. */
function CalendarContent(props: { page: Page }) {
  const page = props.page;
  const accounts = [{ id: "jane@example.com", email: "jane@example.com", provider: "gmail", label: "Jane" }];
  // Settings also shows a mail-only mailbox, which picks where accepted invitations go.
  if (page === "settings") accounts.push({ id: "imap:jane@mail.example.net", email: "jane@mail.example.net", provider: "imap", label: "Jane (IMAP)" });
  app.setAccounts(accounts);
  app.openAccount("jane@example.com");
  if (page === "calendar") app.openPage("calendar");
  return (
    <KeyedWindow>
      {page === "calendar" ? <CalendarView /> : (
        <Scroll testID="calendar-settings-scroll" class="flex-1 bg-background">
          <View class="p-6">
            <View class="w-[640px] max-w-full"><CalendarSettings onClientSetup={() => app.openPage("setup")} /></View>
          </View>
        </Scroll>
      )}
    </KeyedWindow>
  );
}
