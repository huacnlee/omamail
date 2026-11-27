// Durable editor recovery: what reaches `compose.recoverySave`, and how a
// recovered record is reconciled with the outbox's delivery receipts before
// it reopens. Port of compose/RecoveryController.qml's pure parts.
//
// A transport failure cannot turn a potentially sent message into a retry:
// a draft parked for a send whose state is still queued or sending stays
// parked, a sent one is dropped, and an unknown one reopens with a warning.
import type { ComposeDraft } from "./draft";

export type ReturnView = "list" | "reader" | "calendar";

export interface RecoveryRecord {
  version: 1;
  active: boolean;
  returnView?: ReturnView;
  draft?: ComposeDraft | null;
  parked?: ComposeDraft[];
}

export const INACTIVE = '{"version":1,"active":false}';

/** Recovery needs API 3, which keeps explicit edit history. */
export const MIN_API_VERSION = 3;

/** Refusals a write provably never survived: retry on the same revision. */
export const UNSENT_REFUSALS = [-32000, -32011];
/** Six attempts, doubling from one second to 32. */
export const MAX_RETRIES = 6;

export function retryDelay(attempt: number): number {
  return 1000 * Math.pow(2, Math.max(0, attempt - 1));
}

export function record(returnView: ReturnView, draft: ComposeDraft, parked: ComposeDraft[]): RecoveryRecord {
  return { version: 1, active: true, returnView, draft, parked };
}

export type DeliveryState = "queued" | "sending" | "sent" | "failed" | "unknown" | "cancelled" | "missing";

export function stateKey(accountId: string, sendId: string): string {
  return accountId + "\n" + sendId;
}

/** The drafts of a record that name a send whose fate must be asked first. */
export function pendingDrafts(rec: RecoveryRecord | null | undefined): ComposeDraft[] {
  return draftsOf(rec).filter((d) => String(d.pendingSendId || "") !== "");
}

export function draftsOf(rec: RecoveryRecord | null | undefined): ComposeDraft[] {
  if (!rec || rec.active !== true || !rec.draft) return [];
  return [rec.draft, ...(rec.parked ?? [])];
}

export interface Reconciled {
  /** Drafts to reopen in the editor, the first one first. */
  restored: ComposeDraft[];
  /** Drafts still parked for a send that may yet go. */
  waiting: ComposeDraft[];
  /** Terminal sends to acknowledge (`outbox.forget`) once the record lands. */
  receipts: { accountId: string; sendId: string }[];
}

export function reconcile(drafts: ComposeDraft[], states: Record<string, DeliveryState>): Reconciled {
  const restored: ComposeDraft[] = [];
  const waiting: ComposeDraft[] = [];
  const receipts: { accountId: string; sendId: string }[] = [];
  for (const draft of drafts) {
    const id = String(draft.pendingSendId || "");
    if (id === "") {
      restored.push(draft);
      continue;
    }
    const state = states[stateKey(String(draft.accountId), id)] ?? "missing";
    if (state === "queued" || state === "sending") {
      waiting.push(draft);
      continue;
    }
    if (state !== "unknown" && state !== "missing") receipts.push({ accountId: String(draft.accountId), sendId: id });
    if (state === "sent") continue;
    const recovered: ComposeDraft = { ...draft };
    delete recovered.pendingSendId;
    recovered.deliveryUnknown = state === "unknown";
    restored.push(recovered);
  }
  return { restored, waiting, receipts };
}

/** The record after reconciling: restored first, then those still parked. */
export function afterReconcile(returnView: ReturnView | undefined, result: Reconciled): RecoveryRecord | null {
  const all = [...result.restored, ...result.waiting];
  if (all.length === 0) return null;
  return { version: 1, active: true, returnView: returnView ?? "list", draft: all[0], parked: all.slice(1) };
}
