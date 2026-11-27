// Port of the list cases in omarchy/ui/tests/test_model.js.
import { expect, test } from "nsh/test";
import * as m from "./listModel";
import type { Summary } from "./listModel";

const rows = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
const row = (fields: Partial<Summary>): Summary =>
  ({ id: "x", subject: "", snippet: "", date: null, time: "", unread: false, starred: false, ...fields }) as Summary;

test("cursor steps anchor on the cursor and clamp at the ends", () => {
  expect(m.cursorAfterOffset(rows, "", 1)).toBe("a");
  expect(m.cursorAfterOffset(rows, "", -1)).toBe("d");
  expect(m.cursorAfterOffset(rows, "a", 1)).toBe("b");
  expect(m.cursorAfterOffset(rows, "d", 1)).toBe("d");
  expect(m.cursorAfterOffset(rows, "c", -1)).toBe("b");
  expect(m.cursorAfterOffset(rows, "a", -1)).toBe("a");
  expect(m.cursorAfterOffset([], "a", 1)).toBe("");
  expect(m.cursorAfterOffset(rows, "gone", 1)).toBe("a");
  expect(m.cursorAfterOffset(rows, "a", 0)).toBe("a");
});

test("removal moves the cursor below, else above", () => {
  expect(m.cursorAfterRemoval(rows, "b")).toBe("c");
  expect(m.cursorAfterRemoval(rows, "d")).toBe("c");
  expect(m.cursorAfterRemoval([{ id: "a" }], "a")).toBe("");
  expect(m.cursorAfterRemoval(rows, "gone")).toBe("");
  expect(m.cursorAfterRemovals(rows, ["b", "c"], "b")).toBe("d");
  expect(m.cursorAfterRemovals(rows, ["c", "d"], "c")).toBe("b");
  expect(m.cursorAfterReload(rows, "c")).toBe("c");
  expect(m.cursorAfterReload(rows, "gone")).toBe("a");
  expect(m.cursorAfterReload([], "a")).toBe("");
});

test("reveal scrolls only as far as the row needs", () => {
  expect(m.contentYToReveal(100, 300, 150, 60, 2000)).toBe(100);
  expect(m.contentYToReveal(100, 300, 50, 60, 2000)).toBe(50);
  expect(m.contentYToReveal(100, 300, 380, 60, 2000)).toBe(140);
  expect(m.contentYToReveal(0, 50, 200, 60, 2000)).toBe(200);
  expect(m.contentYToReveal(0, 300, 1990, 60, 2000)).toBe(1700);
});

test("shift-click applies the endpoint's next state to the range", () => {
  expect(m.idsBetween(rows, "", "c")).toEqual(["c"]);
  expect(m.idsBetween(rows, "zz", "yy")).toEqual([]);
  expect(m.toggleRange(["a"], rows, "b", "d")).toEqual(["a", "b", "c", "d"]);
  expect(m.toggleRange(["a", "b", "c", "d"], rows, "d", "b")).toEqual(["a"]);
  expect(m.toggleRange(["b", "d"], rows, "b", "d")).toEqual([]);
  expect(m.toggleRange(["a"], rows, "", "a")).toEqual([]);
  expect(m.toggleRange(["a"], rows, "a", "gone")).toEqual(["a"]);
  expect(m.toggleId(["a"], "b")).toEqual(["a", "b"]);
  expect(m.toggleId(["a", "b"], "a")).toEqual(["b"]);
  expect(m.retainIds(["a", "zz"], rows)).toEqual(["a"]);
  expect(m.checkAllToggle([], rows)).toEqual(["a", "b", "c", "d"]);
  expect(m.checkAllToggle(["a", "b", "c", "d"], rows)).toEqual([]);
  expect(m.reachedIds(["a", "b"], "b")).toEqual(["a", "b"]);
  expect(m.reachedIds(["a", "b"], "c")).toEqual(["c"]);
});

test("what survives an action in each view", () => {
  const survives = (key: string, action: string, raw = "", labels = false, source = "", r?: Summary) =>
    m.survivesAction(key, action, raw, labels, source, r);
  expect(survives("inbox", "archive")).toBe(false);
  expect(survives("all", "archive")).toBe(true);
  expect(survives("starred", "archive")).toBe(true);
  expect(survives("unread", "markRead")).toBe(false);
  expect(survives("inbox", "markRead")).toBe(true);
  expect(survives("starred", "unstar")).toBe(false);
  expect(survives("inbox", "trash")).toBe(false);
  expect(survives("trash", "trash")).toBe(true);
  expect(survives("trash", "untrash")).toBe(false);
  expect(survives("inbox", "label:Label_7")).toBe(false);
  expect(survives("all", "label:Label_7")).toBe(true);
  expect(survives("starred", "label:Label_7", "folder:Receipts")).toBe(false);
  expect(survives("archive", "unarchive")).toBe(false);
  expect(survives("all", "unarchive", "", true)).toBe(true);
  expect(survives("all", "unarchive", "label:important", true, "IMPORTANT")).toBe(true);
  expect(survives("all", "unarchive", "label:todo", true, "Label_17")).toBe(false);
  const conversation = (unread: boolean) =>
    row({ id: "r", thread: { id: "t", count: 2, unread, flagged: false, memberIds: ["r", "s"] } });
  expect(survives("unread", "markRead", "", false, "", conversation(true))).toBe(true);
  expect(survives("unread", "markRead", "", false, "", conversation(false))).toBe(false);
});

test("label changes per verb", () => {
  expect(m.labelChangesFor("archive")).toEqual({ add: [], remove: ["INBOX"] });
  expect(m.labelChangesFor("unarchive", "Label_3")).toEqual({ add: ["INBOX"], remove: ["Label_3"] });
  expect(m.labelChangesFor("unarchive", "IMPORTANT")).toEqual({ add: ["INBOX"], remove: [] });
  expect(m.labelChangesFor("label:L2", "L1")).toEqual({ add: ["L2"], remove: ["INBOX", "L1"] });
  expect(m.labelChangesFor("trash")).toBe(null);
});

test("conversation verbs reach every member", () => {
  const conv = row({ id: "r", thread: { id: "t", count: 3, unread: true, flagged: false, memberIds: ["r", "s", "u"] } });
  expect(m.actionTargets(conv, "archive")).toEqual(["r", "s", "u"]);
  expect(m.actionTargets(conv, "star")).toEqual(["r"]);
  expect(m.actionTargets(row({ id: "g" }), "archive")).toEqual(["g"]);
  expect(m.badgeCount(conv)).toBe(3);
  expect(m.badgeCount(row({ id: "g" }))).toBe(0);
});

test("the slot keys ask for the way back where it is done", () => {
  const trash = { mailboxKey: "trash", searchQuery: "", rawQuery: "" };
  const archive = { mailboxKey: "archive", searchQuery: "", rawQuery: "" };
  const inbox = { mailboxKey: "inbox", searchQuery: "", rawQuery: "" };
  const archived = row({ id: "a", inInbox: false });
  expect(m.keyActionFor("trash", [row({ id: "t" })], trash)).toBe("untrash");
  expect(m.keyActionFor("trash", [row({ id: "t", inTrash: true })], inbox)).toBe("untrash");
  expect(m.keyActionFor("trash", [row({ id: "t", inInbox: true })], inbox)).toBe("trash");
  expect(m.keyActionFor("archive", [archived], archive)).toBe("unarchive");
  expect(m.keyActionFor("archive", [archived], inbox)).toBe("archive");
  expect(m.keyActionFor("archive", [archived, row({ id: "b", inInbox: true })], archive)).toBe("archive");
  expect(m.starActionFor([row({ starred: true }), row({ starred: true })])).toBe("unstar");
  expect(m.starActionFor([row({ starred: true }), row({ starred: false })])).toBe("star");
  expect(m.starActionFor([])).toBe("star");
});

test("notes say what was done", () => {
  expect(m.batchNote(3, "Archived")).toBe("3 messages archived");
  expect(m.batchNote(1, "Moved to trash")).toBe("1 message moved to trash");
  expect(m.batchFailureNote(5, 2, "Moved to trash", "offline")).toBe("2 of 5 could not be moved to trash: offline");
  expect(m.markAllReadNote(3, true)).toBe("3 conversations marked read");
  expect(m.markAllReadNote(1, false)).toBe("1 message marked read");
  expect(m.actionLabel("label:L1", () => "Receipts")).toBe("Moved to Receipts");
  expect(m.actionName("unarchive", true)).toBe("Move to Inbox and remove label");
  expect(m.resultSummary([], 0, false)).toBe("No messages");
  expect(m.resultSummary([row({ id: "a" }), row({ id: "b" })], 2, true)).toBe("2 messages so far");
  expect(m.resultSummary([row({ id: "a" }), row({ id: "b" })], 40, true)).toBe("2 of about 40");
  expect(m.inverseAction("archive")).toBe("unarchive");
  expect(m.inverseAction("spam")).toBe("");
});

test("failed rows go back where they were", () => {
  const before = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const after = [{ id: "a" }, { id: "d" }];
  const ids = (list: { id: string }[]) => list.map((r) => r.id);
  expect(ids(m.restoreRows(after, before, ["c"]))).toEqual(["a", "c", "d"]);
  expect(ids(m.restoreRows(after, before, ["b", "c"]))).toEqual(["a", "b", "c", "d"]);
  expect(ids(m.restoreRows([{ id: "a" }], before, ["d"]))).toEqual(["a", "d"]);
  expect(ids(m.restoreRows(after, before, []))).toEqual(["a", "d"]);
});

test("reload depth follows the paging", () => {
  expect(m.reloadLimit(25, 0)).toBe(25);
  expect(m.reloadLimit(25, 50)).toBe(50);
  expect(m.reloadLimit(25, 63)).toBe(63);
  expect(m.reloadLimit(50, 150)).toBe(100);
  expect(m.reloadLimit(25, -5)).toBe(25);
  expect(m.reloadLimit(0, 40)).toBe(40);
  expect(m.showInitialListSkeleton(true, 0)).toBe(true);
  expect(m.showInitialListSkeleton(true, 3)).toBe(false);
});

test("arrivals are unread Inbox rows never seen, above the floor", () => {
  const inbox = [
    row({ id: "a", unread: true, inInbox: true }),
    row({ id: "b", unread: false, inInbox: true }),
    row({ id: "c", unread: true, inInbox: true }),
    row({ id: "d", unread: true, inInbox: false }),
  ];
  expect(m.newArrivals(inbox, {}, false, 0)).toEqual([]);
  expect(m.newArrivals(inbox, { a: true }, true, 0).map((r) => r.id)).toEqual(["c"]);
  const floor = Date.parse("2026-08-01T00:00:00Z");
  const timed = [
    row({ id: "old", unread: true, inInbox: true, date: new Date(floor - 1000000) }),
    row({ id: "new", unread: true, inInbox: true, date: new Date(floor + 1000) }),
    row({ id: "nodate", unread: true, inInbox: true, date: null }),
  ];
  expect(m.newArrivals(timed, {}, true, floor).map((r) => r.id)).toEqual(["new", "nodate"]);
  expect(m.newestDate(timed)).toBe(floor + 1000);
  expect(m.notificationBody(row({ subject: "Invoice", snippet: "Due Friday" }))).toBe("Invoice\nDue Friday");
  expect(m.notificationBody(row({ subject: "Invoice", snippet: "" }))).toBe("Invoice");
  expect(m.notificationTitle(row({}))).toBe("New message");
  const notice = m.arrivalNotice([row({ from: { display: "Ann" } }), row({ from: { display: "Bo" } })]);
  expect(notice).toEqual({ title: "2 new messages", body: "Ann, Bo" });
});

test("summaries compare by value, not identity", () => {
  const one = [row({ id: "a", date: new Date(5) })];
  const two = [row({ id: "a", date: new Date(5) })];
  expect(m.sameSummaries(one, two)).toBe(true);
  expect(m.sameSummaries(one, [row({ id: "a", date: new Date(6) })])).toBe(false);
});

test("relative times read like the Qt list", () => {
  const now = new Date(2026, 10, 27, 15, 0);
  expect(m.relativeTime(new Date(2026, 10, 27, 14, 59, 30), now)).toBe("now");
  expect(m.relativeTime(new Date(2026, 10, 27, 14, 55), now)).toBe("5m");
  expect(m.relativeTime(new Date(2026, 10, 27, 9, 5), now)).toBe("09:05");
  expect(m.relativeTime(new Date(2026, 10, 26, 9, 5), now)).toBe("Thu");
  expect(m.relativeTime(new Date(2026, 2, 4), now)).toBe("Mar 4");
  expect(m.relativeTime(new Date(2024, 2, 4), now)).toBe("Mar 4, 2024");
});

test("rows after an action read as the action left them", () => {
  const r = row({ id: "a", unread: true, labelIds: ["INBOX", "UNREAD"], inInbox: true });
  const read = m.rowAfterAction(r, "markRead");
  expect(read.unread).toBe(false);
  expect(read.labelIds).toEqual(["INBOX"]);
  expect(m.rowAfterAction(r, "archive").inInbox).toBe(false);
});
