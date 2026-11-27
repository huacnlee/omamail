// A session-only queue of follow-ups bound to one conversation. Requests
// leave the queue only after their new turn appears, so a failed start
// cannot lose a message. Port of ui/agent/PendingMessages.qml as a plain
// state machine: the dock owns one, reads it through `version`, and calls
// `advance` on its timer.
import { signal } from "nsh";
import { isActive, pendingJob, pendingLimit, type AgentJob, type DraftFields } from "./agent";

export interface PendingDeps {
  /** Every job the runner lists. */
  jobs(): AgentJob[];
  starting(): boolean;
  error(): string;
  /** Starts a follow-up of `jobId`; false when it was refused. */
  answer(jobId: string, text: string, fields: DraftFields | null): boolean;
  /** The draft editor's fields now, for a draft chat that is open here. */
  draftFields(): DraftFields | null;
}

export class PendingQueue {
  private readonly tick = signal(0);
  scope = "";
  conversationId = "";
  previousId = "";
  waitingForTurn = false;
  dispatching = false;
  paused = false;
  error = "";
  messages: string[] = [];
  /** Where the dock is and which job it shows: set by the dock. */
  currentScope = "";
  currentJob: AgentJob | null = null;

  constructor(private readonly deps: PendingDeps) {}

  /** Reads this in a binding to follow the queue. */
  version(): number {
    return this.tick();
  }
  private changed() {
    this.tick.set(this.tick() + 1);
  }

  get busy(): boolean {
    return this.messages.length > 0;
  }
  get scopeMatches(): boolean {
    return this.scope === this.currentScope;
  }
  get visibleHere(): boolean {
    return this.scopeMatches && (this.conversationId === "" || (!!this.currentJob && String(this.currentJob.conversationId || this.currentJob.id) === this.conversationId));
  }

  add(text: string, awaitingTurn: boolean): boolean {
    const job = this.currentJob;
    if (this.busy && (!this.visibleHere || (this.conversationId !== "" && job && String(job.conversationId || job.id) !== this.conversationId))) {
      this.error = "Finish or remove the pending messages in the previous chat first.";
      this.changed();
      return false;
    }
    const limit = pendingLimit(this.messages, text);
    if (limit !== "") {
      this.error = limit;
      this.changed();
      return false;
    }
    if (!this.busy) {
      this.scope = this.currentScope;
      this.conversationId = job ? String(job.conversationId || job.id) : "";
      this.previousId = job ? String(job.id) : "";
      this.waitingForTurn = awaitingTurn;
      this.paused = false;
      this.dispatching = false;
    }
    this.messages = this.messages.concat([text]);
    this.error = "";
    this.changed();
    return true;
  }

  /** Takes a message back out (to edit it); "" when it is being sent. */
  remove(index: number): string {
    if (this.dispatching && index === 0) return "";
    if (index < 0 || index >= this.messages.length) return "";
    const text = this.messages[index];
    const next = this.messages.slice();
    next.splice(index, 1);
    this.messages = next;
    this.changed();
    return text;
  }

  pause() {
    this.paused = true;
    this.changed();
  }

  /** Forgets everything: a new AI selection starts fresh chats. */
  clear() {
    this.messages = [];
    this.paused = true;
    this.dispatching = false;
    this.waitingForTurn = false;
    this.error = "";
    this.changed();
  }

  private latest(): AgentJob | null {
    return pendingJob(this.deps.jobs(), this.currentJob, this.scopeMatches, this.conversationId, this.previousId);
  }

  advance() {
    if (!this.busy) return;
    const before = JSON.stringify([this.messages, this.paused, this.dispatching, this.waitingForTurn, this.error, this.conversationId]);
    this.step();
    if (JSON.stringify([this.messages, this.paused, this.dispatching, this.waitingForTurn, this.error, this.conversationId]) !== before) this.changed();
  }

  private step() {
    const job = this.latest();
    if (this.waitingForTurn || this.dispatching) {
      if (!job || String(job.id) === this.previousId) {
        if (!this.deps.starting() && this.deps.error()) {
          this.paused = true;
          this.error = this.deps.error();
          this.dispatching = false;
        }
        return;
      }
      this.conversationId = String(job.conversationId || job.id);
      if (this.dispatching) this.messages = this.messages.slice(1);
      this.waitingForTurn = false;
      this.dispatching = false;
      if (!this.busy) return;
    }
    if (this.paused || !job || this.deps.starting() || isActive(job)) return;
    // A queued draft request needs the editor's latest state, not a snapshot
    // from when it was queued or a different editor after navigation.
    if (this.scope.indexOf('["draft",') === 0 && !this.scopeMatches) return;
    if (!job.canContinue) {
      this.paused = true;
      this.error = "Queue paused. Edit or remove pending messages to start again.";
      return;
    }
    if (!this.deps.answer(String(job.id), this.messages[0], this.scopeMatches ? this.deps.draftFields() : null)) {
      this.paused = true;
      this.error = this.deps.error() || "Could not send the pending message.";
      return;
    }
    this.previousId = String(job.id);
    this.dispatching = true;
  }
}
