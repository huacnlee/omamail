import { expect, test } from "nsh/test";
import { mergeWindowPrefs, paneWidth, prefs, resetPrefsForTests, stringList, WINDOW_DEFAULTS, windowPrefs } from "./prefs";

test("a stored file reads back normalized as Model.windowPrefs does", () => {
  expect(windowPrefs(JSON.stringify({
    sidebarCollapsed: true, sidebarWidth: 200, listWidth: 380.6, collapsedFolders: ["Work", "", "Work", 3],
    bodyZoom: 1.23, bodyMode: "original", alwaysShowImages: true, windowOpen: true,
  }))).toEqual({
    sidebarCollapsed: true, sidebarWidth: 200, listWidth: 380, collapsedFolders: ["Work", "3"],
    bodyZoom: 1.25, bodyMode: "original", alwaysShowImages: true, windowOpen: true,
  });
});

test("anything malformed is the default", () => {
  expect(windowPrefs(null)).toEqual({ ...WINDOW_DEFAULTS });
  expect(windowPrefs("not json")).toEqual({ ...WINDOW_DEFAULTS });
  expect(windowPrefs("[1,2]")).toEqual({ ...WINDOW_DEFAULTS });
  expect(windowPrefs('{"sidebarWidth":-5,"listWidth":"wide","sidebarCollapsed":"yes","bodyMode":"html","collapsedFolders":"Work","windowOpen":1}'))
    .toEqual({ ...WINDOW_DEFAULTS });
  expect(paneWidth(99999)).toBe(4000);
  expect(stringList(null)).toEqual([]);
});

test("an old file's plainTextForced reads as plain", () => {
  expect(windowPrefs('{"plainTextForced":true}').bodyMode).toBe("plain");
  expect(windowPrefs('{"plainTextForced":true,"bodyMode":"original"}').bodyMode).toBe("original");
});

test("a write keeps the keys the window does not own", () => {
  const file = { calendarsShown: true, sidebarWidth: 150, bodyMode: "plain" };
  const value = { ...WINDOW_DEFAULTS, collapsedFolders: ["Archive"], sidebarWidth: 210, bodyMode: "original" as const };
  expect(mergeWindowPrefs(file, value)).toEqual({
    calendarsShown: true,
    sidebarCollapsed: false, sidebarWidth: 210, listWidth: 0, collapsedFolders: ["Archive"],
    bodyZoom: 1, bodyMode: "original", alwaysShowImages: false, windowOpen: false,
  });
});

test("in memory, values are seeded, normalized and kept without the file", () => {
  resetPrefsForTests();
  prefs.useMemory({ bodyZoom: 1.23, collapsedFolders: ["Work", "Work"] });
  expect(prefs.inMemory()).toBe(true);
  expect(prefs.loaded()).toBe(true);
  expect(prefs.bodyZoom()).toBe(1.25);
  expect(prefs.collapsedFolders()).toEqual(["Work"]);
  prefs.toggleFolder("Archive");
  prefs.zoomBy(0.1);
  prefs.setBodyMode("plain");
  expect(prefs.collapsedFolders()).toEqual(["Work", "Archive"]);
  expect(prefs.bodyZoom()).toBe(1.35);
  expect(prefs.bodyMode()).toBe("plain");
  resetPrefsForTests();
  expect(prefs.inMemory()).toBe(false);
});
