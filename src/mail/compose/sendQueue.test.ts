import { expect, test } from "nsh/test";
import { FAILED, NOT_QUEUED, SendQueue, UNKNOWN, type SendQueueHost } from "./sendQueue";

function harness(answers: Record<string, (params: any) => any>) {
  const calls: { method: string; params: any }[] = [];
  const events: string[] = [];
  let clock = 1000;
  const host: SendQueueHost = {
    accountId: "acc",
    provider: () => "imap",
    delaySeconds: () => 10,
    now: () => clock,
    request: async (method, params) => {
      calls.push({ method, params });
      const answer = answers[method];
      if (!answer) throw { code: -32010, message: "unavailable" };
      return answer(params);
    },
    sent: (id) => events.push("sent:" + id),
    failed: (id, message) => events.push("failed:" + id + ":" + message),
    note: (message) => events.push("note:" + message),
    draftRemoved: (id) => events.push("removed:" + id),
    draftKept: () => events.push("kept"),
  };
  return { queue: new SendQueue(host), calls, events, tick: (ms: number) => (clock += ms) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("park enqueues with the account, provider and delay, and counts down", async () => {
  const h = harness({
    "outbox.enqueue": (p) => ({ snapshot: { accountId: "acc", revision: 1, entries: [{ id: p.sendId, state: "queued", order: 1, queuedAt: 1000, dueAt: 11000 }] } }),
  });
  h.queue.park({ raw: "x" }, "send-1", 1);
  expect(h.queue.parked().length).toBe(1);
  expect(h.queue.secondsRemaining()).toBe(10);
  await flush();
  expect(h.calls[0]).toEqual({
    method: "outbox.enqueue",
    params: { provider: "imap", payload: { raw: "x" }, sendId: "send-1", order: 1, delaySeconds: 10, accountId: "acc" },
  });
  expect(h.events).toContain("note:Message queued");
  h.tick(4500);
  h.queue.arm();
  expect(h.queue.secondsRemaining()).toBe(6);
  h.queue.retire();
});

test("a sent entry reports once and is forgotten; failures keep the draft", async () => {
  const h = harness({ "outbox.forget": () => ({ snapshot: { accountId: "acc", revision: 3, entries: [] } }) });
  h.queue.apply({ accountId: "acc", revision: 2, entries: [
    { id: "a", state: "sent", draftId: "d", result: { draftRemoved: true } },
    { id: "b", state: "failed" },
    { id: "c", state: "unknown" },
  ] });
  h.queue.apply({ accountId: "acc", revision: 2, entries: [{ id: "a", state: "sent" }] });
  await flush();
  await flush();
  expect(h.events.filter((e) => e === "sent:a").length).toBe(1);
  expect(h.events).toContain("removed:d");
  expect(h.events).toContain("failed:b:" + FAILED);
  expect(h.events).toContain("failed:c:" + UNKNOWN);
  expect(h.calls.some((c) => c.method === "outbox.forget" && c.params.sendId === "a")).toBe(true);
  // Another account's snapshot and an older revision are ignored.
  h.queue.apply({ accountId: "other", revision: 9, entries: [{ id: "z", state: "failed" }] });
  h.queue.apply({ accountId: "acc", revision: 1, entries: [{ id: "y", state: "failed" }] });
  expect(h.events.some((e) => e.startsWith("failed:z") || e.startsWith("failed:y"))).toBe(false);
  h.queue.retire();
});

test("an enqueue the transport lost is reconciled before it is called failed", async () => {
  const h = harness({ "outbox.snapshot": () => ({ accountId: "acc", revision: 1, entries: [] }) });
  h.queue.park({ raw: "x" }, "send-2", 1);
  await flush();
  await flush();
  await flush();
  expect(h.events).toContain("note:Checking whether the message was queued");
  expect(h.events).toContain("failed:send-2:" + NOT_QUEUED);
  expect(h.queue.parked().length).toBe(0);
  h.queue.retire();
});

test("undo cancels the newest send and hands back its id", async () => {
  let undone = "";
  const h = harness({
    "outbox.enqueue": (p) => ({ snapshot: { accountId: "acc", revision: 1, entries: [{ id: p.sendId, state: "queued", order: p.order }] } }),
    "outbox.undo": (p) => ({ id: p.sendId, snapshot: { accountId: "acc", revision: 2, entries: [{ id: p.sendId, state: "cancelled" }] } }),
  });
  h.queue.park({}, "s1", 1);
  h.queue.park({}, "s2", 2);
  await flush();
  expect(h.queue.undoLatest((id) => (undone = id))).toBe(true);
  await flush();
  expect(undone).toBe("s2");
  expect(h.events).toContain("note:Send undone");
  h.queue.retire();
});
