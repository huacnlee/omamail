import { expect, test } from "nsh/test";
import * as b from "./batch";
import { unifiedId } from "./unified";

test("a reply names only its own failures", () => {
  expect(b.localFailures(["1", "2"], ["2", "2", "9"])).toEqual(["2"]);
  expect(b.localFailures(["1", "2"], null)).toEqual(["1", "2"]);
  expect(b.localFailures(["1"], [])).toEqual([]);
});

test("a selection across mailboxes ends with one status line", () => {
  const outcome = b.unifiedBatchOutcome("Archived", [
    { accountId: "a", ids: ["1", "2", "3"], failedIds: [] },
    { accountId: "b", ids: ["7", "8"], failedIds: ["8"] },
  ]);
  expect(outcome.status).toBe("Archived: 4 of 5 selected across 2 mailboxes. a: 3 completed, 0 failed; b: 1 completed, 1 failed");
  expect(outcome.failed).toEqual([unifiedId("b", "8")]);
  expect(outcome.total).toBe(5);
});

test("rolled-back checks return once their rows are back", () => {
  const present = (id: string) => id !== "late";
  expect(b.restoreChecks(["a"], ["b", "late", "a"], present)).toEqual({ checked: ["a", "b"], waiting: ["late"] });
});
