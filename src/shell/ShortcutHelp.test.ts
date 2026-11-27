import { expect, test } from "nsh/test";
import * as Keys from "../keys/keymap";
import { keyCaps } from "../keys/labels";

test("no two sheet rows say the same thing", () => {
  const seen = new Map<string, string>();
  for (const group of Keys.helpGroups()) {
    for (const row of group.rows) {
      expect(seen.has(row.action) ? `${row.action} in ${seen.get(row.action)} and ${group.name}` : "").toBe("");
      seen.set(row.action, group.name);
    }
  }
});

test("opening a message is one row with every key that does it", () => {
  const moving = Keys.helpGroups().find((g) => g.name === "Moving")!;
  const open = moving.rows.filter((r) => r.action === "Open the selected message");
  expect(open.length).toBe(1);
  expect(keyCaps(open[0].keys).length).toBe(3);
});

test("calendar-editor keys sit with the calendar, not under Writing", () => {
  const groups = Keys.helpGroups();
  const writing = groups.find((g) => g.name === "Writing")!.rows.map((r) => r.action);
  for (const action of ["Create an event", "Save and close the event", "Next guest suggestion", "Previous guest suggestion", "Choose guest suggestion"]) {
    expect(writing.includes(action)).toBe(false);
  }
  expect(groups.find((g) => g.name === "Calendar")!.rows.some((r) => r.action === "Create an event")).toBe(true);
  expect(groups.find((g) => g.name === "Calendar editor")!.rows.length).toBe(4);
});
