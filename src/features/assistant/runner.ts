// Presentation state for the native background jobs. Port of
// ui/agent/AgentRunner.qml. Rust owns process lifetime, deadlines, persisted
// output, job validation and the projections (`agent.jobsProjection`); this
// owns the open result, paging and which jobs the owner has seen.
import { batch, signal } from "nsh";
import { provider, startOptions, type AgentJob, type ChatEntry, type EventLooks, type Proposal, type StartPayload } from "../../mail/agent";

export type Caller = (method: string, params: object) => Promise<any>;

export interface Selection {
  agent: string;
  model: string;
  revision: number;
}

interface Scope {
  job?: AgentJob | null;
  history?: AgentJob[];
  jobs?: AgentJob[];
}

const CHECKING = "Checking the selected AI agent...";

function codeOf(error: unknown): string {
  return error && typeof (error as any).message === "string" ? String((error as any).message) : String(error ?? "");
}

export class AgentRunner {
  // Settings the dock binds in.
  readonly selectedAgent = signal("System default");
  readonly selectedModel = signal("");
  readonly selectionResetAt = signal(0);
  readonly apiVersion = signal(0);
  readonly ready = signal(false);

  readonly providerAvailable = signal(false);
  readonly resolvedProvider = signal("");
  readonly availabilityError = signal(CHECKING);
  readonly selectionRevision = signal(0);
  private selectionJobs: Record<string, number> = {};
  private availabilitySerial = 0;

  readonly accountId = signal("");
  readonly jobs = signal<AgentJob[]>([]);
  readonly byMessage = signal<Record<string, AgentJob>>({});
  readonly byAccount = signal<Record<string, Record<string, AgentJob>>>({});
  readonly scopesByAccount = signal<Record<string, Record<string, Scope>>>({});
  readonly attentionIds = signal<string[]>([]);
  readonly anyActive = signal(false);
  readonly activeIds = signal<string[]>([]);
  readonly finishedIds = signal<string[]>([]);
  readonly attention = signal(false);
  readonly attentionByMessage = signal<Record<string, boolean>>({});
  readonly eventLooks = signal<EventLooks>({});
  readonly activeEventLooks = signal(0);
  readonly seenIds = signal<string[]>([]);
  private projectionSerial = 0;
  private pendingJobs: AgentJob[] | null = null;

  readonly lastError = signal("");
  readonly starting = signal(false);
  readonly cancelling = signal(false);
  private listing = false;
  private showing = false;
  private forgetting = false;
  private refreshQueued = false;
  private showQueued = false;
  private forgetQueue: string[] = [];
  readonly shownId = signal("");
  readonly shownOutput = signal("");
  readonly shownTranscript = signal<ChatEntry[]>([]);
  readonly shownProposals = signal<Proposal[]>([]);
  readonly previousPage = signal("");
  readonly loadingEarlier = signal(false);
  private earlierTranscript: ChatEntry[] = [];
  private earlierProposals: Proposal[] = [];
  private latestTranscript: ChatEntry[] = [];
  private latestProposals: Proposal[] = [];
  private listingOffset = 0;
  readonly hasMoreJobs = signal(false);
  private generation = 0;
  private timers: ReturnType<typeof setInterval>[] = [];

  /** Finished jobs, for the status line's note (`finishedNote`). */
  onJobFinished: (job: AgentJob) => void = () => {};
  onFailed: (text: string) => void = () => {};
  /** A start that Rust refused, for a caller that asked quietly (an event look). */
  onStartRefused: (code: string) => void = () => {};

  constructor(private call: Caller) {}

  /** Sends this runner's requests to `call` from now on (a preview that must
   * not reach the backend answers them itself). */
  useCaller(call: Caller) {
    this.call = call;
  }

  available(): boolean {
    return this.ready();
  }

  private request(method: string, params: object): Promise<any> {
    const epoch = this.generation;
    return this.call(method, params).then(
      (result) => {
        if (epoch !== this.generation) throw new Error("stale");
        return result;
      },
      (error) => {
        if (epoch !== this.generation) throw new Error("stale");
        throw error;
      },
    );
  }

  /** The backend became ready (or changed): start over. */
  attach(apiVersion: number) {
    this.generation++;
    batch(() => {
      this.apiVersion.set(apiVersion);
      this.ready.set(true);
      this.starting.set(false);
      this.cancelling.set(false);
    });
    this.listing = this.showing = this.forgetting = false;
    this.refreshQueued = this.showQueued = false;
    this.refresh();
    this.refreshAvailability();
    this.drainForgets();
  }

  /** Starts the polls; returns a function that stops them. */
  run(): () => void {
    this.timers.push(
      setInterval(() => {
        if (this.available() && this.selectedAgent() === "System default") this.refreshAvailability();
      }, 15000),
      setInterval(() => {
        if (!this.available() || !this.anyActive()) return;
        this.refresh();
        if (this.shownId() !== "" && this.activeIds().includes(this.shownId())) this.show(this.shownId());
      }, 500),
    );
    return () => {
      for (const timer of this.timers) clearInterval(timer);
      this.timers = [];
      this.generation++;
    };
  }

  // -------------------------------------------------------------- selection

  setSelection(agentChoice: string, model: string, resetAt: number) {
    const agentChanged = agentChoice !== this.selectedAgent();
    const modelChanged = model !== this.selectedModel();
    const resetChanged = resetAt !== this.selectionResetAt();
    if (!agentChanged && !modelChanged && !resetChanged) return;
    batch(() => {
      this.selectedAgent.set(agentChoice);
      this.selectedModel.set(model);
      this.selectionResetAt.set(resetAt);
      if (agentChanged) this.providerAvailable.set(false);
    });
    this.resetSelection();
    if (agentChanged || modelChanged) this.refreshAvailability();
  }

  private resetSelection() {
    this.selectionRevision.update((n) => n + 1);
    this.selectionJobs = {};
  }

  refreshAvailability() {
    const serial = ++this.availabilitySerial;
    if (!this.available()) {
      this.providerAvailable.set(false);
      this.availabilityError.set("Mail backend is unavailable.");
      return;
    }
    if (this.apiVersion() < 6) {
      // An old backend supports Claude through Omarchy's default only.
      const ok = this.selectedAgent() === "System default" && this.selectedModel() === "";
      batch(() => {
        this.resolvedProvider.set("");
        this.providerAvailable.set(ok);
        this.availabilityError.set(ok ? "" : "Update the mail backend to choose an AI agent or model (API 6 required).");
      });
      return;
    }
    if (!this.providerAvailable()) this.availabilityError.set(CHECKING);
    this.request("agent.providerStatus", { provider: provider(this.selectedAgent()) }).then(
      (result) => {
        if (serial !== this.availabilitySerial) return;
        const resolved = result ? String(result.provider || "") : "";
        const ok = !!result && result.available === true;
        if (resolved !== this.resolvedProvider()) this.resetSelection();
        batch(() => {
          this.resolvedProvider.set(resolved);
          this.providerAvailable.set(ok);
          this.availabilityError.set(ok ? "" : "Your system-default agent is not supported. Choose Claude, Codex or OpenCode in Settings → AI.");
        });
      },
      (error) => {
        if (serial !== this.availabilitySerial || codeOf(error) === "stale") return;
        batch(() => {
          this.resolvedProvider.set("");
          this.providerAvailable.set(false);
          this.availabilityError.set("Could not check the selected AI agent.");
        });
      },
    );
  }

  canContinueSelection(job: AgentJob | null | undefined): boolean {
    if (!job) return false;
    const chosen = provider(this.selectedAgent()) || this.resolvedProvider();
    if (chosen !== "" && chosen !== String(job.provider || "claude")) return false;
    if (String(job.model || "") !== this.selectedModel()) return false;
    if (this.selectionJobs[String(job.id)] === this.selectionRevision()) return true;
    const created = job.createdOrder ? Number(job.createdOrder) / 1000000 : Number(job.created || 0) * 1000;
    return created > this.selectionResetAt();
  }

  selection(): Selection {
    return { agent: this.selectedAgent(), model: this.selectedModel(), revision: this.selectionRevision() };
  }

  // ---------------------------------------------------------------- listing

  refresh() {
    if (!this.available()) return;
    if (this.listing) {
      this.refreshQueued = true;
      return;
    }
    this.listing = true;
    const paged = this.apiVersion() >= 6;
    const params = paged ? { paged: true, offset: this.listingOffset, watchIds: this.activeIds().slice(0, 4) } : {};
    const done = () => {
      this.listing = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        this.refresh();
      }
    };
    this.request("agent.jobsList", params).then(
      (result) => {
        if (result) {
          this.hasMoreJobs.set(result.hasMore === true);
          if (Array.isArray(result)) this.applyListing(result);
          else if (Array.isArray(result.jobs)) this.applyListing(result.jobs);
        }
        done();
      },
      (error) => {
        if (codeOf(error) !== "stale") done();
      },
    );
  }

  pageChats(older: boolean) {
    if (this.listing || (older && !this.hasMoreJobs())) return;
    this.listingOffset = older ? this.listingOffset + 32 : Math.max(0, this.listingOffset - 32);
    this.refresh();
  }

  get listingAtStart(): boolean {
    return this.listingOffset === 0;
  }

  private applyListing(next: AgentJob[]) {
    this.pendingJobs = next;
    this.projectJobs();
  }

  projectJobs() {
    if (!this.available()) return;
    const next = this.pendingJobs || this.jobs();
    const serial = ++this.projectionSerial;
    this.request("agent.jobsProjection", { jobs: next, before: this.jobs(), accountId: this.accountId(), seenIds: this.seenIds() }).then(
      (result) => {
        if (serial !== this.projectionSerial || !result) return;
        const before = this.jobs();
        batch(() => {
          this.byMessage.set(result.byMessage || {});
          this.byAccount.set(result.byAccount || {});
          this.scopesByAccount.set(result.scopesByAccount || {});
          this.attentionIds.set(result.attentionIds || []);
          this.anyActive.set(result.anyActive === true);
          this.activeIds.set(result.activeIds || []);
          this.finishedIds.set(result.finishedIds || []);
          this.attention.set(result.attention === true);
          this.attentionByMessage.set(result.attentionByMessage || {});
          this.eventLooks.set(result.eventLooks || {});
          this.activeEventLooks.set(Number(result.activeEventLooks) || 0);
          this.jobs.set(next);
        });
        this.pendingJobs = null;
        for (const job of result.newlyFinished || []) this.onJobFinished(job);
        if (next !== before && this.shownId() !== "") this.show(this.shownId());
      },
      () => {},
    );
  }

  setAccount(accountId: string) {
    if (accountId === this.accountId()) return;
    batch(() => {
      this.accountId.set(accountId);
      this.byMessage.set({});
      this.attentionByMessage.set({});
      this.eventLooks.set({});
    });
    this.projectJobs();
  }

  acknowledge(jobId: string) {
    const id = String(jobId || "");
    if (id === "" || this.seenIds().includes(id)) return;
    this.seenIds.set(this.seenIds().concat([id]).slice(-4096));
    this.projectJobs();
  }

  jobFor(messageId: string, owner?: string): AgentJob | null {
    const account = String(owner || "") !== "" ? String(owner) : this.accountId();
    const messages = account === this.accountId() ? this.byMessage() : this.byAccount()[account] || {};
    return messages[String(messageId || "")] || null;
  }

  jobById(jobId: string): AgentJob | null {
    return this.jobs().find((job) => String(job.id) === String(jobId)) ?? null;
  }

  private scope(owner: string, ids: string[], draftKey: string): Scope {
    const scopes = this.scopesByAccount()[String(owner || this.accountId())] || {};
    const key = draftKey ? "draft:" + String(draftKey) : JSON.stringify(ids.slice().sort());
    return scopes[key] || {};
  }
  selectionJob(ids: string[], owner: string): AgentJob | null {
    return this.scope(owner, ids, "").job || null;
  }
  historyFor(owner: string, ids: string[], draftKey: string): AgentJob[] {
    return this.scope(owner, ids, draftKey).history || [];
  }
  draftJobs(owner: string, draftKey: string): AgentJob[] {
    return this.scope(owner, [], draftKey).jobs || [];
  }
  wantsAttention(job: AgentJob | null): boolean {
    return !!job && this.attentionIds().includes(String(job.id));
  }
  isActive(job: AgentJob | null): boolean {
    return !!job && this.activeIds().includes(String(job.id));
  }

  // --------------------------------------------------------------- starting

  start(payload: StartPayload, quiet: boolean, captured?: Selection): boolean {
    if (!this.available()) {
      this.lastError.set("Mail backend is unavailable");
      return false;
    }
    if (!this.providerAvailable()) {
      this.lastError.set(this.availabilityError());
      return false;
    }
    if (this.starting()) {
      this.lastError.set("AI is still starting. Try again shortly.");
      return false;
    }
    if (payload === null || payload === undefined || payload === "") return false;
    if (typeof payload !== "string" && (typeof payload !== "object" || Array.isArray(payload))) return false;
    const selected = captured || this.selection();
    if (selected.agent !== this.selectedAgent() || selected.model !== this.selectedModel() || selected.revision !== this.selectionRevision()) {
      this.lastError.set("AI selection changed. Start a new chat.");
      return false;
    }
    let parsed: any = payload;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        // Rust refuses it with its own code.
      }
    }
    if (parsed && parsed.parent && !this.canContinueSelection(this.jobById(parsed.parent))) {
      this.lastError.set("This chat belongs to a previous AI selection. Start a new chat.");
      return false;
    }
    const revision = this.selectionRevision();
    const options = startOptions(payload, selected.agent, selected.model, this.apiVersion());
    if (options.error !== undefined) {
      this.lastError.set(options.error);
      return false;
    }
    batch(() => {
      this.lastError.set("");
      this.starting.set(true);
    });
    this.request("agent.jobStart", options.params).then(
      (result) => {
        this.starting.set(false);
        this.listingOffset = 0;
        if (revision === this.selectionRevision() && result && result.id) {
          this.selectionJobs = { ...this.selectionJobs, [String(result.id)]: revision };
        }
        this.refresh();
      },
      (error) => {
        const code = codeOf(error);
        if (code === "stale") return;
        this.starting.set(false);
        if (quiet) this.onStartRefused(code);
        else {
          const text = code === "agent_choose_claude"
            ? this.apiVersion() >= 6
              ? "Choose OpenCode, Codex or Claude in Settings → AI, or select one as Omarchy's default."
              : "This backend supports Claude only. Select Claude as Omarchy's default AI agent."
            : "Could not confirm AI started. Check the conversation before retrying.";
          this.lastError.set(text);
          this.onFailed(text);
        }
        this.refresh();
      },
    );
    return true;
  }

  cancelById(jobId: string): boolean {
    const job = this.jobById(jobId);
    if (!this.available() || !job || !this.activeIds().includes(String(job.id)) || this.cancelling()) return false;
    this.cancelling.set(true);
    const done = (failed: boolean) => {
      this.cancelling.set(false);
      if (failed) this.onFailed("Could not stop the agent. Try again shortly.");
      this.refresh();
    };
    this.request("agent.jobCancel", { id: String(job.id) }).then(
      () => done(false),
      (error) => {
        if (codeOf(error) !== "stale") done(true);
      },
    );
    return true;
  }

  // ---------------------------------------------------------------- showing

  show(jobId: string) {
    const id = String(jobId || "");
    if (id !== this.shownId()) {
      batch(() => {
        this.shownId.set(id);
        this.shownOutput.set("");
        this.shownTranscript.set([]);
        this.shownProposals.set([]);
        this.previousPage.set("");
        this.loadingEarlier.set(false);
      });
      this.earlierTranscript = [];
      this.earlierProposals = [];
      this.latestTranscript = [];
      this.latestProposals = [];
    }
    if (!this.available() || id === "") return;
    if (this.showing) {
      this.showQueued = true;
      return;
    }
    this.showing = true;
    const done = () => {
      this.showing = false;
      if (this.showQueued) {
        this.showQueued = false;
        this.show(this.shownId());
      }
    };
    this.request("agent.jobShow", { id }).then(
      (result) => {
        if (result && result.job && String(result.job.id || "") === this.shownId()) {
          this.shownOutput.set(String(result.output || ""));
          this.latestTranscript = Array.isArray(result.transcript) ? result.transcript : [];
          this.latestProposals = Array.isArray(result.proposals) ? result.proposals : [];
          if (this.earlierTranscript.length === 0) this.previousPage.set(String(result.previous || ""));
          this.publishHistory();
        }
        done();
      },
      (error) => {
        if (codeOf(error) !== "stale") done();
      },
    );
  }

  private static offset(proposals: Proposal[], by: number): Proposal[] {
    return proposals.map((proposal) => ({ ...proposal, afterTurn: Number(proposal.afterTurn || 0) + by }));
  }

  private publishHistory() {
    const transcript = this.earlierTranscript.concat(this.latestTranscript);
    const proposals = this.earlierProposals.concat(AgentRunner.offset(this.latestProposals, this.earlierTranscript.length));
    if (JSON.stringify(this.shownTranscript()) !== JSON.stringify(transcript)) this.shownTranscript.set(transcript);
    if (JSON.stringify(this.shownProposals()) !== JSON.stringify(proposals)) this.shownProposals.set(proposals);
  }

  loadEarlier(): boolean {
    if (!this.available() || this.apiVersion() < 6 || this.loadingEarlier() || this.previousPage() === "") return false;
    const id = this.shownId();
    const before = this.previousPage();
    this.loadingEarlier.set(true);
    this.request("agent.jobShow", { id, before }).then(
      (result) => {
        if (id !== this.shownId() || before !== this.previousPage()) return;
        this.loadingEarlier.set(false);
        if (!result) return;
        const transcript: ChatEntry[] = Array.isArray(result.transcript) ? result.transcript : [];
        this.earlierProposals = (Array.isArray(result.proposals) ? result.proposals : []).concat(AgentRunner.offset(this.earlierProposals, transcript.length));
        this.earlierTranscript = transcript.concat(this.earlierTranscript);
        this.previousPage.set(String(result.previous || ""));
        this.publishHistory();
      },
      (error) => {
        if (codeOf(error) === "stale" || id !== this.shownId()) return;
        this.loadingEarlier.set(false);
        this.onFailed("Could not load earlier messages.");
      },
    );
    return true;
  }

  // -------------------------------------------------------------- forgetting

  forget(jobId: string): boolean {
    const id = String(jobId || "");
    if (!this.available() || id === "") return false;
    this.forgetQueue = this.forgetQueue.concat([id]);
    this.drainForgets();
    return true;
  }

  private drainForgets() {
    if (!this.available() || this.forgetting || this.forgetQueue.length === 0) return;
    const id = this.forgetQueue[0];
    this.forgetQueue = this.forgetQueue.slice(1);
    this.forgetting = true;
    const done = (failed: boolean) => {
      this.forgetting = false;
      if (failed) this.onFailed("Could not remove the job. Try again shortly.");
      this.refresh();
      this.drainForgets();
    };
    this.request("agent.jobForget", { id }).then(
      () => done(false),
      (error) => {
        if (codeOf(error) !== "stale") done(true);
      },
    );
  }
}
