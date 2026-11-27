import { expect, test } from "nsh/test";
import { emptyDraft } from "./draft";
import * as Recovery from "./recovery";

const draft = (id: string, sendId = "") => ({ ...emptyDraft(id), accountId: "acc", subject: id, ...(sendId ? { pendingSendId: sendId } : {}) });

test("receipts decide what reopens after a restart", () => {
  const drafts = [draft("plain"), draft("q", "s1"), draft("sent", "s2"), draft("fail", "s3"), draft("unk", "s4"), draft("gone", "s5"), draft("cx", "s6")];
  const states: Record<string, Recovery.DeliveryState> = {
    [Recovery.stateKey("acc", "s1")]: "queued",
    [Recovery.stateKey("acc", "s2")]: "sent",
    [Recovery.stateKey("acc", "s3")]: "failed",
    [Recovery.stateKey("acc", "s4")]: "unknown",
    [Recovery.stateKey("acc", "s5")]: "missing",
    [Recovery.stateKey("acc", "s6")]: "cancelled",
  };
  const result = Recovery.reconcile(drafts, states);
  expect(result.restored.map((d) => d.subject)).toEqual(["plain", "fail", "unk", "gone", "cx"]);
  expect(result.waiting.map((d) => d.subject)).toEqual(["q"]);
  expect(result.receipts.map((r) => r.sendId)).toEqual(["s2", "s3", "s6"]);
  expect(result.restored.every((d) => d.pendingSendId === undefined)).toBe(true);
  expect(result.restored.find((d) => d.subject === "unk")?.deliveryUnknown).toBe(true);
  expect(result.restored.find((d) => d.subject === "fail")?.deliveryUnknown).toBe(false);
  const rec = Recovery.afterReconcile("reader", result);
  expect(rec?.draft?.subject).toBe("plain");
  expect(rec?.parked?.length).toBe(5);
  expect(Recovery.afterReconcile("list", { restored: [], waiting: [], receipts: [] })).toBe(null);
});

test("a record lists its drafts; an inactive one none", () => {
  expect(Recovery.draftsOf({ version: 1, active: false })).toEqual([]);
  const rec = Recovery.record("list", draft("a", "s"), [draft("b")]);
  expect(Recovery.pendingDrafts(rec).map((d) => d.subject)).toEqual(["a"]);
});

test("save retries double from one second", () => {
  expect([1, 2, 3, 6].map(Recovery.retryDelay)).toEqual([1000, 2000, 4000, 32000]);
});
