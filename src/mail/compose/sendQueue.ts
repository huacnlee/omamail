// One mailbox's undo-send queue as the window renders it. Port of
// omarchy/ui/account/SendQueue.qml: rendering and callback correlation only.
// The backend owns undo deadlines, serial delivery, cancellation and durable
// recovery after a restart; nothing here sends.
import { batch, signal } from "nsh";

export type OutboxState = "queued" | "sending" | "sent" | "failed" | "unknown" | "cancelled";

export interface OutboxEntry {
  id: string;
  state: OutboxState;
  draftId?: string;
  result?: { draftRemoved?: boolean; warning?: string };
  order?: number;
  queuedAt?: number;
  dueAt?: number;
}

export interface OutboxSnapshot {
  accountId: string;
  revision: number;
  entries: OutboxEntry[];
}

/** What the queue reports back to its mailbox. */
export interface SendQueueHost {
  accountId: string;
  /** The provider id the outbox delivers with (`imap`, `gmail`, `outlook`...). */
  provider: () => string;
  /** Seconds a send waits for an undo (Outbox.normalizeDelay). */
  delaySeconds: () => number;
  /** A JSON-RPC call with the account named; rejects with `{ code, message }`. */
  request: (method: string, params: Record<string, unknown>) => Promise<any>;
  sent: (id: string, entry: OutboxEntry) => void;
  failed: (id: string, message: string) => void;
  note: (message: string) => void;
  /** The send left with its draft gone from the provider. */
  draftRemoved?: (draftId: string) => void;
  /** The draft is still there: the Drafts list should be read again. */
  draftKept?: () => void;
  /** Late work (a timer) after the queue was retired must not report. */
  now?: () => number;
}

export const FAILED = "The message could not be sent. Your draft has been kept.";
export const UNKNOWN = "Delivery status is unknown. Check Sent before trying again.";
export const NOT_QUEUED = "The message was not queued. Your draft has been kept.";
export const ABANDONED = "Queued send cancelled. Your draft has been kept.";

function message(error: unknown): string {
  return error && typeof error === "object" && "message" in error ? String((error as any).message) : String(error || "");
}

export class SendQueue {
  readonly host: SendQueueHost;
  /** Sends still in their undo window, oldest first (reactive). */
  readonly parked = signal<OutboxEntry[]>([]);
  /** Seconds until the newest parked send goes (reactive). */
  readonly secondsRemaining = signal(0);
  /** A send is on the wire. */
  readonly sending = signal(false);
  /** Last known state per send id (reactive). */
  readonly deliveryStates = signal<Record<string, OutboxState>>({});
  readonly undoBusy = signal(false);

  private revision = -1;
  private submitted: Record<string, OutboxEntry> = {};
  private handled: Record<string, OutboxState> = {};
  private uncertain: Record<string, true> = {};
  private serverEntries: OutboxEntry[] = [];
  private undoPending: { id: string; callback?: (id: string) => void } | null = null;
  private timer: number | null = null;
  private retired = false;

  constructor(host: SendQueueHost) {
    this.host = host;
  }

  private now(): number {
    return this.host.now ? this.host.now() : Date.now();
  }

  latest(): OutboxEntry | null {
    const list = this.parked();
    return list.length > 0 ? list[list.length - 1] : null;
  }

  retire() {
    this.retired = true;
    this.stopTimer();
  }

  private async request(method: string, params: Record<string, unknown>): Promise<any> {
    const answer = await this.host.request(method, { ...params, accountId: this.host.accountId });
    if (this.retired) throw new Error("retired");
    return answer;
  }

  private remember(entries: OutboxEntry[]) {
    const states = { ...this.deliveryStates() };
    for (const entry of entries) states[String(entry.id)] = entry.state;
    this.deliveryStates.set(states);
  }

  /** A snapshot from the backend (`outbox.changed` or an answer). */
  apply(snapshot: OutboxSnapshot | null | undefined, partial = false) {
    if (this.retired || !snapshot || String(snapshot.accountId || "") !== this.host.accountId) return;
    if (Number(snapshot.revision) < this.revision) return;
    this.revision = Number(snapshot.revision);
    let entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
    const receipts: string[] = [];
    batch(() => {
      this.remember(entries);
      if (partial) {
        const merged = this.serverEntries.slice();
        for (const entry of entries) {
          const at = merged.findIndex((m) => m.id === entry.id);
          if (at < 0) merged.push(entry);
          else merged[at] = entry;
        }
        entries = merged;
      }
      this.serverEntries = entries;
      const waiting: OutboxEntry[] = [];
      let busy = false;
      const remaining = { ...this.submitted };
      for (const entry of entries) {
        const id = String(entry.id || "");
        delete remaining[id];
        if (entry.state === "queued") waiting.push(entry);
        if (entry.state === "sending") busy = true;
        if (this.handled[id] === entry.state) continue;
        if (entry.state === "sent") {
          this.handled[id] = entry.state;
          receipts.push(id);
          this.host.sent(id, entry);
          const draft = String(entry.draftId || "");
          if (draft !== "" && entry.result && entry.result.draftRemoved) this.host.draftRemoved?.(draft);
          // HEY keeps a sent draft, and the others do when removing it failed.
          else if (draft !== "") this.host.draftKept?.();
        } else if (entry.state === "failed" || entry.state === "unknown") {
          this.handled[id] = entry.state;
          this.host.failed(id, entry.state === "unknown" ? UNKNOWN : FAILED);
        }
      }
      for (const key of Object.keys(remaining)) waiting.push(remaining[key]);
      waiting.sort((a, b) => Number(a.order) - Number(b.order) || Number(a.queuedAt) - Number(b.queuedAt));
      this.submitted = remaining;
      this.parked.set(waiting);
      this.sending.set(busy);
      this.arm();
    });
    for (const id of receipts) {
      queueMicrotask(() => {
        this.request("outbox.forget", { sendId: id })
          .then((result) => this.apply(result?.snapshot))
          .catch(() => {});
      });
    }
  }

  /** Parks a composed payload for its undo window. The editor parks its draft at once; refusal comes later. */
  park(payload: Record<string, unknown>, id: string, order: number): boolean {
    const sendId = String(id || "");
    const now = this.now();
    const delay = this.host.delaySeconds();
    const entry: OutboxEntry = { id: sendId, queuedAt: now, dueAt: now + delay * 1000, order: Number(order) || 0, state: "queued" };
    this.submitted = { ...this.submitted, [sendId]: entry };
    this.parked.set([...this.parked(), entry]);
    this.arm();
    this.request("outbox.enqueue", {
      provider: this.host.provider(),
      payload,
      sendId,
      order: Math.max(0, Math.floor(Number(order) || 0)),
      delaySeconds: delay,
    }).then(
      (result) => {
        const remaining = { ...this.submitted };
        delete remaining[sendId];
        this.submitted = remaining;
        this.apply(result?.snapshot);
        this.host.note("Message queued");
      },
      () => {
        if (this.retired || this.handled[sendId] === "sent") return;
        this.uncertain[sendId] = true;
        this.host.note("Checking whether the message was queued");
        this.reconcile(sendId);
      },
    );
    return true;
  }

  /** Asks whether an enqueue the transport lost an answer to landed. */
  reconcile(id: string) {
    this.request("outbox.snapshot", { sendId: id }).then(
      (result) => {
        if (!result || !Array.isArray(result.entries) || String(result.accountId || "") !== this.host.accountId) return;
        delete this.uncertain[id];
        if (result.entries.length > 0) {
          this.apply(result, true);
          return;
        }
        const remaining = { ...this.submitted };
        delete remaining[id];
        this.submitted = remaining;
        this.parked.set(this.parked().filter((entry) => entry.id !== id));
        this.remember([{ id, state: "failed" }]);
        this.arm();
        this.host.failed(id, NOT_QUEUED);
      },
      () => {},
    );
  }

  /** On connect: the whole snapshot, every uncertain enqueue, any undo in doubt. */
  sync() {
    this.revision = -1;
    this.request("outbox.snapshot", {}).then((r) => this.apply(r), () => {});
    for (const id of Object.keys(this.uncertain)) this.reconcile(id);
    if (this.undoPending) this.reconcileUndo();
  }

  arm() {
    const latest = this.latest();
    this.secondsRemaining.set(latest ? Math.max(0, Math.ceil((Number(latest.dueAt) - this.now()) / 1000)) : 0);
    if (this.parked().length > 0) this.startTimer();
    else this.stopTimer();
  }

  private startTimer() {
    if (this.timer !== null || this.retired) return;
    this.timer = setInterval(() => this.arm(), 250);
  }

  private stopTimer() {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Sends everything parked now. */
  flush(): boolean {
    if (this.parked().length === 0) return false;
    this.request("outbox.flush", {}).then(
      (result) => this.apply(result?.snapshot),
      () => this.host.note("Queued messages could not be released"),
    );
    return true;
  }

  private finishUndo(id: string) {
    const pending = this.undoPending;
    this.undoPending = null;
    this.undoBusy.set(false);
    if (id) this.host.draftKept?.();
    pending?.callback?.(id);
  }

  private reconcileUndo() {
    const pending = this.undoPending;
    if (!pending) return;
    const id = pending.id;
    this.request("outbox.snapshot", { sendId: id }).then(
      (result) => {
        if (!result || !Array.isArray(result.entries) || !this.undoPending || this.undoPending.id !== id) return;
        if (result.entries.length > 0) this.apply(result, true);
        const cancelled = result.entries.length > 0 && result.entries[0].state === "cancelled";
        this.host.note(cancelled ? "Send undone" : "That message could not be undone");
        this.finishUndo(cancelled ? id : "");
      },
      () => {},
    );
  }

  undoLatest(callback?: (id: string) => void): boolean {
    const latest = this.latest();
    if (this.undoBusy() || !latest) return false;
    return this.undo(String(latest.id), callback);
  }

  /** Cancels a parked send; `callback` hears the id undone, or "" when it went anyway. */
  undo(id: string, callback?: (id: string) => void): boolean {
    if (this.undoBusy() || !this.parked().some((entry) => String(entry.id) === id)) return false;
    this.undoBusy.set(true);
    this.undoPending = { id, callback };
    this.request("outbox.undo", { sendId: id }).then(
      (result) => {
        this.apply(result?.snapshot);
        this.host.note("Send undone");
        this.finishUndo(String(result?.id || ""));
      },
      () => {
        this.host.note("Checking whether the send was undone");
        this.reconcileUndo();
      },
    );
    return true;
  }

  /** Sign-out: cancel what is parked and hand each draft back. */
  abandon() {
    const ids = this.parked().map((entry) => String(entry.id));
    this.request("outbox.abandon", {}).then(
      (result) => {
        this.apply(result?.snapshot);
        const entries: OutboxEntry[] = result?.snapshot?.entries ?? [];
        for (const id of ids) {
          if (entries.some((e) => e.id === id && e.state === "cancelled")) this.host.failed(id, ABANDONED);
        }
      },
      (error) => this.host.note(message(error) || "Queued sends could not be cancelled"),
    );
  }
}
