// Port of the label cases in omarchy/ui/tests/test_model.js.
import { expect, test } from "nsh/test";
import * as m from "./labels";

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

test("move destinations skip system labels and the label on screen", () => {
  const set = [
    { id: "L2", name: "zebra" },
    { id: "S1", name: "Inbox", system: true },
    { id: "L1", name: "Archive notes" },
    { id: "L3", name: "banana" },
  ];
  expect(ids(m.movableLabels(set, ""))).toEqual(["L1", "L3", "L2"]);
  expect(ids(m.movableLabels(set, "an"))).toEqual(["L3", "L1"]);
  expect(ids(m.movableLabels(set, "  ZEB  "))).toEqual(["L2"]);
  expect(ids(m.movableLabels(set, "inbox"))).toEqual([]);
  expect(ids(m.movableLabels(set, "", "L3"))).toEqual(["L1", "L2"]);
  expect(m.movableLabels(null, "")).toEqual([]);
});

test("a folder provider offers the Inbox as a destination, and only the Inbox", () => {
  const folders = [
    { id: "INBOX", name: "INBOX", system: true, delimiter: "/" },
    { id: "Junk", name: "Junk", system: true, delimiter: "/" },
    { id: "Sent Messages/Notes", name: "Sent Messages/Notes", system: false, delimiter: "/" },
  ];
  expect(ids(m.movableLabels(folders, ""))).toEqual(["Sent Messages/Notes"]);
  expect(ids(m.movableLabels(folders, "", "", true))).toEqual(["INBOX", "Sent Messages/Notes"]);
  expect(ids(m.movableLabels(folders, "", "INBOX", true))).toEqual(["Sent Messages/Notes"]);
  expect(ids(m.movableLabels(folders, "in", "", true))).toEqual(["INBOX"]);
  expect(ids(m.movableLabels(folders, "in"))).toEqual([]);
  expect(ids(m.movableLabels(folders, "junk", "", true))).toEqual([]);
  expect(m.labelTree(folders, []).filter((r) => r.id === "INBOX")).toEqual([]);
});

test("the move picker steps children in under their parent until letters are typed", () => {
  const labels = [
    { id: "INBOX", name: "INBOX", system: true },
    { id: "Work/2026", name: "Work/2026", rawName: "Work/2026", delimiter: "/" },
    { id: "Receipts", name: "Receipts", rawName: "Receipts", delimiter: "/" },
    { id: "Work", name: "Work", rawName: "Work", delimiter: "/" },
    { id: "Work/Invoices", name: "Work/Invoices", rawName: "Work/Invoices", delimiter: "/" },
  ];
  expect(m.movableLabels(labels, "", "").map((l) => [l.id, l.depth, l.leaf])).toEqual([
    ["Receipts", 0, "Receipts"], ["Work", 0, "Work"], ["Work/2026", 1, "2026"], ["Work/Invoices", 1, "Invoices"],
  ]);
  expect(ids(m.movableLabels(labels, "", "Work"))).toEqual(["Receipts", "Work/2026", "Work/Invoices"]);
  expect(m.movableLabels(labels, "inv", "").map((l) => [l.id, l.depth, l.leaf])).toEqual([["Work/Invoices", 0, "Work/Invoices"]]);
  expect(ids(m.movableLabels(labels, "wk", ""))).toEqual(["Work", "Work/2026", "Work/Invoices"]);
  expect(m.movableLabels(labels, "zzz", "")).toEqual([]);
  expect((labels[1] as any).depth).toBeUndefined();
});

test("badge text caps and drops zero", () => {
  expect(m.badgeText(0)).toBe("");
  expect(m.badgeText(7)).toBe("7");
  expect(m.badgeText(99)).toBe("99");
  expect(m.badgeText(100)).toBe("99+");
  expect(m.badgeText(1500, 99)).toBe("99+");
  expect(m.badgeText(-3)).toBe("");
});

test("rail labels are A to Z, case folded, stable by id, with no system label", () => {
  const reported = [
    { id: "L2", name: "zebra", rawName: "zebra" },
    { id: "S1", name: "Inbox", rawName: "INBOX", system: true },
    { id: "L4", name: "Work/Invoices", rawName: "Work/Invoices" },
    { id: "L1", name: "Bills", rawName: "Bills" },
    { id: "L3", name: "Work", rawName: "Work" },
    { id: "L5", name: "archive notes", rawName: "archive notes" },
  ];
  expect(ids(m.railLabels(reported))).toEqual(["L5", "L1", "L3", "L4", "L2"]);
  const twins = [{ id: "b", name: "Work" }, { id: "c", name: "Bills" }, { id: "a", name: "work" }];
  expect(ids(m.railLabels(twins))).toEqual(["c", "a", "b"]);
  expect(ids(m.railLabels(twins.slice().reverse()))).toEqual(["c", "a", "b"]);
  expect(ids(reported)).toEqual(["L2", "S1", "L4", "L1", "L3", "L5"]);
  expect(m.railLabels(null)).toEqual([]);
  expect(ids(m.railLabels([null, { id: "L9", name: "x" }]))).toEqual(["L9"]);
});

test("slots number the rail's own rows, mailboxes first", () => {
  const boxes = [{ key: "inbox", label: "Inbox" }, { key: "unread", label: "Unread" }, { key: "sent", label: "Sent" }];
  const labels = [
    { id: "SYS", name: "Category", rawName: "Category", system: true },
    { id: "L1", name: "Work", rawName: "Work" },
    { id: "L2", name: "Bills", rawName: "Bills" },
  ];
  const slots = m.sidebarSlots(boxes, m.visibleLabels(labels, []), 10);
  expect(slots.length).toBe(5);
  expect(slots[0]).toMatchObject({ kind: "mailbox", key: "inbox" });
  expect(slots[3]).toMatchObject({ kind: "label", id: "L2", name: "Bills" });
  expect((m.sidebarSlots(boxes, labels, 10)[3] as any).id).toBe("L1");
  const tree = [
    { id: "Work (old)", name: "Work (old)", delimiter: "/" },
    { id: "Work/Invoices", name: "Work/Invoices", delimiter: "/" },
    { id: "Work", name: "Work", delimiter: "/" },
  ];
  expect(m.sidebarSlots([], m.visibleLabels(tree, []), 10).map((s: any) => s.id)).toEqual(["Work", "Work/Invoices", "Work (old)"]);
  expect(m.sidebarSlots([], m.visibleLabels(tree, ["Work"]), 10).map((s: any) => s.id)).toEqual(["Work", "Work (old)"]);
  expect(m.slotNumberOf(slots, "mailbox", "inbox")).toBe(1);
  expect(m.slotNumberOf(slots, "mailbox", "sent")).toBe(3);
  expect(m.slotNumberOf(slots, "label", "L1")).toBe(5);
  expect(m.slotNumberOf(slots, "label", "SYS")).toBe(0);
  expect(m.slotNumberOf(slots, "mailbox", "L1")).toBe(0);
  expect(m.slotNumberOf([], "mailbox", "inbox")).toBe(0);
  const many = Array.from({ length: 14 }, (_, i) => ({ id: "L" + i, name: "n" + i, rawName: "n" + i }));
  expect(m.sidebarSlots(boxes, many, 9).length).toBe(9);
  expect(m.slotNumberOf(m.sidebarSlots(boxes, many, 9), "label", "L6")).toBe(0);
  expect(m.sidebarSlots(null, null, 10).length).toBe(0);
});

test("the cursor wraps at both ends", () => {
  expect(m.wrappedIndex(0, 1, 3)).toBe(1);
  expect(m.wrappedIndex(2, 1, 3)).toBe(0);
  expect(m.wrappedIndex(0, -1, 3)).toBe(2);
  expect(m.wrappedIndex(1, 0, 3)).toBe(1);
  expect(m.wrappedIndex(0, 1, 1)).toBe(0);
  expect(m.wrappedIndex(0, 1, 0)).toBe(0);
  expect(m.wrappedIndex(-1, 1, 3)).toBe(0);
});

test("the label tree nests, folds and counts folded subtrees", () => {
  const labels = [
    { id: "Archive", name: "Archive", rawName: "Archive", delimiter: "/", unread: 1 },
    { id: "Archive/2025", name: "Archive/2025", rawName: "Archive/2025", delimiter: "/", unread: 2 },
    { id: "Archive/2026/Q1", name: "Archive/2026/Q1", rawName: "Archive/2026/Q1", delimiter: "/", unread: 4 },
    { id: "Receipts", name: "Receipts", rawName: "Receipts", delimiter: "/", unread: 0 },
    { id: "Label_3", name: "todo", rawName: "todo", unread: 1 },
  ];
  const open = m.labelTree(labels, []);
  expect(open.map((r) => [r.path, r.depth, r.selectable, r.hasChildren, r.unread])).toEqual([
    ["Archive", 0, true, true, 1],
    ["Archive/2025", 1, true, false, 2],
    ["Archive/2026", 1, false, true, 0],
    ["Archive/2026/Q1", 2, true, false, 4],
    ["Receipts", 0, true, false, 0],
    ["todo", 0, true, false, 1],
  ]);
  expect(open[3].name).toBe("Q1");
  expect(open[3].id).toBe("Archive/2026/Q1");
  const folded = m.labelTree(labels, ["Archive"]);
  expect(folded.map((r) => r.path)).toEqual(["Archive", "Receipts", "todo"]);
  expect(folded[0].expanded).toBe(false);
  expect(folded[0].unread).toBe(7);
  const partly = m.labelTree(labels, ["Archive/2026"]);
  expect(partly.map((r) => r.path)).toEqual(["Archive", "Archive/2025", "Archive/2026", "Receipts", "todo"]);
  expect(partly[2].unread).toBe(4);
  const dotted = m.labelTree([{ id: "a.b", name: "a.b", delimiter: "." }, { id: "a", name: "a", delimiter: "." }, { id: "x/y", name: "x/y" }], []);
  expect(dotted.map((r) => [r.path, r.depth])).toEqual([["a", 0], ["a.b", 1], ["x", 0], ["x/y", 1]]);
  expect(ids(m.visibleLabels(labels, ["Archive"]))).toEqual(["Archive", "Receipts", "Label_3"]);
  expect(ids(m.visibleLabels(labels, []))).toEqual(["Archive", "Archive/2025", "Archive/2026/Q1", "Receipts", "Label_3"]);
  expect(m.togglePath(["Archive"], "Archive")).toEqual([]);
  expect(m.togglePath([], "Archive/2026")).toEqual(["Archive/2026"]);
  expect(m.labelTree(null, null)).toEqual([]);
  const odd = m.labelTree([
    { id: "constructor", name: "constructor" }, { id: "constructor/2026", name: "constructor/2026" },
    { id: "__proto__", name: "__proto__" }, { id: "toString", name: "toString" },
  ], []);
  expect(odd.map((r) => r.path)).toEqual(["__proto__", "constructor", "constructor/2026", "toString"]);
});

test("the delimiter is the server's word, and none means flat", () => {
  expect(m.labelDelimiter({ delimiter: "." })).toBe(".");
  expect(m.labelDelimiter({ name: "todo" } as any)).toBe("/");
  expect(m.labelDelimiter(null)).toBe("/");
  expect(m.labelDelimiter({ delimiter: "" })).toBe("");
  const flat = m.labelTree([
    { id: "a/b", name: "a/b", rawName: "a/b", delimiter: "" },
    { id: "a", name: "a", rawName: "a", delimiter: "" },
    { id: "x.y", name: "x.y", rawName: "x.y", delimiter: "" },
  ], []);
  expect(flat.map((r) => [r.path, r.depth, r.hasChildren, r.selectable])).toEqual([
    ["a", 0, false, true], ["a/b", 0, false, true], ["x.y", 0, false, true],
  ]);
  expect(ids(m.visibleLabels([{ id: "a/b", name: "a/b", delimiter: "" }, { id: "a", name: "a", delimiter: "" }], ["a"]))).toEqual(["a", "a/b"]);
  expect(m.labelTree([{ id: "a.b", name: "a.b", delimiter: "/" }, { id: "a", name: "a", delimiter: "/" }], []).map((r) => [r.path, r.depth]))
    .toEqual([["a", 0], ["a.b", 0]]);
});

test("label paths, names and move targets", () => {
  expect(m.labelLeaf("Archive/2026/Q1", "/")).toBe("Q1");
  expect(m.labelParent("Archive/2026/Q1", "/")).toBe("Archive/2026");
  expect(m.labelParent("Receipts", "/")).toBe("");
  expect(m.labelPathJoin("Archive", " 2026 ", "/")).toBe("Archive/2026");
  expect(m.labelPathJoin("", "Receipts", "/")).toBe("Receipts");
  expect(m.labelPathJoin("a", "b", ".")).toBe("a.b");
  expect(m.labelNameProblem("  ", "/")).toBe("A label needs a name");
  expect(m.labelNameProblem("a/b", "/")).toContain("cannot contain /");
  expect(m.labelNameProblem("Receipts", "/")).toBe("");
  const labels = [
    { id: "INBOX", name: "INBOX", system: true },
    { id: "Archive", rawName: "Archive" },
    { id: "Archive/2026", rawName: "Archive/2026" },
    { id: "Archive/2026/Q1", rawName: "Archive/2026/Q1" },
    { id: "Receipts", rawName: "Receipts" },
  ];
  expect(m.labelMoveTargets(labels, "Archive/2026", "/").map((t) => t.path)).toEqual(["", "Receipts"]);
  expect(m.labelMoveTargets(labels, "Receipts", "/").map((t) => t.path)).toEqual(["", "Archive", "Archive/2026", "Archive/2026/Q1"]);
  expect(m.labelMoveTargets(labels, "Receipts", "/")[0].name).toBe("Top level");
  // No hierarchy.
  expect(m.labelLeaf("a/b", "")).toBe("a/b");
  expect(m.labelParent("a/b", "")).toBe("");
  expect(m.labelPathJoin("", "a/b", "")).toBe("a/b");
  expect(m.labelNameProblem("a/b", "")).toBe("");
  expect(m.labelNestProblem("", "")).toBe("");
  expect(m.labelNestProblem("Work", "/")).toBe("");
  expect(m.labelNestProblem("Work", "")).toContain("flat list");
  expect(m.labelMoveTargets([{ id: "a", name: "a" }, { id: "b", name: "b" }], "a", "")).toEqual([{ id: "", name: "Top level", path: "" }]);
  expect(m.labelLeaf("a.b", undefined)).toBe("a.b");
  expect(m.labelPathJoin("a", "b", undefined)).toBe("a/b");
});

test("the watch note names the two that grew most", () => {
  expect(m.monitoredNote([{ name: "Receipts", delta: 3 }])).toBe("3 new in Receipts");
  expect(m.monitoredNote([{ name: "A", delta: 1 }, { name: "B", delta: 4 }, { name: "C", delta: 2 }])).toBe("4 new in B, 2 new in C and 1 more");
  expect(m.monitoredNote([])).toBe("");
});

test("watched ids follow renames and moves, and leave with a delete", () => {
  const d = "/";
  const before = [{ id: "Work", name: "Work", delimiter: d }, { id: "Work/2026", name: "Work/2026", delimiter: d },
    { id: "Work/2026/Q1", name: "Work/2026/Q1", delimiter: d }, { id: "Receipts", name: "Receipts", delimiter: d }];
  const after = [{ id: "Jobs", name: "Jobs", delimiter: d }, { id: "Jobs/2026", name: "Jobs/2026", delimiter: d },
    { id: "Jobs/2026/Q1", name: "Jobs/2026/Q1", delimiter: d }, { id: "Receipts", name: "Receipts", delimiter: d }];
  expect(m.migrateMonitoredIds(["Work", "Receipts", "Work/2026/Q1"], before, after, "Work", "Jobs", d)).toEqual(["Jobs", "Receipts", "Jobs/2026/Q1"]);
  expect(m.migrateMonitoredIds(["Work/2026"], before, after, "Work", "Jobs", d)).toEqual(["Jobs/2026"]);
  const moved = [{ id: "Archive", name: "Archive", delimiter: d }, { id: "Archive/Work", name: "Archive/Work", delimiter: d },
    { id: "Archive/Work/2026", name: "Archive/Work/2026", delimiter: d }, { id: "Receipts", name: "Receipts", delimiter: d }];
  expect(m.migrateMonitoredIds(["Work/2026", "Receipts"], before, moved, "Work", "Archive/Work", d)).toEqual(["Archive/Work/2026", "Receipts"]);
  expect(m.migrateMonitoredIds(["Work", "Work/2026", "Receipts"], before, [{ id: "Receipts", name: "Receipts", delimiter: d }], "Work", "", d)).toEqual(["Receipts"]);
  const same = ["Receipts"];
  expect(m.migrateMonitoredIds(same, before, after, "Work", "Jobs", d)).toBe(same);
  const kept = ["Label_2"];
  expect(m.migrateMonitoredIds(kept, [{ id: "Label_1", name: "Work" }, { id: "Label_2", name: "Work/2026" }],
    [{ id: "Label_1", name: "Jobs" }, { id: "Label_2", name: "Jobs/2026" }], "Work", "Jobs", d)).toBe(kept);
  expect(m.migrateMonitoredIds(["Work", "Work/2026"], [{ id: "Work", name: "Work", delimiter: "" }, { id: "Work/2026", name: "Work/2026", delimiter: "" }],
    [{ id: "Jobs", name: "Jobs", delimiter: "" }, { id: "Work/2026", name: "Work/2026", delimiter: "" }], "Work", "Jobs", "")).toEqual(["Jobs", "Work/2026"]);
  expect(m.migrateMonitoredIds(null, before, after, "Work", "Jobs", d)).toEqual([]);
  const old = [{ id: "Work", name: "Work" }, { id: "Receipts", name: "Receipts" }];
  expect(m.migrateMonitoredChanges(["Work", "Receipts"], [
    { before: old, oldPath: "Work", newPath: "Jobs", delimiter: d },
    { before: old, oldPath: "Receipts", newPath: "Bills", delimiter: d },
    { before: [{ id: "Jobs", name: "Jobs" }], oldPath: "Jobs", newPath: "Tasks", delimiter: d },
  ], [{ id: "Tasks", name: "Tasks" }, { id: "Bills", name: "Bills" }])).toEqual(["Tasks", "Bills"]);
});

test("type to find scores letters in order and filters rows", () => {
  expect(m.fuzzyScore("sfl", "SFL")).toBeGreaterThan(0);
  expect(m.fuzzyScore("sfl", "jack@the-sfl.com")).toBeGreaterThan(0);
  expect(m.fuzzyScore("sfl", "jack@example.com")).toBe(0);
  expect(m.fuzzyScore("wk", "Work")).toBeGreaterThan(0);
  expect(m.fuzzyScore("kw", "Work")).toBe(0);
  expect(m.fuzzyScore("work", "Work")).toBeGreaterThan(m.fuzzyScore("work", "Homework"));
  expect(m.fuzzyScore("inv", "Work/Invoices")).toBeGreaterThan(m.fuzzyScore("inv", "Convinced"));
  expect(m.fuzzyScore("", "anything")).toBe(1);
  expect(m.fuzzyScore("a", "")).toBe(0);
  const rows: any[] = [
    { name: "Inbox", key: "inbox" }, { name: "Work", id: "Work" }, { name: "Work/Invoices", id: "Work/Invoices" },
    { label: "SFL", email: "jack@the-sfl.com", name: "" }, { label: "jack", email: "jack@icloud.com", name: "jack" },
  ];
  const src = (q: string) => m.filterRows(rows, q).map((r) => r.sourceIndex);
  expect(src("")).toEqual([0, 1, 2, 3, 4]);
  expect(src("inv")).toEqual([2]);
  expect(src("work")).toEqual([1, 2]);
  expect(src("sfl")).toEqual([3]);
  expect(src("jack")).toEqual([4, 3]);
  expect(m.filterRows(rows, "zzz")).toEqual([]);
  expect(m.filterRows(null, "x")).toEqual([]);
  expect(m.filterRows(rows, "  ").length).toBe(5);
  expect(rows[2].sourceIndex).toBeUndefined();
});

test("a label view is a mailbox key with the label prefix", () => {
  expect(m.labelMailboxKey("Label_1")).toBe("label:Label_1");
  expect(m.labelIdOfMailbox("label:Work/2026")).toBe("Work/2026");
  expect(m.labelIdOfMailbox("inbox")).toBe("");
});
