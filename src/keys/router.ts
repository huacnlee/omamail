// The one router: binds every sequence the table makes live in the current
// context through `keymap.bind`, and only those, so a key that does nothing
// here is not consumed and reaches the focused control. Port of
// omarchy/ui/components/KeyRouter.qml and App.qml's goBack (docs/KEYS.md).
import { computed, effect, keymap as nshKeymap, untracked } from "nsh";
import { focusedWindow } from "nsh/desktop";
import { app } from "../app/store";
import { hasCommand, keyReport, runCommand, runEscapeLayers, keyLayer } from "./commands";
import * as Keys from "./keymap";
import { imeComposing, textInputActive } from "../ui";

/** The id compose gives the window a draft moves to (features/compose). */
const COMPOSE_WINDOW = "compose";

/** A draft's own window has the keyboard (reactive): its keys are compose's
 * then, whatever the mail window behind it shows. */
export const composeWindowFocused = computed(() => {
  try {
    return focusedWindow()?.id === COMPOSE_WINDOW;
  } catch {
    // No desktop windows here (a phone, the web).
    return false;
  }
});

/** The window's keyboard context (reactive). */
export const keyContext = computed<Keys.KeyContext>(() => {
  const report = keyReport();
  if (composeWindowFocused()) {
    return Keys.contextFor({ assistantEditing: report.assistantEditing, assistantCommands: report.assistantCommands,
      composing: true });
  }
  return Keys.contextFor({
    ...report,
    showPage: app.showPage(),
    composing: app.composing() || report.composing === true,
    eventComposing: app.navOverlay()?.kind === "eventComposer" || report.eventComposing === true,
    searchFocused: app.searchFocused(),
    calendarVisible: app.calendarVisible(),
    currentView: app.readerOpen() ? "reader" : "list",
  });
});

/** Escape: the nearest thing to leave, in docs/KEYS.md's order. */
export function goBack(): void {
  // The shortcut sheet is the topmost thing whenever it is up.
  if (app.helpOpen()) {
    app.toggleHelp();
    return;
  }
  // Guest suggestions, a calendar preview, the assistant's commands, history
  // or a running reply, a compose agent: whatever registered a layer.
  if (runEscapeLayers()) return;
  // In the draft's own window the mail window's popups and ticks are not in
  // reach; Escape is the draft's.
  if (composeWindowFocused()) {
    back();
    return;
  }
  // A popup that is not a place (accounts, labels, move).
  const overlay = app.overlay();
  if (overlay !== "" && overlay !== "compose" && overlay !== "eventComposer" && overlay !== "shortcuts") {
    app.closeOverlay();
    return;
  }
  // Ticked rows untick and go nowhere, as in every file manager.
  if (app.checked().length > 0 && !app.showPage() && !app.composing() && !app.calendarVisible()) {
    app.setChecked([]);
    return;
  }
  back();
}

/** Back one place. A draft, an event being written and an event's detail
 * close through their own feature, which may ask first. */
export function back(): void {
  // The draft's own window: back is leaving the draft, which may ask first.
  if (composeWindowFocused()) {
    runCommand("leave:compose");
    return;
  }
  const top = app.nav()[app.nav().length - 1];
  if (top && (top.kind === "compose" || top.kind === "eventComposer" || top.kind === "calendarDetail")) {
    if (runCommand("leave:" + top.kind)) return;
  }
  app.back();
}

/** What the shell does for an id no feature answers. */
const SHELL: Record<string, (event: { slot: number }) => void> = {
  back: () => goBack(),
  help: () => app.toggleHelp(),
  search: () => app.focusSearch(),
  settings: () => app.openPage("settings"),
  // A new message, as the header's Compose does; a feature that edits the
  // draft under the cursor (Drafts) registers "compose" and wins.
  compose: () => app.openOverlay("compose"),
  toggleSidebar: () => app.toggleSidebar(),
  calendar: () => app.openPage(app.calendarVisible() ? "mail" : "calendar"),
  mailView: () => app.openPage("mail"),
  calendarView: () => app.openPage("calendar"),
  backToList: () => app.closeReader(),
  openReader: () => {
    const id = app.cursorId();
    if (id !== "") app.select(id);
  },
  open: () => {
    const id = app.cursorId();
    if (id !== "") app.select(id);
  },
  goAccount: ({ slot }) => {
    const target = app.accounts()[slot];
    if (target) app.openAccount(target.id);
  },
};

/** Ids the shell runs itself even when a feature registered them. */
const SHELL_FIRST = new Set(["back", "help"]);

/** Rows whose held key repeats (moving, scrolling). */
const REPEATS = new Set([
  "cursorDown", "cursorUp", "scrollDown", "scrollUp", "calendarNext", "calendarPrevious",
  "guestNext", "guestPrevious", "assistantCommandNext", "assistantCommandPrevious",
  "calendarPreviousPeriod", "calendarNextPeriod", "nextMember", "previousMember",
]);

function dispatch(entry: Keys.SequenceEntry): void {
  const slot = Keys.slotFor(entry.id, entry.sequence);
  const shell = SHELL[entry.id];
  if (shell && SHELL_FIRST.has(entry.id)) {
    shell({ slot });
    return;
  }
  if (runCommand(entry.id, slot, entry.sequence)) return;
  if (shell) shell({ slot });
}

/** The live table for a context: one entry per keystroke, the first row
 * that claims it (the table has no conflicts within a context, and two
 * spellings of one key, Return and Enter, collapse here). */
export function liveEntries(context: Keys.KeyContext, overlay: boolean,
  answered: (id: string) => boolean): Array<{ keystroke: string; entry: Keys.SequenceEntry }> {
  const out: Array<{ keystroke: string; entry: Keys.SequenceEntry }> = [];
  const seen = new Set<string>();
  for (const entry of Keys.sequencesFor(context)) {
    if (!Keys.isSequenceEnabled(entry.binding, entry.sequence, context, overlay)) continue;
    if (!answered(entry.id)) continue;
    const keystroke = Keys.nshKeystroke(entry.sequence);
    if (seen.has(keystroke)) continue;
    seen.add(keystroke);
    out.push({ keystroke, entry });
  }
  return out;
}

/** Keys OverlayPanel's content handles itself (ui/OverlayPanel.tsx). */
const SHEET_KEYS = ["up", "down", "pageup", "pagedown", "home", "end", "space", "shift+space"];

/** A key that types a character in a field: one character, or Shift and one
 * character ("shift+j", "shift+/"). */
export function isPlainKey(keystroke: string): boolean {
  const k = keystroke.toLowerCase();
  if (k.length === 1) return true;
  if (k.startsWith("shift+") && k.length === 7) return true;
  return k === "space" || k === "shift+space";
}

/** Binds the router for as long as the calling component is mounted. Call it
 * from a component inside the window. */
export function useKeyRouter(): void {
  effect(() => {
    // An input method is composing (pinyin, kana, hangul): Return picks a
    // candidate and Escape cancels it, so no shortcut is bound at all, not
    // even a layer's or Escape. They come back when the composition ends.
    if (imeComposing()) return;
    // A text field has the focus: its letters are being typed, so the plain
    // single-key shortcuts stand aside even where they would be "always".
    const fieldActive = textInputActive();
    const context = keyContext();
    const overlay = app.helpOpen();
    const entries = liveEntries(context, overlay, (id) => id in SHELL || hasCommand(id));
    const typing = (Keys.TEXT_CONTEXTS as readonly string[]).includes(context);
    const layer = keyLayer();
    const taken = new Set(layer ? Object.keys(layer) : []);
    const layerUnbinds = untracked(() => [...taken].map((keystroke) =>
      nshKeymap.bind(keystroke, () => layer![keystroke](), { when: "always", repeat: true })));
    // The shortcut sheet's content scrolls itself on these while it has the
    // focus; an app binding of them would take them first.
    if (overlay) for (const key of SHEET_KEYS) taken.add(key);
    const unbinds = untracked(() => entries.filter(({ keystroke }) => !taken.has(keystroke)
      && !(fieldActive && isPlainKey(keystroke))).map(({ keystroke, entry }) => {
      // In a context made for typing, its few keys win over the field; Escape
      // wins everywhere, since leaving is never the field's to refuse.
      const always = typing || entry.sequence === "Escape";
      return nshKeymap.bind(keystroke, () => dispatch(entry), {
        when: always ? "always" : undefined,
        repeat: REPEATS.has(entry.id),
      });
    }));
    return () => {
      for (const unbind of unbinds) unbind();
      for (const unbind of layerUnbinds) unbind();
    };
  });
}

/** Whether there is a step back that is not closing the window (Qt's
 * MouseBack.canGoBack): history, ticked rows, a focused or filled search. */
export function canGoBack(): boolean {
  return app.nav().length > 1 || app.helpOpen() || app.checked().length > 0
    || app.searchFocused() || app.query() !== "" || (app.overlay() !== "" && app.overlay() !== "shortcuts");
}

/** The mouse's back button: Escape's intent, except that it never closes the
 * window. A layer (the assistant, a popup) still takes it first. */
export function mouseBack(): void {
  if (canGoBack()) goBack();
  else runEscapeLayers();
}
