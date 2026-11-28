// The ui layer: its pure rules, and its controls' behavior in the gallery.
// Behavior only: the look is checked on screenshots of the gallery.
import { expect, open, test } from "nsh/test";
import { chordLabel, isApple, keyCaps } from "./Kbd";
import { restingIndex, rovingMove } from "./roving";
import { badgeText } from "./Counts";
import { initialOf } from "./InitialAvatar";
import { splitEntries } from "./ChipInput";
import { isResetPress } from "./SplitPane";
import { cx } from "./tokens";
import { iconKeyFor } from "./Icon";
import { quickActionsA11y } from "./Row";
import { parseOmarchyFont } from "./font";
import { completeOmarchy, INK, MONO_FALLBACK, OMARCHY_FALLBACK, ownTheme, PAPER, ROLES } from "./theme";
import themeFile from "../../theme.json";

const GALLERY = "./GalleryApp.tsx";
const SIZE = { width: 900, height: 2600 };

test("badgeText writes nothing for none and caps large counts", () => {
  expect(badgeText(0)).toBe("");
  expect(badgeText(-3)).toBe("");
  expect(badgeText(7)).toBe("7");
  expect(badgeText(150)).toBe("99+");
  expect(badgeText(1500, 999)).toBe("999+");
  expect(badgeText(Number.NaN)).toBe("");
});

test("initialOf takes the name, then the address, then a plus", () => {
  expect(initialOf("ada lovelace", "x@example.com")).toBe("A");
  expect(initialOf("  ", "zoe@example.com")).toBe("Z");
  expect(initialOf(null, null)).toBe("+");
  expect(initialOf("😀 Smile")).toBe("😀");
});

test("splitEntries ends entries at commas and semicolons", () => {
  expect(splitEntries("ada@x.com, bob@y.com;carl")).toEqual({ entries: ["ada@x.com", "bob@y.com"], rest: "carl" });
  expect(splitEntries("plain")).toEqual({ entries: [], rest: "plain" });
  expect(splitEntries(" , ,")).toEqual({ entries: [], rest: "" });
});

test("a double click resets a split, a single one does not", () => {
  expect(isResetPress({ clickCount: 2 })).toBe(true);
  expect(isResetPress({ clickCount: 1 })).toBe(false);
});

test("cx drops empty classes", () => {
  expect(cx("a", false, null, undefined, "", "b")).toBe("a b");
});

test("a notice's busy action relabels itself rather than vanishing", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("Remote images are hidden.");
  await app.press("id:notice-busy >> label:Show images");
  await app.waitFor("id:notice-busy >> text:Loading images...");
  expect(app.enabled("id:notice-busy-action")).toBe(false);
  await app.waitFor("id:notice-busy >> text:Show images", { timeout: 4000 });
});

test("a notice stack adds and removes notices in place", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:notice-dir");
  await app.press("Add notice");
  await app.waitFor("Notice 3");
  await app.press("Remove last");
  await app.waitUntil(() => !app.texts().includes("Notice 3"));
  expect(app.shows("id:notice-images")).toBe(true);
});

test("a nav row is a selectable button that says its count", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:nav-work");
  expect(app.accessibility("id:nav-inbox")?.selected).toBe(true);
  expect(app.accessibility("id:nav-work")?.label).toBe("Work, 12");
  await app.press("id:nav-work");
  await app.waitUntil(() => app.accessibility("id:nav-work")?.selected === true);
  expect(app.accessibility("id:nav-inbox")?.selected).not.toBe(true);
});

test("a list row's action does not open the row", async () => {
  const app = await open(GALLERY, { ...SIZE, platform: "macos" });
  await app.waitFor("id:row-1");
  await app.hover("id:row-2");
  await app.press("id:row-2 >> label:Star");
  await app.waitFor("id:row-2 >> label:Unstar");
  expect(app.accessibility("id:row-2")?.selected).toBe(true);
  await app.press("id:row-1");
  await app.waitUntil(() => app.accessibility("id:row-1")?.selected === true);
});

test("a segmented control changes its value and marks the chosen option", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("Density: compact");
  await app.press("id:density-comfortable");
  await app.waitFor("Density: comfortable");
  expect(app.accessibility("id:density-comfortable")?.selected).toBe(true);
  expect(app.accessibility("id:density-compact")?.selected).not.toBe(true);
});

test("a chip input commits on a comma and removes by its button and by Backspace", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("Ada Lovelace");
  await app.press("label:Remove Ada Lovelace");
  await app.waitUntil(() => app.count("id:token-1") === 0);
  // The invalid token says so in its button's name.
  expect(app.count("label:Remove not-an-address (invalid address)")).toBe(1);
  await app.type("label:To", "grace@example.com,");
  await app.waitFor("id:to >> text:grace@example.com");
  expect(app.value("label:To")).toBe("");
  expect(app.count("label:Remove grace@example.com")).toBe(1);
  // Backspace in the empty input takes the last token back.
  await app.keyboard.press("backspace");
  await app.waitUntil(() => app.count("label:Remove grace@example.com") === 0);
  expect(app.count("label:Remove not-an-address (invalid address)")).toBe(1);
});

test("a menu button opens its menu and stays selected while it is open", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:more");
  await app.press("id:more");
  await app.waitFor("Print...");
  expect(app.accessibility("id:more")?.selected).toBe(true);
  await app.keyboard.press("escape");
  await app.waitFor("Print...", { state: "gone" });
  await app.waitUntil(() => app.accessibility("id:more")?.selected !== true);
});

test("a destructive action asks with an accurate label", async () => {
  const app = await open(GALLERY, SIZE);
  app.onDialog(() => "Delete forever");
  await app.waitFor("label:Delete");
  await app.press("label:Delete");
  await app.waitFor("Confirm answered: Deleted");
  expect(app.dialogs()[0]?.title).toBe("Delete this message forever?");
});

test("skeletons and loading rows are announced as busy", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:list-skeleton");
  expect(app.accessibility("id:list-skeleton")?.label).toBe("Loading messages");
  expect(app.accessibility("id:reader-skeleton")?.label).toBe("Loading message");
  expect(app.texts()).toContain("Searching all mail...");
});

test("key hints and avatars read from their data", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:hints");
  for (const word of ["j / k", "move", "enter", "open", "archive"]) expect(app.texts()).toContain(word);
  expect(app.texts()).toContain("A");
  expect(app.accessibility("id:avatar-name")?.label).toBe("Ada Lovelace");
});

test("the gallery renders under reduced motion and in light", async () => {
  const app = await open(GALLERY, { ...SIZE, reducedMotion: true, colorScheme: "light" });
  await app.waitFor("No messages");
  await app.press("id:theme-light");
  await app.waitFor("Mail you archive lands here.");
});

test("the Theme setting draws ink, paper and Omarchy with every role", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:theme-dark");
  const bg = () => app.viewStyle("id:gallery")?.backgroundColor;
  await app.waitUntil(() => String(bg()).toLowerCase().startsWith("#0e1016"));
  await app.press("id:theme-light");
  await app.waitUntil(() => String(bg()).toLowerCase().startsWith("#fafaf7"));
  // Omarchy (Tokyo Night off an Omarchy desktop): its own background, and the
  // roles it lacks filled, so a raised fill is drawn rather than nothing.
  await app.press("id:theme-omarchy");
  await app.waitUntil(() => !["#0e1016", "#fafaf7"].some((c) => String(bg()).toLowerCase().startsWith(c)));
  await app.press("id:theme-dark");
  await app.waitUntil(() => String(bg()).toLowerCase().startsWith("#0e1016"));
});

test("structural dividers are subtle on ink and paper and the border on Omarchy", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:swatch-divider");
  const fill = (id: string) => String(app.viewStyle(`id:${id}`)?.backgroundColor).toLowerCase();
  await app.waitUntil(() => fill("swatch-divider").startsWith("#171a24"));
  expect(fill("swatch-border").startsWith("#232838")).toBe(true);
  await app.press("id:theme-light");
  await app.waitUntil(() => fill("swatch-divider").startsWith("#e9e9e4"));
  expect(fill("swatch-border").startsWith("#d9dae0")).toBe(true);
  await app.press("id:theme-omarchy");
  await app.waitUntil(() => !fill("swatch-border").startsWith("#d9dae0") && fill("swatch-divider") === fill("swatch-border"));
});

test("the first frame already has every role (no gap at startup)", async () => {
  // No waiting: what the first frame drew. A role missing then draws nothing.
  const app = await open(GALLERY, SIZE);
  const fill = (id: string) => String(app.viewStyle(`id:${id}`)?.backgroundColor).toLowerCase();
  expect(fill("swatch-divider").startsWith("#171a24")).toBe(true);
});

test("in the Omarchy mode, content behind themeReady() first shows with every role", async () => {
  const app = await open("./fixtures/OmarchyStartApp.tsx", { width: 400, height: 300 });
  await app.waitFor("Ready");
  // The first frame with content: no waiting for a fill.
  const fill = (id: string) => app.viewStyle(`id:${id}`)?.backgroundColor;
  expect(fill("swatch-raised")).toBeTruthy();
  expect(fill("swatch-divider")).toEqual(fill("swatch-border"));
  expect(String(fill("swatch-border")).toLowerCase().startsWith("#232838")).toBe(false);
});

test("theme.json is the app's own palettes", () => {
  expect(JSON.parse(JSON.stringify(themeFile))).toEqual(ownTheme(MONO_FALLBACK));
  for (const role of ROLES) {
    expect(typeof PAPER[role]).toBe("string");
  }
  expect(INK.divider === INK.border).toBe(false);
  expect(PAPER.divider === PAPER.border).toBe(false);
  expect(OMARCHY_FALLBACK.divider).toEqual(["border"]);
});

test("a split's handle drags and reports the new sizes", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("Sizes: 200");
  await app.drag("label:Sidebar width", { x: 60 });
  await app.waitUntil(() => !app.texts().includes("Sizes: 200"));
  expect(app.texts().some((t) => t.startsWith("Sizes: 26"))).toBe(true);
});

test("a split handle resizes on release within its limits", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("Dock: 240");
  // A handle on the dock's left edge: dragging left widens it.
  await app.drag("id:dock-handle", { x: -40 });
  await app.waitFor("Dock: 280");
  await app.drag("id:dock-handle", { x: -900 });
  await app.waitFor("Dock: 480");
  expect(app.accessibility("id:dock-handle")?.role).toBe("adjustable");
  expect(app.accessibility("id:dock-handle")?.label).toBe("Dock width");
  // Headless keys reach shortcuts and inputs only, and presses have no click
  // count: the arrows, Return and the double click are checked by hand.
});

test("resizedSize clamps and follows the growing direction", async () => {
  const { resizedSize } = await import("./SplitHandle");
  expect(resizedSize(240, -40, -1, 160, 480)).toBe(280);
  expect(resizedSize(240, 40, 1, 160, 480)).toBe(280);
  expect(resizedSize(240, 900, -1, 160, 480)).toBe(160);
});

test("a picker row marks the cursor and the row in use apart", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("Cursor: work");
  expect(app.accessibility("id:pick-inbox")?.selected).toBe(true);
  expect(app.accessibility("id:pick-work")?.selected).not.toBe(true);
  await app.press("id:pick-inbox");
  await app.waitFor("Cursor: inbox");
});

test("a segmented option explains itself in its tooltip", async () => {
  const app = await open(GALLERY, { ...SIZE, platform: "macos" });
  await app.waitFor("label:Plain text");
  await app.hover("label:Plain text");
  await app.waitFor("The message's text only, no layout or images");
});

test("a text editor is a named multiline field", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("label:Message");
  await app.type("label:Message", "Hello\nworld");
  await app.waitFor("Characters: 11");
  expect(app.value("label:Message")).toBe("Hello\nworld");
});

test("a list row passes its press modifiers and hover through", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:row-1");
  await app.press("id:row-1");
  await app.waitUntil(() => app.texts().some((t) => t.includes("Press: Open")));
  await app.keyboard.down("shift");
  await app.press("id:row-1");
  await app.keyboard.up("shift");
  await app.waitUntil(() => app.texts().some((t) => t.includes("Press: Range")));
});

test("a controlled context menu opens and closes from the app", async () => {
  const app = await open(GALLERY, { ...SIZE, platform: "macos" });
  await app.waitFor("label:Open row menu");
  await app.press("label:Open row menu");
  await app.waitFor("Close menu");
  expect(app.accessibility("id:row-3")?.selected).toBe(true);
  await app.press("Close menu");
  await app.waitFor("Close menu", { state: "gone" });
  await app.waitUntil(() => app.accessibility("id:row-3")?.selected !== true);
  await app.rightClick("id:row-3");
  await app.waitFor("Close menu");
  await app.keyboard.press("escape");
  await app.waitFor("Close menu", { state: "gone" });
});

test("a choice dialog reports the answer or a cancel", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:close-draft");
  await app.press("id:close-draft");
  await app.waitFor("Save this draft?");
  await app.press("id:choice-save");
  await app.waitFor("Confirm answered: Saved");
  await app.press("id:close-draft");
  await app.waitFor("Save this draft?");
  await app.keyboard.press("escape");
  await app.waitFor("Confirm answered: Cancelled");
  await app.press("id:close-draft");
  await app.press("id:choice-discard");
  await app.waitFor("Confirm answered: Discarded");
});

test("iconKeyFor picks the filled form where there is one", () => {
  expect(iconKeyFor("star", true)).toBe("starFilled");
  expect(iconKeyFor("star", false)).toBe("star");
  expect(iconKeyFor("archive", true)).toBe("archive");
});

test("a picker row with no text is its lead alone, still named", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:pick-rail");
  expect(app.accessibility("id:pick-rail")?.label).toBe("ada@example.com");
});

test("Omarchy's font settings are read leniently", () => {
  expect(parseOmarchyFont({ family: " JetBrainsMono Nerd Font ", baseSize: 16 })).toEqual({
    family: "JetBrainsMono Nerd Font",
    baseSize: 16,
  });
  // Off Omarchy the native side returns {}; junk is the default too.
  expect(parseOmarchyFont({})).toEqual({ family: null, baseSize: 14 });
  expect(parseOmarchyFont({ family: "", baseSize: 400 })).toEqual({ family: null, baseSize: 14 });
  expect(parseOmarchyFont(null)).toEqual({ family: null, baseSize: 14 });
});

/** The gallery heading's size (a 16pt pane title) at base `base`. */
function titleAt(base: number): number {
  return base === 14 ? 16 : Math.round(16 * (base / 14) * 2) / 2;
}

test("the base size scales text and controls, and 14 draws them as designed", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("ui layer");
  // The gallery's heading is a pane title: 16pt at base 14.
  expect(app.spanStyle("text:ui layer").fontSize).toBe(16);
  // Interface text is the system's sans, not the mono family.
  expect(app.spanStyle("text:ui layer").fontFamily).not.toBe("monospace");
  const before = app.layout("id:close-draft")!.height;
  await app.press("text:16");
  await app.waitUntil(() => app.spanStyle("text:ui layer").fontSize === titleAt(16));
  expect(app.layout("id:close-draft")!.height).toBeGreaterThan(before);
  await app.press("text:14");
  await app.waitUntil(() => app.spanStyle("text:ui layer").fontSize === titleAt(14));
  expect(app.layout("id:close-draft")!.height).toBe(before);
});

test("a fixed list row keeps its height and detail line, and reserves no actions lane", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:row-lane");
  const full = app.layout("id:row-lane")!;
  const empty = app.layout("id:row-lane-empty")!;
  expect(full.height).toBe(72);
  expect(empty.height).toBe(72);
  // Both titles start alike, and the times end on the same trailing edge
  // whether or not the row has quick actions.
  expect(app.layout("text:Quick actions over the time on hover")!.x).toBe(app.layout("text:No actions: the time ends on the edge")!.x);
  const t1 = app.layout("id:row-lane >> text:09:12")!;
  const t2 = app.layout("id:row-lane-empty >> text:08:40")!;
  expect(t1.x + t1.width).toBe(t2.x + t2.width);
  expect(app.layout("id:row-lane-empty-actions")).toBeFalsy();
  // The thread count is a chip of its own, apart from the time.
  const chip = app.layout("id:row-lane-thread")!;
  expect(chip.x + chip.width).toBeLessThan(t1.x);
  expect(app.accessibility("id:row-lane-thread")?.label).toBe("3 messages");
});

test("sidebar rows give the name the width and line counts up in one lane", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:nav-long");
  const a = app.layout("id:nav-work-count")!;
  const b = app.layout("id:nav-long-count")!;
  expect(a.x + a.width).toBe(b.x + b.width);
  // The name runs up to the count lane before it elides.
  const name = app.layout("id:nav-long >> text:Clients and their long project names")!;
  expect(b.x - (name.x + name.width)).toBeLessThanOrEqual(12);
  // The fold chevron sits before the icon, not after the count.
  expect(app.layout("id:nav-long-count")!.x).toBeGreaterThan(name.x);
});

test("arrow keys in a NavList move the selection, and the focus with it", async () => {
  const app = await open(GALLERY, { ...SIZE, platform: "linux" });
  await app.waitFor("id:nav-inbox");
  await app.press("id:nav-inbox");
  expect(app.accessibility("id:nav-inbox")?.selected).toBe(true);
  // The keyboard's focus on the list (Tab would bring it there).
  await app.press("id:focus-nav");
  await app.keyboard.press("down");
  await app.waitUntil(() => app.accessibility("id:nav-work")?.selected === true);
  await app.keyboard.press("down");
  await app.waitUntil(() => app.accessibility("id:nav-clients")?.selected === true);
  // The focus moved with it: the next arrow goes on from Clients.
  await app.keyboard.press("up");
  await app.waitUntil(() => app.accessibility("id:nav-work")?.selected === true);
  await app.keyboard.press("home");
  await app.waitUntil(() => app.accessibility("id:nav-inbox")?.selected === true);
});

test("a nav row is activated by Return and Space from the keyboard", async () => {
  const app = await open(GALLERY, { ...SIZE, platform: "linux" });
  await app.waitFor("id:nav-work");
  await app.press("id:nav-work");
  await app.waitUntil(() => app.accessibility("id:nav-work")?.selected === true);
  // The keyboard's focus on Inbox, which is not selected: Return selects it.
  await app.press("id:focus-nav");
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.accessibility("id:nav-inbox")?.selected === true);
  await app.press("id:nav-work");
  await app.press("id:focus-nav");
  await app.keyboard.press("space");
  await app.waitUntil(() => app.accessibility("id:nav-inbox")?.selected === true);
  expect(app.accessibility("id:nav-inbox")?.role).toBe("button");
});

test("siblings of a folded nav row line up their icons; a key cap is named", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:nav-long");
  const iconX = (id: string) => app.layout(`id:${id} >> text:${id === "nav-long" ? "Clients and their long project names" : id === "nav-clients" ? "Clients" : "Projects (folder)"}`)!.x;
  expect(Math.abs(iconX("nav-clients") - iconX("nav-long"))).toBeLessThan(1);
  expect(Math.abs(iconX("nav-projects") - iconX("nav-long"))).toBeLessThan(1);
  // The slot's key is the whole chord, never a bare digit.
  const chord = isApple() ? "⌘3" : "Ctrl+3";
  expect(app.accessibility("id:nav-archive")?.label).toBe(`Archive, ${chord}`);
  expect(app.accessibility("id:nav-archive-key")?.label).toBe(chord);
});

test("quick actions take the place of the time and thread count, on hover, selection and focus alike", async () => {
  const app = await open(GALLERY, { ...SIZE, platform: "macos" });
  await app.waitFor("id:row-lane");
  const op = (id: string) => app.viewStyle(`id:${id}`)!.opacity;
  // At rest the metadata shows, and the thread chip is part of it.
  await app.hover("id:row-1");
  await app.waitUntil(() => op("row-lane-meta") === 1 && op("row-lane-actions") === 0);
  expect(app.layout("id:row-lane-meta >> id:row-lane-thread")).toBeTruthy();
  // Hovered: the actions, ending where the time ended.
  await app.hover("id:row-lane");
  await app.waitUntil(() => op("row-lane-meta") === 0 && op("row-lane-actions") === 1);
  const end = (r: { x: number; width: number }) => r.x + r.width;
  expect(Math.abs(end(app.layout("id:row-lane-actions")!) - end(app.layout("id:row-lane-meta")!))).toBeLessThan(1);
  // Selected (row 2 is, at start): the same, with no hover.
  await app.hover("id:row-1");
  await app.waitUntil(() => op("row-lane-meta") === 1);
  expect(op("row-2-meta")).toBe(0);
  expect(op("row-2-actions")).toBe(1);
});

test("a key cap writes mod as this platform does, never as mod", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:v2-kbd");
  const label = app.accessibility("id:v2-kbd")?.label ?? "";
  expect(label.toLowerCase().includes("mod")).toBe(false);
  expect(/⌘K|Ctrl\+K/.test(label)).toBe(true);
});

test("a small button centres in an items-center row", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:v2-small");
  const mid = (r: { y: number; height: number }) => r.y + r.height / 2;
  expect(Math.abs(mid(app.layout("id:v2-small")!) - mid(app.layout("id:v2-primary")!))).toBeLessThanOrEqual(0.5);
  // In a column it still hugs its label rather than stretching.
  expect(app.layout("id:focus-nav")!.width).toBeLessThan(200);
});

test("a hugging segmented control centres in an items-center row", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:seg-centred");
  const bar = app.layout("id:seg-bar")!;
  const seg = app.layout("id:seg-centred")!;
  const mid = (r: { y: number; height: number }) => r.y + r.height / 2;
  // The bar's bottom hairline takes 1pt of its height.
  expect(Math.abs(mid(seg) - (bar.y + (bar.height - 1) / 2))).toBeLessThanOrEqual(1);
});

test("tool and menu buttons can name themselves beyond their label", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:close-draft");
  expect(app.accessibility("id:close-draft")?.label).toBe("Close draft: Lunch on Friday...");
  expect(app.accessibility("id:more")?.label).toBe("More actions for this message...");
  // The visible text stays the label.
  await app.waitFor("Close draft...");
});

test("spacing classes follow the base size through cx", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:row-1");
  const before = app.layout("text:Lunch on Friday?")!.x;
  await app.press("text:16");
  await app.waitUntil(() => app.spanStyle("text:ui layer").fontSize === titleAt(16));
  // pl-3 and the gallery's p-4 are drawn 16/14 as wide.
  expect(app.layout("text:Lunch on Friday?")!.x).toBeGreaterThan(before);
  await app.press("text:14");
  await app.waitUntil(() => app.layout("text:Lunch on Friday?")!.x === before);
});

test("an overlay panel fills the window, is a named dialog, and closes on Escape", async () => {
  const app = await open(GALLERY, { width: 900, height: 700 });
  await app.waitFor("id:open-panel");
  await app.press("id:open-panel");
  await app.waitFor("Group 6");
  expect(app.layout("id:panel-close")).not.toBeNull();
  await app.keyboard.press("escape");
  await app.waitFor("Group 6", { state: "gone" });
  await app.press("id:open-panel");
  await app.waitFor("Group 1");
  await app.press("id:panel-close");
  await app.waitFor("Group 1", { state: "gone" });
});

test("a disclosure shows more and says whether it is expanded", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:advanced");
  expect(app.accessibility("id:advanced")?.expanded).toBe(false);
  await app.press("id:advanced");
  await app.waitFor("Prefetch bodies");
  expect(app.accessibility("id:advanced")?.expanded).toBe(true);
  expect(app.accessibility("id:advanced")?.label).toBe("Hide advanced settings");
  await app.press("id:advanced");
  await app.waitFor("Prefetch bodies", { state: "gone" });
});

test("a disabled picker row says so and ignores presses", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:pick-off");
  expect(app.accessibility("id:pick-off")?.disabled).toBe(true);
  await app.press("id:pick-off").catch(() => undefined);
  expect(app.texts().some((t) => t.includes("chosen: off"))).toBe(false);
});

test("a list row's unread dot sits in the lead padding, centred on the overline", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:row-1");
  const row = app.layout("id:row-1")!;
  const dot = app.layout("id:row-1-dot")!;
  const name = app.layout("id:row-1 >> text:Ada Lovelace")!;
  // The dot's view spans the overline's height; the 5pt dot is centred in it,
  // inside the 1pt ring.
  expect(dot.x - row.x).toBe(3);
  expect(Math.abs(dot.y + dot.height / 2 - (name.y + name.height / 2))).toBeLessThan(1.5);
  expect(name.x - (dot.x + 5)).toBe(5);
});

test("nsh-omarchy controls from ui follow the base size", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:sig");
  const button = () => app.layout("label:Open row menu")!;
  const input = () => app.layout("id:sig")!;
  const b14 = button();
  const i14 = input();
  expect(b14.height).toBe(26);
  expect(i14.height).toBe(30);
  expect(app.spanStyle("text:Open row menu").fontSize).toBe(12);
  await app.press("text:16");
  // Layout lands on whole points headless: within half a point of the scaled size.
  await app.waitUntil(() => Math.abs(input().height - scaledOf(30)) <= 0.5);
  expect(Math.abs(button().height - scaledOf(26))).toBeLessThanOrEqual(0.5);
  expect(button().width).toBeGreaterThan(b14.width);
  expect(app.spanStyle("text:Open row menu").fontSize).toBe(scaledOf(12));
  await app.press("text:14");
  await app.waitUntil(() => button().height === 26);
  expect(button().width).toBe(b14.width);
  expect(input().height).toBe(30);
});

function scaledOf(points: number): number {
  return Math.round(points * (16 / 14) * 2) / 2;
}

test("a scroll box is as tall as its content up to its cap", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:box-many");
  expect(app.layout("id:box-many")!.height).toBe(120);
  expect(app.layout("id:box-few")!.height).toBeLessThan(40);
});

test("a popover takes the width it is given", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:pop-trigger");
  await app.press("id:pop-trigger");
  await app.waitFor("Contacts");
  await app.waitUntil(() => (app.layout("id:box-one")?.width ?? 0) > 0);
  // 260 wide, less its border: the list's own width.
  expect(app.layout("id:box-one")!.width).toBe(258);
  await app.keyboard.press("escape");
  await app.waitFor("Contacts", { state: "gone" });
});

test("a selected row keeps its fill under the pointer", async () => {
  const app = await open(GALLERY, { ...SIZE, platform: "linux" });
  await app.waitFor("id:row-1");
  await app.press("id:row-1");
  await app.waitUntil(() => app.accessibility("id:row-1")?.selected === true);
  const fill = () => app.viewStyle("id:row-1")?.backgroundColor;
  const selected = fill();
  await app.hover("id:row-1");
  expect(fill()).toBe(selected);
  // An unselected row still takes the hover wash, lighter than the selected fill.
  await app.hover("id:row-3");
  expect(app.viewStyle("id:row-3")?.backgroundColor).not.toBe(selected);
  // The same in a picker row.
  const pick = app.viewStyle("id:pick-inbox")?.backgroundColor;
  await app.hover("id:pick-inbox");
  expect(app.viewStyle("id:pick-inbox")?.backgroundColor).toBe(pick);
});


test("menus, fields, selects and dialogs follow the base size", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:theme-select");
  const at = async (base: "14" | "16") => {
    await app.press("text:" + base);
    await app.waitUntil(() => app.spanStyle("text:ui layer").fontSize === titleAt(Number(base)));
    const sizes: Record<string, number | undefined> = {};
    sizes.field = app.spanStyle("text:Theme").fontSize;
    sizes.error = app.spanStyle("text:Enter a host name.").fontSize;
    sizes.trigger = app.spanStyle("text:Choose a theme").fontSize;
    await app.press("id:theme-select");
    await app.waitFor("Same as the desktop");
    sizes.option = app.spanStyle("text:Same as the desktop").fontSize;
    sizes.group = app.spanStyle("text:Pinned themes").fontSize;
    await app.keyboard.press("escape");
    await app.waitFor("Same as the desktop", { state: "gone" });
    await app.press("id:more");
    await app.waitFor("Print...");
    sizes.row = app.spanStyle("text:Print...").fontSize;
    sizes.rowHeight = app.layout("role:menuitem[Print...]")?.height;
    await app.keyboard.press("escape");
    await app.waitFor("Print...", { state: "gone" });
    await app.press("id:close-draft");
    await app.waitFor("Save this draft?");
    sizes.title = app.spanStyle("text:Save this draft?").fontSize;
    await app.keyboard.press("escape");
    await app.waitFor("Save this draft?", { state: "gone" });
    return sizes;
  };
  const s14 = await at("14");
  expect(s14).toEqual({ field: 12, error: 12, trigger: 13, option: 13, group: 12, row: 13, rowHeight: 30, title: 16 });
  const s16 = await at("16");
  const up = (n: number) => Math.round(n * (16 / 14) * 2) / 2;
  expect(s16.field).toBe(up(12));
  expect(s16.trigger).toBe(up(13));
  expect(s16.option).toBe(up(13));
  expect(s16.group).toBe(up(12));
  expect(s16.row).toBe(up(13));
  expect(Math.abs(s16.rowHeight! - up(30))).toBeLessThanOrEqual(0.5);
  expect(s16.title).toBe(up(16));
  await at("14");
});

test("a field names its control and a select reports the choice", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:theme-select");
  expect(app.accessibility("id:host")?.label).toBe("Host");
  await app.press("id:theme-select");
  await app.waitFor("Same as the desktop");
  await app.press("role:option[Dark]");
  await app.waitFor("Same as the desktop", { state: "gone" });
  expect(app.texts()).toContain("Dark");
});

test("a select lines up with an input at every base size", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:theme-select");
  for (const base of ["14", "16", "12", "14"]) {
    await app.press("id:base-size >> text:" + base);
    await app.waitUntil(() => Math.abs(app.layout("id:host")!.height - (30 * Number(base)) / 14) <= 1);
    const select = app.layout("role:combobox[Theme]")!;
    const input = app.layout("id:host")!;
    expect(select.x).toBe(input.x);
    expect(select.height).toBe(input.height);
  }
});

test("a checkbox's box is the control's edge: it lines up with the field above it", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:cb-box");
  const box = app.layout("id:cb-box")!;
  const field = app.layout("id:sig")!;
  expect(Math.abs(box.x - field.x)).toBeLessThan(1);
  expect(Math.abs(app.layout("id:cb")!.x - field.x)).toBeLessThan(1);
  // 14pt square at base 14.
  expect(Math.round(box.width)).toBe(14);
  expect(Math.round(box.height)).toBe(14);
  expect(app.layout("id:v2-switch-box")).toBeTruthy();
});

test("a button in a taller row is centred by the row's items-center, with no class of its own", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:lines-back");
  const row = app.layout("id:lines-header")!;
  const back = app.layout("id:lines-back")!;
  const mid = (r: { y: number; height: number }) => r.y + r.height / 2;
  // The header's bottom border takes 1pt.
  expect(Math.abs(mid(back) - (row.y + (row.height - 1) / 2))).toBeLessThanOrEqual(0.5);
  expect(back.height).toBeLessThan(row.height);
});

test("chords read as this platform writes them, never mod", () => {
  const apple = isApple();
  expect(chordLabel("Shift+J")).toBe(apple ? "⇧J" : "Shift+J");
  expect(chordLabel("Ctrl+Enter")).toBe(apple ? "⌘↩" : "Ctrl+Enter");
  expect(chordLabel("Ctrl++")).toBe(apple ? "⌘+" : "Ctrl++");
  expect(chordLabel("Ctrl+1…9")).toBe(apple ? "⌘1…9" : "Ctrl+1…9");
  expect(chordLabel("Alt+1…0")).toBe(apple ? "⌥1…0" : "Alt+1…0");
  expect(chordLabel("Esc")).toBe("esc");
  expect(chordLabel("Escape")).toBe("esc");
  expect(chordLabel("?")).toBe("?");
  expect(chordLabel("j")).toBe("J");
  expect(chordLabel("Space")).toBe(apple ? "Space" : "Space");
  for (const text of ["Ctrl+A", "Ctrl+Shift+M", "Ctrl+,", "Ctrl+-"]) expect(chordLabel(text).includes("mod")).toBe(false);
  if (!apple) expect(chordLabel("Ctrl+Shift+M")).toBe("Ctrl+Shift+M");
});

test("one cap per key: alternatives split, the same key once, sequences stay together", () => {
  const apple = isApple();
  expect(keyCaps("Shift+J / Shift+K")).toEqual(apple ? ["⇧J", "⇧K"] : ["Shift+J", "Shift+K"]);
  expect(keyCaps("j, Down")).toEqual(["J", apple ? "↓" : "Down"]);
  expect(keyCaps("Return, Enter").length).toBe(1);
  expect(keyCaps("g then i")).toEqual(["G I"]);
  expect(keyCaps("")).toEqual([]);
});

test("per-key hints draw one cap per key", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:hints-per-key");
  type Node = { role?: string | null; label?: string | null; children?: Node[] };
  const walk = (n: Node | null | undefined): string[] =>
    !n ? [] : [...(n.role === "keyboardkey" ? [n.label ?? ""] : []), ...(n.children ?? []).flatMap(walk)];
  const caps = walk(app.accessibility("id:hints-per-key") as Node | null);
  expect(caps.length).toBe(4);
  expect(caps.some((c) => c.toLowerCase().includes("mod"))).toBe(false);
  expect(caps).toContain("G I");
});

test("a roving tree: arrows open rows, Left and Right fold and step", async () => {
  const app = await open(GALLERY, { ...SIZE, platform: "macos" });
  await app.waitFor("id:tree");
  // The keyboard's focus on the tree's stop (Tab would bring it there).
  await app.press("id:focus-tree");
  await app.keyboard.press("down");
  await app.waitFor("Tree: clients");
  // Right on an unfolded row steps into its first child.
  await app.keyboard.press("right");
  await app.waitFor("Tree: contoso");
  // A row that names nothing takes the focus without opening.
  await app.keyboard.press("down");
  await app.wait(100);
  expect(app.texts()).toContain("Tree: contoso");
  // Left steps out to the parent, then folds it.
  await app.keyboard.press("left");
  await app.waitFor("Tree: clients");
  await app.keyboard.press("left");
  await app.waitFor("Tree: clients (Clients folded)");
  expect(app.layout("id:tree-contoso")).toBeFalsy();
  await app.keyboard.press("down");
  await app.waitFor("Tree: travel (Clients folded)");
  await app.keyboard.press("home");
  await app.waitFor("Tree: inbox (Clients folded)");
  // Tab is the platform's: roving-macos.test.tsx checks the one Tab stop.
});

test("roving rules: Up and Down stop at the ends, Left and Right fold then step, Tab rests on the cursor or the open row", () => {
  const t = (key: string, depth: number, folds = false, expanded = false, opens = true) => ({ key, opens, depth, folds, expanded });
  const rows = [t("inbox", 0), t("clients", 0, true, true, false), t("contoso", 1), t("northwind", 1), t("travel", 0)];
  expect(rovingMove(rows, 0, "up")).toEqual({ kind: "none" });
  expect(rovingMove(rows, 4, "down")).toEqual({ kind: "none" });
  expect(rovingMove(rows, 2, "end")).toEqual({ kind: "move", index: 4 });
  expect(rovingMove(rows, 1, "left")).toEqual({ kind: "fold", index: 1, expanded: false });
  expect(rovingMove(rows, 1, "right")).toEqual({ kind: "move", index: 2 });
  expect(rovingMove(rows, 3, "left")).toEqual({ kind: "move", index: 1 });
  expect(rovingMove(rows.map((r, i) => (i === 1 ? { ...r, expanded: false } : r)), 1, "right")).toEqual({ kind: "fold", index: 1, expanded: true });
  // A row that may not be a parent is skipped on the way out.
  expect(rovingMove([{ ...t("box", 0), parent: false }, t("child", 1)], 1, "left")).toEqual({ kind: "none" });
  expect(restingIndex(rows, "travel", "")).toBe(4);
  expect(restingIndex(rows, "travel", "inbox")).toBe(0);
  expect(restingIndex(rows, "gone", "")).toBe(0);
  expect(restingIndex([], "", "")).toBe(-1);
});

test("a select's check sits in a fixed lane: every item's lane lines up, chosen or not", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:theme-select");
  await app.press("id:theme-select");
  await app.press("role:option[Dark]");
  await app.press("id:theme-select");
  await app.waitFor("Same as the desktop");
  const lanes = ["system", "light", "dark"].map((v) => app.layout(`id:theme-select-check-${v}`)!);
  for (const lane of lanes) {
    expect(Math.abs(lane.x - lanes[0].x)).toBeLessThan(0.5);
    expect(Math.round(lane.width)).toBe(16);
  }
  expect(app.viewStyle("id:theme-select-check-dark")!.opacity).toBe(1);
  expect(app.viewStyle("id:theme-select-check-light")!.opacity).toBe(0);
});

test("a titled notice sets its title on its top hairline, keeps its tone icon and alert role", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:notice-titled");
  const frame = app.layout("id:notice-titled-frame")!;
  const title = app.layout("id:notice-titled-title")!;
  expect(Math.abs(title.y + title.height / 2 - frame.y)).toBeLessThanOrEqual(2);
  expect(app.accessibility("id:notice-titled")?.role).toBe("alert");
  expect(app.layout("id:notice-titled-action")).toBeTruthy();
  // The plain form is unchanged: one raised line.
  expect(app.layout("id:notice-plain-frame")).toBeFalsy();
});

test("an outline tool button draws its border at rest, at the ghost's size", async () => {
  const app = await open(GALLERY, SIZE);
  await app.waitFor("id:tb-outline");
  const outline = app.layout("id:tb-outline")!;
  const ghost = app.layout("id:tb-ghost")!;
  expect(outline.width).toBe(ghost.width);
  expect(outline.height).toBe(ghost.height);
  // The border itself is checked on screen (shots.test.tsx): viewStyle has no border colour.
});

test("a pointer press on a nav row gives the list the keyboard: the arrows work at once", async () => {
  const app = await open(GALLERY, { ...SIZE, platform: "macos" });
  await app.waitFor("id:tree");
  await app.press("id:tree-clients");
  await app.waitFor("Tree: clients");
  await app.keyboard.press("down");
  await app.waitFor("Tree: contoso");
});

test("a pointer press on a row of a simple nav list gives it the keyboard too", async () => {
  // Linux: headless macOS delivers no onKeyDown to a pressable view after a
  // pointer press (the tree's arrows are keymap bindings, which it does).
  const app = await open(GALLERY, { ...SIZE, platform: "linux" });
  await app.waitFor("id:nav-work");
  await app.press("id:nav-work");
  await app.waitUntil(() => app.accessibility("id:nav-work")?.selected === true);
  await app.wait(50);
  await app.keyboard.press("down");
  await app.waitUntil(() => app.accessibility("id:nav-clients")?.selected === true);
});


// nsh-omarchy 0.2.0's built-in palettes (src/theme.rs, `Palette::roles`), as
// test data: the roles the fill pass reads. Flexoki Light has no ANSI colors.
const BUILT_IN: Record<string, Record<string, string>> = {
  "tokyo-night": {
    background: "#1a1b26", foreground: "#a9b1d6", primary: "#7aa2f7", destructive: "#f7768e", border: "#414868",
    surface: "#24283b", inset: "#13141c", muted: "#13141c", danger: "#f7768e", warning: "#e0af68", success: "#9ece6a",
    "text-secondary": "#858baa", "omarchy-accent": "#7aa2f7",
    "chart-1": "#7aa2f7", "chart-2": "#bb9af7", "chart-3": "#7dcfff", "chart-4": "#e0af68", "chart-5": "#9ece6a",
    ...Object.fromEntries(
      ["#32344a", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#ad8ee6", "#449dab", "#787c99",
        "#444b6a", "#ff7a93", "#b9f27c", "#ff9e64", "#7da6ff", "#bb9af7", "#0db9d7", "#acb0d0"].map((c, i) => [`ansi-${i}`, c]),
    ),
  },
  "flexoki-light": {
    background: "#fffcf0", foreground: "#100f0f", primary: "#205ea6", destructive: "#af3029", border: "#b7b5ac",
    surface: "#f2f0e5", inset: "#e6e4d9", muted: "#e6e4d9", danger: "#af3029", warning: "#855b00", success: "#526600",
    "text-secondary": "#575653", "omarchy-accent": "#205ea6",
    "chart-1": "#205ea6", "chart-2": "#a02f6f", "chart-3": "#24837b", "chart-4": "#855b00", "chart-5": "#526600",
  },
};

function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return -1;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

test("a filled terminal or accent color keeps its hue on every built-in palette", () => {
  // Hue bands, in degrees: a filled "blue" is blue whatever it was filled from.
  const bands: Record<string, [number, number][]> = {
    red: [[330, 360], [0, 20]],
    orange: [[15, 50]],
    yellow: [[15, 65]],
    green: [[60, 150]],
    cyan: [[160, 200]],
    blue: [[200, 250]],
    violet: [[250, 335]],
  };
  const expected: Record<string, string> = {
    "ansi-1": "red", "ansi-9": "red", "ansi-2": "green", "ansi-10": "green",
    "ansi-3": "yellow", "ansi-11": "yellow", "ansi-4": "blue", "ansi-12": "blue",
    "ansi-5": "violet", "ansi-13": "violet", "ansi-6": "cyan", "ansi-14": "cyan",
    violet: "violet", cyan: "cyan", orange: "orange",
  };
  for (const [name, palette] of Object.entries(BUILT_IN)) {
    const filled = completeOmarchy((role) => palette[role]);
    for (const role of ROLES) expect(typeof filled[role]).toBe("string");
    for (const [role, band] of Object.entries(expected)) {
      const h = hue(filled[role]);
      const inBand = bands[band].some(([lo, hi]) => h >= lo && h < hi);
      if (!inBand) throw new Error(`${name}: ${role} is ${filled[role]} (hue ${Math.round(h)}), not ${band}`);
    }
  }
});

test("a row's quick actions are its accessibility actions, and performing one by name runs it", () => {
  const done: string[] = [];
  const { accessibilityActions, perform } = quickActionsA11y([
    { name: "archive", label: "Archive", icon: "archive", onPerform: () => done.push("archive") },
    { name: "trash", label: "Delete", icon: "trash", onPerform: () => done.push("trash") },
    { name: "star", label: "Star", icon: "star", onPerform: () => done.push("star") },
  ]);
  expect(accessibilityActions).toEqual([
    { name: "archive", label: "Archive" },
    { name: "trash", label: "Delete" },
    { name: "star", label: "Star" },
  ]);
  expect(perform("trash")).toBe(true);
  expect(perform("star")).toBe(true);
  expect(perform("activate")).toBe(false);
  expect(done).toEqual(["trash", "star"]);
});

test("a lane action is a named button that a pointer press performs, not the row", async () => {
  const app = await open(GALLERY, { ...SIZE, platform: "macos" });
  await app.waitFor("id:row-lane");
  await app.hover("id:row-lane");
  await app.waitUntil(() => app.viewStyle("id:row-lane-actions")?.opacity === 1);
  expect(app.accessibility("id:row-lane-archive")?.role).toBe("button");
  expect(app.accessibility("id:row-lane-archive")?.label).toBe("Archive");
  await app.press("id:row-lane-archive");
  await app.waitFor("Lane: archived");
  expect(app.accessibility("id:row-lane")?.selected).toBe(false);
});
