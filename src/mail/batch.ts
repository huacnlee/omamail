// Batch actions over checked rows. Port of omarchy/ui/account/BatchAction.qml,
// UnifiedBatchAction.qml and UnifiedBatchSelection.qml as pure rules: the
// failures a reply may name (only its own request's ids), the one status line
// a selection across mailboxes ends with, and which checks to put back after a
// rollback once their rows have reappeared. Tested in batch.test.ts.
import { unifiedId } from "./unified";

export interface GroupResult {
  accountId: string;
  /** The ids the request was sent for, in the account's own terms. */
  ids: string[];
  /** The ids the reply said failed; `null` when the whole request failed. */
  failedIds: string[] | null;
  /** Every id the request reached (conversation members expanded): the cache drops pages holding them. */
  targets?: string[];
}

/** The failures a reply may claim: its own ids, once each. */
export function localFailures(asked: readonly string[], reported: readonly string[] | null): string[] {
  const list = reported === null ? asked : reported;
  const out: string[] = [];
  for (const id of Array.isArray(list) ? list : []) {
    if (asked.includes(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** "Archived: 4 of 5 selected across 2 mailboxes. a: 3 completed, 0 failed;
 * b: 1 completed, 1 failed", and the failed ids composed for the merged list. */
export function unifiedBatchOutcome(label: string, groups: readonly GroupResult[],
  nameOf: (accountId: string) => string = (id) => id): { status: string; failed: string[]; total: number } {
  let total = 0;
  const failed: string[] = [];
  const notes: string[] = [];
  for (const group of groups) {
    total += group.ids.length;
    const local = localFailures(group.ids, group.failedIds);
    for (const id of local) failed.push(unifiedId(group.accountId, id));
    notes.push(nameOf(group.accountId) + ": " + Math.max(0, group.ids.length - local.length)
      + " completed, " + local.length + " failed");
  }
  const status = (label || "Done") + ": " + (total - failed.length) + " of " + total
    + " selected across " + groups.length + " mailboxes. " + notes.join("; ");
  return { status, failed, total };
}

/** The checks a rollback puts back now (rows present again), and those still
 * waiting for their rows to reappear. */
export function restoreChecks(checked: readonly string[], pending: readonly string[], present: (id: string) => boolean):
  { checked: string[]; waiting: string[] } {
  const next = Array.isArray(checked) ? checked.slice() : [];
  const waiting: string[] = [];
  for (const id of Array.isArray(pending) ? pending : []) {
    if (!present(id)) waiting.push(id);
    else if (!next.includes(id)) next.push(id);
  }
  return { checked: next, waiting };
}
