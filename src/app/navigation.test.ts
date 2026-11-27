// Port of omarchy/ui/tests/test_navigation.js.
import { expect, test } from "nsh/test";
import * as nav from "./navigation";

const list = [nav.entry("list")];
const reader1 = nav.push(list, nav.entry("reader", { id: "m1" }));
const compose1 = nav.push(reader1, nav.entry("compose"));
const helpOverCompose = nav.push(compose1, nav.entry("help"));

test("entries are known kinds, copied", () => {
  expect(nav.ROOTS).toEqual(["list", "calendar"]);
  expect(nav.OVERLAYS).toEqual(["compose", "eventComposer", "help"]);
  expect(nav.entry("reader", { id: "m1" })).toEqual({ id: "m1", kind: "reader" });
  expect(nav.entry("nothing-of-the-sort")).toEqual({ kind: "list" });
  expect(nav.entry(null)).toEqual({ kind: "list" });
  expect(nav.entry("settings", { kind: "bogus" })).toEqual({ kind: "settings" });
  for (const kind of ["compose", "eventComposer", "help"]) expect(nav.isOverlay(kind)).toBe(true);
  for (const kind of ["reader", "", null]) expect(nav.isOverlay(kind)).toBe(false);
  expect(nav.top([])).toEqual({ kind: "list" });
  expect(nav.top(null)).toEqual({ kind: "list" });
  expect(nav.page([])).toEqual({ kind: "list" });
  expect(nav.overlay([])).toBe(null);
  expect(nav.depth(null)).toBe(0);
  expect(nav.kinds(null)).toEqual([]);
});

test("push, pop and replace retrace the way", () => {
  let stack = nav.push(list, nav.entry("settings"));
  stack = nav.push(stack, nav.entry("picker"));
  stack = nav.push(stack, nav.entry("setup", { provider: "imap", draft: true }));
  expect(nav.kinds(stack)).toEqual(["list", "settings", "picker", "setup"]);
  expect(nav.top(stack)).toEqual({ kind: "setup", provider: "imap", draft: true });
  stack = nav.pop(stack) as nav.NavEntry[];
  stack = nav.pop(stack) as nav.NavEntry[];
  stack = nav.pop(stack) as nav.NavEntry[];
  expect(nav.kinds(stack)).toEqual(["list"]);
  expect(nav.kinds(nav.replace(nav.push(list, nav.entry("settings")), nav.entry("picker")))).toEqual(["list", "picker"]);
  expect(nav.replace([], nav.entry("settings"))).toEqual([{ kind: "settings" }]);
  expect(nav.kinds(nav.push(list, null))).toEqual(["list"]);
  expect(nav.kinds(nav.push([], nav.entry("settings")))).toEqual(["list", "settings"]);
  expect(nav.kinds(nav.push(list, { kind: "no-such-page" }))).toEqual(["list", "list"]);
});

test("the next message and a second overlay replace", () => {
  const reader2 = nav.push(reader1, nav.entry("reader", { id: "m2" }));
  expect(nav.kinds(reader2)).toEqual(["list", "reader"]);
  expect(nav.top(reader2)).toEqual({ kind: "reader", id: "m2" });
  expect(nav.kinds(nav.pop(reader2))).toEqual(["list"]);
  const help2 = nav.push(nav.push(reader1, nav.entry("help")), nav.entry("help"));
  expect(nav.kinds(help2)).toEqual(["list", "reader", "help"]);
  const compose2 = nav.push(compose1, nav.entry("compose"));
  expect(nav.kinds(compose2)).toEqual(["list", "reader", "compose"]);
  expect(nav.top(compose2).returnTo).toBe(2);
  expect(nav.kinds(helpOverCompose)).toEqual(["list", "reader", "compose", "help"]);
});

test("a draft returns where it was raised from", () => {
  expect(nav.kinds(nav.pop(nav.push(reader1, nav.entry("compose", { returnTo: 1 }))))).toEqual(["list"]);
  expect(nav.kinds(nav.pop(nav.push(reader1, nav.entry("compose", { returnTo: 2 }))))).toEqual(["list", "reader"]);
  expect(nav.top(nav.push(list, nav.entry("compose"))).returnTo).toBe(1);
  expect(nav.top(nav.push(reader1, nav.entry("eventComposer"))).returnTo).toBe(2);
  expect(nav.top(nav.push(reader1, nav.entry("compose", { returnTo: 1 }))).returnTo).toBe(1);
  expect(nav.top(nav.push(reader1, nav.entry("help"))).returnTo).toBe(undefined);
  const m1 = nav.entry("reader", { id: "m1" });
  expect(nav.kinds(nav.pop([nav.entry("list"), m1, nav.entry("compose", { returnTo: 7 })]))).toEqual(["list", "reader"]);
  expect(nav.kinds(nav.pop([nav.entry("list"), nav.entry("compose", { returnTo: 0 })]))).toEqual(["list"]);
  expect(nav.kinds(nav.pop([nav.entry("list"), m1, nav.entry("compose", { returnTo: "1" })]))).toEqual(["list", "reader"]);
});

test("Back on a root hands back the same stack", () => {
  const calendar = [nav.entry("calendar")];
  const picker = [nav.entry("picker")];
  expect(nav.pop(list)).toBe(list);
  expect(nav.pop(calendar)).toBe(calendar);
  expect(nav.pop(picker)).toBe(picker);
  expect(nav.pop(reader1)).not.toBe(reader1);
  expect(nav.pop([])).toEqual([{ kind: "list" }]);
  expect(nav.pop(null as unknown as nav.NavStack)).toEqual([{ kind: "list" }]);
});

test("page and overlay read through the overlays", () => {
  const readerHelp = nav.push(reader1, nav.entry("help"));
  expect(nav.page(readerHelp)).toEqual({ kind: "reader", id: "m1" });
  expect(nav.overlay(readerHelp)).toEqual({ kind: "help" });
  expect(nav.page(helpOverCompose)).toEqual({ kind: "reader", id: "m1" });
  expect(nav.overlay(nav.pop(helpOverCompose))).toEqual({ kind: "compose", returnTo: 2 });
  expect(nav.overlay(reader1)).toBe(null);
  expect(nav.page([nav.entry("help")])).toEqual({ kind: "list" });
});

test("roots and resets", () => {
  expect(nav.replaceRoot(reader1, "calendar")).toEqual([{ kind: "calendar" }]);
  expect(nav.resetTo(helpOverCompose, "list")).toEqual([{ kind: "list" }]);
  expect(nav.resetTo(reader1, "picker")).toEqual([{ kind: "picker" }]);
  expect(nav.replaceRoot(reader1, "not-a-kind")).toEqual([{ kind: "list" }]);
  expect(nav.rootFor({ anyReady: true, view: "list" })).toEqual([{ kind: "list" }]);
  expect(nav.rootFor({ anyReady: true, view: "calendar" })).toEqual([{ kind: "calendar" }]);
  expect(nav.rootFor({ anyReady: true, view: "reader" })).toEqual([{ kind: "list" }]);
  expect(nav.rootFor({ anyReady: false, hasSavedAccounts: false })).toEqual([{ kind: "picker" }]);
  expect(nav.rootFor({ anyReady: false, hasSavedAccounts: true, setupUnderway: true, provider: "imap" }))
    .toEqual([{ kind: "picker" }, { kind: "setup", provider: "imap", draft: false }]);
  expect(nav.rootFor({ anyReady: false, hasSavedAccounts: true, setupUnderway: false })).toEqual([{ kind: "picker" }]);
  expect(nav.rootFor({ anyReady: false, hasSavedAccounts: false, view: "calendar" })).toEqual([{ kind: "picker" }]);
  expect(nav.rootFor({ anyReady: false, hasSavedAccounts: false, setupUnderway: true })).toEqual([{ kind: "picker" }]);
  expect(nav.rootFor(null)).toEqual([{ kind: "picker" }]);
});

test("no function edits the stack it was given", () => {
  const before = [nav.entry("list"), nav.entry("reader", { id: "m1" }), nav.entry("compose", { returnTo: 1 })];
  const snapshot = JSON.stringify(before);
  const draft = nav.entry("compose");
  const draftSnapshot = JSON.stringify(draft);
  nav.push(before, draft);
  nav.push(before, nav.entry("reader", { id: "m2" }));
  nav.pop(before);
  nav.replace(before, nav.entry("settings"));
  nav.resetTo(before, "list");
  expect(JSON.stringify(before)).toBe(snapshot);
  expect(JSON.stringify(draft)).toBe(draftSnapshot);
  const pushed = nav.push(before, nav.entry("help"));
  expect(pushed).not.toBe(before);
  expect(pushed[0]).not.toBe(before[0]);
  const settings = nav.entry("settings");
  expect(nav.push(list, settings)[1]).not.toBe(settings);
});
