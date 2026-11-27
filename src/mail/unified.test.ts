// Port of omarchy/ui/tests/test_unified.js.
import { expect, test } from "nsh/test";
import * as u from "./unified";
import type { Summary } from "./listModel";

const SEP = "\u001f";
const row = (fields: Record<string, unknown>) => fields as unknown as Summary;

test("row ids compose account and id with a control character", () => {
  expect(u.unifiedId("me@example.org", "42")).toBe("me@example.org" + SEP + "42");
  expect(u.unifiedId("", "42")).toBe("");
  expect(u.splitUnifiedId("me@example.org" + SEP + "42")).toEqual({ accountId: "me@example.org", id: "42" });
  expect(u.splitUnifiedId("42")).toEqual({ accountId: "", id: "" });
  expect(u.splitUnifiedId("42:Sent Items")).toEqual({ accountId: "", id: "" });
  expect(u.splitUnifiedId(u.unifiedId("me@fastmail.com", "42:Sent Items")))
    .toEqual({ accountId: "me@fastmail.com", id: "42:Sent Items" });
  expect(u.notifiedId(true, "me@example.org", "42")).toBe("me@example.org" + SEP + "42");
  expect(u.notifiedId(false, "me@example.org", "42")).toBe("42");
  expect(u.notifiedId(true, "a@b.com", "a@b.com" + SEP + "42")).toBe("a@b.com" + SEP + "42");
  expect(u.accountOf("42")).toBe("");
});

test("a selection is one batch per mailbox", () => {
  expect(u.groupByAccount([
    u.unifiedId("a@example.org", "1"),
    u.unifiedId("b@example.net", "7:INBOX"),
    "42",
    u.unifiedId("a@example.org", "2"),
  ])).toEqual([
    { accountId: "a@example.org", ids: ["1", "2"] },
    { accountId: "b@example.net", ids: ["7:INBOX"] },
  ]);
  expect(u.groupByAccount(null)).toEqual([]);
});

test("merging is newest first, copied and addressed", () => {
  const sources = [
    { id: "a@example.org", label: "Personal", messages: [row({ id: "1", date: 3000, subject: "newest" }), row({ id: "2", date: 1000, subject: "oldest" })] },
    { id: "b@example.net", label: "Work", messages: [row({ id: "1", date: 2000, subject: "middle" })] },
  ];
  const merged = u.mergeMessages(sources);
  expect(merged.map((r) => r.subject)).toEqual(["newest", "middle", "oldest"]);
  expect(merged.map((r) => r.sourceId)).toEqual(["1", "1", "2"]);
  expect(merged[1].sourceLabel).toBe("Work");
  (sources[0].messages[0] as Summary).subject = "changed";
  expect(merged[0].subject).toBe("newest");
  expect(u.mergeMessages([{ id: "", messages: [row({ id: "1" })] }])).toEqual([]);
  expect(u.mergeMessages([{ id: "a", messages: [row({ id: "1", date: 1 }), row({ id: "1", date: 1 })] }]).length).toBe(1);
});

test("the merge stops at the shallowest watermark", () => {
  const merged = u.mergeMessages([
    { id: "a", hasMore: true, messages: [row({ id: "1", date: 5000 }), row({ id: "2", date: 4000 })] },
    { id: "b", hasMore: true, messages: [row({ id: "1", date: 4500 }), row({ id: "2", date: 1000 })] },
  ]);
  expect(merged.map((r) => r.sourceId)).toEqual(["1", "1", "2"]);
  const done = u.mergeMessages([
    { id: "a", hasMore: false, messages: [row({ id: "1", date: 5000 })] },
    { id: "b", hasMore: false, messages: [row({ id: "1", date: 10 })] },
  ]);
  expect(done.length).toBe(2);
});

test("conversation members are composed like the row", () => {
  const merged = u.mergeMessages([{ id: "a", messages: [row({ id: "1", date: 1, thread: { id: "t", count: 2, unread: false, flagged: false, memberIds: ["1", "2"] } })] }]);
  expect(merged[0].thread?.memberIds).toEqual([u.unifiedId("a", "1"), u.unifiedId("a", "2")]);
  expect(u.rowIsConversation(merged[0])).toBe(true);
});

test("all-of-them answers", () => {
  expect(u.allLoaded([])).toBe(false);
  expect(u.allLoaded([{ loaded: true }, { loading: false, error: "signed out" }])).toBe(true);
  expect(u.allLoaded([{ loaded: true }, { loading: true, error: "x" }])).toBe(false);
  expect(u.firstError([{ label: "Fastmail", error: "refused" }])).toBe("Fastmail: refused");
  expect(u.anyHasMore([{ hasMore: false }, { hasMore: true }])).toBe(true);
  expect(u.totalUnread([{ unread: 2 }, { unread: -1 }, { unread: 3 }])).toBe(5);
  expect(u.everyMailboxCan([{ archive: true }, { archive: false }], "archive")).toBe(false);
});
