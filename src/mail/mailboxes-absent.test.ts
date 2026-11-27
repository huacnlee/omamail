// Ports of test_jmap.js (resolveRole) and test_m365.js (absentMailboxes).
import { expect, test } from "nsh/test";
import { jmapAbsentMailboxes, m365AbsentMailboxes, m365Verified, resolveJmapRole } from "./mailboxes-absent";

const boxes = [
  { id: "a", name: "Inbox", parentId: null, role: "inbox" },
  { id: "c", name: "Junk Mail", parentId: null, role: "junk" },
  { id: "d", name: "Drafts", parentId: null, role: "drafts" },
  { id: "b", name: "Deleted Items", parentId: null, role: "trash" },
  { id: "e", name: "Sent Items", parentId: null, role: "sent" },
];

test("a JMAP role resolves by role first, case-insensitively", () => {
  expect(resolveJmapRole("inbox", boxes)).toBe("a");
  expect(resolveJmapRole("junk", boxes)).toBe("c");
  expect(resolveJmapRole("trash", boxes)).toBe("b");
  expect(resolveJmapRole("archive", boxes)).toBe("");
  expect(resolveJmapRole("INBOX", boxes)).toBe("a");
  expect(resolveJmapRole("", boxes)).toBe("");
  expect(resolveJmapRole("archive", null)).toBe("");
});

test("then by a top-level leaf name, never a nested one", () => {
  const unrolled = [
    { id: "1", name: "Inbox", parentId: null, role: "inbox" },
    { id: "2", name: "Archive", parentId: null, role: null },
    { id: "3", name: "Deleted Items", parentId: null, role: null },
    { id: "6", name: "Bulk Mail", parentId: null, role: null },
  ];
  expect(resolveJmapRole("archive", unrolled)).toBe("2");
  expect(resolveJmapRole("trash", unrolled)).toBe("3");
  expect(resolveJmapRole("junk", unrolled)).toBe("6");
  expect(resolveJmapRole("archive", [{ id: "9", name: "All Mail", parentId: null }])).toBe("9");
  expect(resolveJmapRole("junk", [{ id: "j", name: "Junk E-mail", parentId: null }])).toBe("j");
  expect(resolveJmapRole("junk", [{ id: "j", name: "Junky", parentId: null }])).toBe("");
  expect(resolveJmapRole("archive", [{ id: "n", name: "Archive", parentId: "p" }])).toBe("");
  expect(resolveJmapRole("archive", [{ id: "n", name: "Archive", parentId: null }, { id: "r", name: "Filed", role: "archive" }])).toBe("r");
  expect(resolveJmapRole("inbox", [{ id: "x", name: "Inbox", parentId: null }])).toBe("");
});

test("JMAP absent rows: null before a read, rail keys after", () => {
  expect(jmapAbsentMailboxes([])).toBe(null);
  expect(jmapAbsentMailboxes(null)).toBe(null);
  expect(jmapAbsentMailboxes(boxes)).toEqual(["archive"]);
  expect(jmapAbsentMailboxes([{ id: "a", name: "Inbox", role: "inbox" }])).toEqual(["archive", "spam", "trash"]);
});

test("M365 absent rows come from a verified check's roles", () => {
  const checked = { ok: true, roles: { inbox: { total: 4 }, sent: {}, drafts: {}, trash: {}, junk: null, archive: { total: 9 } } };
  expect(m365Verified(checked)).toBe(true);
  for (const bad of [null, {}, "ok", { ok: "true" }, { ok: false, roles: {} }]) expect(m365Verified(bad)).toBe(false);
  expect(m365AbsentMailboxes(checked)).toEqual(["spam"]);
  expect(m365AbsentMailboxes({ ok: true, roles: { archive: null, junk: {}, trash: null } })).toEqual(["archive", "trash"]);
  expect(m365AbsentMailboxes({ ok: true, roles: {} })).toEqual(["archive", "spam", "trash"]);
  expect(m365AbsentMailboxes({ ok: true })).toBe(null);
  expect(m365AbsentMailboxes(null)).toBe(null);
});
