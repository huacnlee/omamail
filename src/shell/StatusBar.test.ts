import { expect, test } from "nsh/test";
import * as Keys from "../keys/keymap";
import { isApple, keyCaps } from "../keys/labels";
import { placeName } from "./StatusBar";

const MAILBOXES = [{ key: "inbox", label: "Inbox" }, { key: "sent", label: "Sent" }];
const LABELS = [{ id: "L1", name: "Clients/Northwind" }, { id: "L2", name: "Work.Ops", delimiter: "." }];
const at = (patch: Partial<Parameters<typeof placeName>[0]>) =>
  placeName({ page: "mail", composing: false, mailbox: "inbox", mailboxes: MAILBOXES, labels: LABELS, ...patch });

test("the place pill names the page, or the mailbox in capitals", () => {
  expect(at({})).toBe("INBOX");
  expect(at({ mailbox: "sent" })).toBe("SENT");
  expect(at({ composing: true })).toBe("COMPOSE");
  expect(at({ page: "settings" })).toBe("SETTINGS");
  expect(at({ page: "calendar" })).toBe("CALENDAR");
  expect(at({ page: "setup" })).toBe("SETUP");
});

test("a label shows its last segment by its own delimiter; unknown keys fall back", () => {
  expect(at({ mailbox: "label:L1" })).toBe("NORTHWIND");
  expect(at({ mailbox: "label:L2" })).toBe("OPS");
  expect(at({ mailbox: "label:gone" })).toBe("GONE");
  expect(at({ mailbox: "nowhere" })).toBe("MAIL");
});

test("every sheet row and hint is drawn as platform key caps, never raw binding text", () => {
  const texts: string[] = [];
  for (const group of Keys.helpGroups()) for (const row of group.rows) texts.push(row.keys);
  for (const context of ["list", "reader", "calendar"]) for (const h of Keys.hintsFor(context, [], true, null)) texts.push(h.key);
  for (const text of texts) {
    const caps = keyCaps(text);
    expect(caps.length > 0).toBe(true);
    for (const cap of caps) {
      expect(/\bmod\b/i.test(cap)).toBe(false);
      expect(cap.includes(" / ") || cap.includes(", ")).toBe(false);
      if (isApple()) expect(/Ctrl\+|Shift\+|Alt\+|Cmd\+/.test(cap)).toBe(false);
    }
  }
  expect(keyCaps("Shift+J / Shift+K").length).toBe(2);
});
