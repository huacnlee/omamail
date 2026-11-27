// Port of omarchy/ui/tests/test_keymap.js, plus the keystrokes NSH binds.
import { keymap as nshKeymap } from "nsh";
import { expect, test } from "nsh/test";
import * as keymap from "./keymap";

const byId = (id: string) => keymap.byId(id)!;
const labels = (hints: keymap.Hint[]) => hints.map((h) => h.key + " " + h.label);

test("every row is whole and every id unique", () => {
  expect(keymap.BINDINGS.length > 20).toBe(true);
  for (const b of keymap.BINDINGS) {
    expect(!!b.id && !!b.group && !!b.label && b.keys.length > 0).toBe(true);
    for (const c of b.contexts) expect(c === "*" || (keymap.CONTEXTS as readonly string[]).includes(c)).toBe(true);
  }
  const ids = keymap.BINDINGS.map((b) => b.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(keymap.conflicts()).toEqual([]);
});

test("text-entry contexts bind no bare key but Escape", () => {
  for (const context of ["search", "compose", "page"]) {
    for (const b of keymap.bindingsFor(context)) {
      for (const key of b.keys) expect(!keymap.isBare(key) || key === "Escape").toBe(true);
    }
  }
});

test("the context follows precedence", () => {
  expect(keymap.contextFor({ eventComposing: true, eventDescriptionFocused: true })).toBe("eventDescription");
  expect(keymap.contextFor({ eventComposing: true })).toBe("eventCompose");
  expect(keymap.contextFor({ eventComposing: true, guestSuggestions: true })).toBe("eventGuests");
  expect(keymap.contextFor({ assistantEditing: true, composing: true })).toBe("assistant");
  expect(keymap.contextFor({ assistantEditing: true, assistantCommands: true, composing: true })).toBe("assistantCommands");
  expect(keymap.contextFor({ composing: true })).toBe("compose");
  expect(keymap.contextFor({ sendPending: true, currentView: "reader" })).toBe("reader");
  expect(keymap.contextFor({ sendPending: true, currentView: "list" })).toBe("list");
  expect(keymap.contextFor({ searchFocused: true, calendarVisible: true })).toBe("search");
  expect(keymap.contextFor(null)).toBe("list");
});

test("Return saves an event and sends to the AI only where it is not text", () => {
  for (const key of ["Return", "Enter"]) {
    expect(keymap.sequencesFor("eventDescription").some((e) => e.sequence === key)).toBe(false);
    expect(keymap.sequencesFor("eventDescription").find((e) => e.sequence === "Ctrl+" + key)!.id).toBe("saveEvent");
    expect(keymap.sequencesFor("eventCompose").find((e) => e.sequence === key)!.id).toBe("saveEvent");
    expect(keymap.sequencesFor("assistant").find((e) => e.sequence === key)!.id).toBe("assistantSend");
    expect(keymap.sequencesFor("assistantCommands").find((e) => e.sequence === key)!.id).toBe("assistantChooseCommand");
  }
  expect(keymap.hintsFor("eventDescription").find((h) => h.label === "save")!.key).toBe("Ctrl+Enter");
  expect(byId("assistantSend").keys).toEqual(["Return", "Enter", "Ctrl+Return", "Ctrl+Enter"]);
  expect(keymap.sequencesFor("assistant").some((e) => e.sequence === "Up" || e.sequence === "Down")).toBe(false);
  expect(keymap.sequencesFor("compose").some((e) => e.id === "assistantSend")).toBe(false);
});

test("what is live where", () => {
  const undoSend = byId("undoSend");
  expect(keymap.displayFor(undoSend)).toBe("Alt+Z");
  for (const c of keymap.CONTEXTS) {
    expect(keymap.isEnabled(undoSend, c, false)).toBe(true);
    expect(keymap.isEnabled(byId("back"), c, false)).toBe(true);
    const comma = keymap.sequencesFor(c).filter((e) => e.sequence === "Ctrl+,");
    expect(comma.length).toBe(1);
    expect(comma[0].id).toBe("settings");
    expect(keymap.sequencesFor(c).some((e) => e.id === "refresh" && e.sequence === "Ctrl+R")).toBe(true);
  }
  const archive = byId("archive");
  expect(keymap.isEnabled(archive, "list", false)).toBe(true);
  expect(keymap.isEnabled(archive, "reader", false)).toBe(true);
  for (const c of ["page", "compose", "search"]) expect(keymap.isEnabled(archive, c, false)).toBe(false);
  expect(keymap.isEnabled(archive, "list", true)).toBe(false);
  expect(keymap.isEnabled(byId("back"), "list", true)).toBe(true);
  expect(keymap.isEnabled(byId("help"), "list", true)).toBe(true);
  expect(byId("help").keys).toEqual(["?"]);
  expect(keymap.isSequenceEnabled(byId("help"), "?", "compose", false)).toBe(false);
  expect(keymap.isEnabled(byId("search"), "compose", false)).toBe(false);
  expect(byId("refresh").keys).toEqual(["F5", "Ctrl+R"]);
  expect(keymap.isEnabled(byId("calendarZoomIn"), "calendar", false)).toBe(true);
  expect(keymap.isEnabled(byId("calendarZoomIn"), "reader", false)).toBe(false);
  expect(keymap.isEnabled(byId("zoomIn"), "page", false)).toBe(false);
  for (const id of ["cursorDown", "cursorUp"]) expect(keymap.isEnabled(byId(id), "list", true)).toBe(true);
  for (const id of ["scrollDown", "scrollUp"]) expect(keymap.isEnabled(byId(id), "reader", true)).toBe(true);
  for (const id of ["open", "compose"]) expect(keymap.isEnabled(byId(id), "list", true)).toBe(false);
  expect(keymap.isEnabled(byId("switchAccount"), "compose", false)).toBe(false);
  expect(keymap.isEnabled(byId("calendar"), "page", false)).toBe(false);
  expect(keymap.isEnabled(byId("createEvent"), "list", false)).toBe(false);
  expect(keymap.isEnabled(byId("toggleSidebar"), "calendar", false)).toBe(true);
});

test("the sheet and the bar write keys their own way", () => {
  const groups = keymap.helpGroups();
  // "Open the selected message" (Enter, o) and its list-only Right are one row.
  expect(groups.reduce((n, g) => n + g.rows.length, 0)).toBe(keymap.BINDINGS.length - 1);
  expect(keymap.displayFor(byId("cursorUp"))).toBe("k, Up");
  expect(keymap.displayFor(byId("help"))).toBe("?");
  expect(keymap.readableSequence("g,i")).toBe("g then i");
  expect(keymap.readableSequence("Escape")).toBe("Esc");
  expect(keymap.readableSequence("Ctrl+Return")).toBe("Ctrl+Enter");
  expect(keymap.displayFor(byId("goMailbox"))).toBe("Ctrl+1…9");
  expect(keymap.displayFor(byId("goAccount"))).toBe("Alt+1…0");
  expect(keymap.slotFor("goAccount", "Alt+0")).toBe(9);
  expect(keymap.slotFor("goMailbox", "Ctrl+9")).toBe(8);
  expect(keymap.slotFor("goMailbox", "Ctrl+0")).toBe(-1);
  expect(keymap.slotFor("nothing", "Alt+1")).toBe(-1);
  expect(keymap.displayFor(byId("open"))).toBe("Enter, o");
  expect(keymap.displayFor(byId("back"))).toBe("Esc");
  expect(keymap.hintKeyFor(byId("cursorDown"))).toBe("j / k");
  expect(keymap.hintKeyFor(byId("archive"))).toBe("e");
  expect(keymap.keycapLabel("Shift+J / Shift+K")).toBe("shift+j / shift+k");
});

test("hints offer what the place can do", () => {
  expect(labels(keymap.hintsFor("list"))).toEqual(["j / k move", "e archive", "d trash", "Space select", "c compose"]);
  const selected = keymap.hintsFor("list", [], true);
  expect(labels(selected)).toEqual(["j / k move", "e archive", "d trash", "v move to", "Space select", "c compose"]);
  expect(keymap.hintsFor("list", ["move"], true).some((h) => h.key === "v")).toBe(false);
  expect(labels(keymap.hintsFor("list", [], true, { archive: "archive", trash: "untrash" })))
    .toEqual(["j / k move", "e archive", "d restore", "v move to", "Space select", "c compose"]);
  expect(labels(keymap.hintsFor("reader", [], true, { archive: "unarchive", trash: "trash" })
    .filter((h) => h.key === "e" || h.key === "d"))).toEqual(["e move to inbox", "d trash"]);
  expect(keymap.hintsFor("list", ["archive", "star", "move"], true, { archive: "unarchive" }).map((h) => h.key))
    .toEqual(["j / k", "d", "Space", "c"]);
  expect(keymap.hintsFor("list", [], true, { archive: "untrash", trash: "unarchive" })).toEqual(selected);
  expect(keymap.hintsFor("compose").map((h) => h.label)).toEqual(["send", "close"]);
  expect(keymap.hintsFor("page").map((h) => h.label)).toEqual(["back"]);
  expect(keymap.hintsFor("list", null as unknown as string[])).toEqual(keymap.hintsFor("list"));
});

test("help columns keep order and balance", () => {
  const all = keymap.helpGroups().map((g) => g.name);
  const total = keymap.helpGroups().reduce((n, g) => n + keymap.helpWeight(g), 0);
  for (const count of [1, 2, 3, 4]) {
    const columns = keymap.helpColumns(count);
    expect(columns.length).toBe(Math.min(count, all.length));
    expect(columns.flat().map((g) => g.name)).toEqual(all);
    for (const column of columns) expect(column.length > 0).toBe(true);
    const heaviest = Math.max(...columns.map((c) => c.reduce((n, g) => n + keymap.helpWeight(g), 0)));
    expect(heaviest <= Math.ceil(total / count) + 6).toBe(true);
  }
  expect(keymap.helpColumns(0)).toEqual([keymap.helpGroups()]);
  expect(keymap.helpColumns(99).length).toBe(all.length);
  const withoutAgent = keymap.helpGroups(["askAgent", "assistantSend", "assistantChooseCommand",
    "assistantCommandNext", "assistantCommandPrevious"]);
  expect(withoutAgent.some((g) => g.name === "AI")).toBe(false);
});

test("v moves and m stays out of the mailbox", () => {
  expect(byId("moveToLabel").keys).toEqual(["v"]);
  expect(keymap.BINDINGS.every((b) => !b.keys.includes("m") || b.contexts.includes("calendar"))).toBe(true);
  expect(keymap.bindingsFor("calendar").some((b) => b.id === "moveToLabel")).toBe(false);
});

test("every sequence is a keystroke NSH accepts", () => {
  expect(keymap.nshKeystroke("Ctrl+1")).toBe("mod+1");
  expect(keymap.nshKeystroke("?")).toBe("shift+/");
  expect(keymap.nshKeystroke("Shift+J")).toBe("shift+j");
  expect(keymap.nshKeystroke("Ctrl++")).toBe("mod+plus");
  expect(keymap.nshKeystroke("Ctrl+=")).toBe("mod+plus");
  expect(keymap.nshKeystroke("Ctrl+-")).toBe("mod+minus");
  expect(keymap.nshKeystroke("Ctrl+Return")).toBe("mod+enter");
  expect(keymap.nshKeystroke("Ctrl+Shift+M")).toBe("mod+shift+m");
  expect(keymap.nshKeystroke("Escape")).toBe("escape");
  expect(keymap.nshKeystroke("F5")).toBe("f5");
  for (const b of keymap.BINDINGS) {
    for (const key of b.keys) expect(() => nshKeymap.label(keymap.nshKeystroke(key))).not.toThrow();
  }
});

// docs/KEYS.md is checked against BINDINGS outside the app, where the file
// can be read: `node scripts/check-keys.ts`.
