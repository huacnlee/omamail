import { expect, test } from "nsh/test";
import { chordLabel, isApple, keyCaps } from "./labels";

test("chords read as this platform writes them, never mod", () => {
  const apple = isApple();
  expect(chordLabel("Shift+J")).toBe(apple ? "⇧J" : "Shift+J");
  expect(chordLabel("Ctrl+Enter")).toBe(apple ? "⌘↩" : "Ctrl+Enter");
  expect(chordLabel("Ctrl++")).toBe(apple ? "⌘+" : "Ctrl++");
  expect(chordLabel("Ctrl+1…9")).toBe(apple ? "⌘1…9" : "Ctrl+1…9");
  expect(chordLabel("Alt+1…0")).toBe(apple ? "⌥1…0" : "Alt+1…0");
  expect(chordLabel("Esc")).toBe("esc");
  expect(chordLabel("?")).toBe("?");
  expect(chordLabel("j")).toBe("J");
  for (const text of ["Ctrl+A", "Ctrl+Shift+M", "Ctrl+,", "Ctrl+-"]) expect(chordLabel(text).includes("mod")).toBe(false);
});

test("one cap per key: alternatives split, sequences stay together", () => {
  const apple = isApple();
  expect(keyCaps("Shift+J / Shift+K")).toEqual(apple ? ["⇧J", "⇧K"] : ["Shift+J", "Shift+K"]);
  expect(keyCaps("j, Down")).toEqual(["J", apple ? "↓" : "Down"]);
  expect(keyCaps("Enter, Ctrl+Enter")).toEqual(apple ? ["↩", "⌘↩"] : ["Enter", "Ctrl+Enter"]);
  expect(keyCaps("Return, Enter").length).toBe(1);
  expect(keyCaps("g then i")).toEqual(["G I"]);
  expect(keyCaps("")).toEqual([]);
});
