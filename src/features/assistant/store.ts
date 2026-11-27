// The dock's own state: whether it is open, what it is about (one message,
// a selection, or a draft), which conversation it shows and the owner's
// unsent text. Port of the state half of AgentPrompt.qml and the dock
// wiring in App.qml. Rust owns the jobs; this owns what the dock looks at.
import { batch, computed, signal } from "nsh";
import {
  PendingQueue, canUseDraftChat, chatEntries, conversationWithProposals, draftAnswer, isActive, pluralizeMessages,
  type AgentJob, type ChatRow, type DraftFields, type Proposal,
} from "../../mail/agent";
import { host } from "./host";
import { app } from "../../app/store";
import { agentAvailable, answerAgent, askAgent, askAgentDraft, askAgentMany, cancelContext, contextBusy, contextError, diagnose, runner } from "./service";
import { aiSettings } from "./settings";

export type DockTarget =
  | { kind: "mail"; accountId: string; ids: string[]; subject: string }
  | { kind: "draft"; accountId: string; draftKey: string; subject: string };

const openSignal = signal(false);
const targetSignal = signal<DockTarget | null>(null);
const historyMode = signal(false);
const viewedJobId = signal("");
const viewedConversationId = signal("");
const ignoredJobId = signal("");
const input = signal("");
const localError = signal("");
const submitted = signal({ prompt: "", input: "", jobId: "", scope: "" });
const sentProposals = signal<Record<string, true>>({});
/** Owner edits to a proposal's recipients and quoted history, by proposal id. */
const proposalEdits = signal<Record<string, { to?: string; cc?: string; includeHistory?: boolean }>>({});
/** Asks the dock's input to take the focus (the counter changes). */
const focusTick = signal(0);
let returnFocus: (() => void) | null = null;

function draftFields(): DraftFields | null {
  const target = targetSignal();
  if (!target || target.kind !== "draft") return null;
  const fields = host().composer.fields();
  return fields && String(fields.draftKey) === target.draftKey && String(fields.accountId) === target.accountId ? fields : null;
}

const scope = computed(() => {
  const target = targetSignal();
  if (!target) return "";
  return target.kind === "draft"
    ? JSON.stringify(["draft", target.accountId, target.draftKey])
    : JSON.stringify(["mail", target.accountId, target.ids.slice().sort()]);
});

const defaultJob = computed<AgentJob | null>(() => {
  const target = targetSignal();
  if (!target || !agentAvailable()) return null;
  if (target.kind === "draft") {
    const drafts = runner.draftJobs(target.accountId, target.draftKey);
    if (drafts.length > 0) return drafts[0];
    const fields = draftFields();
    const reply = fields && fields.replyMessageId ? runner.jobFor(String(fields.replyMessageId), target.accountId) : null;
    return fields && canUseDraftChat(reply, fields) ? reply : null;
  }
  if (target.ids.length > 1) return runner.selectionJob(target.ids, target.accountId);
  return target.ids[0] ? runner.jobFor(target.ids[0], target.accountId) : null;
});

const historyJobs = computed<AgentJob[]>(() => {
  const target = targetSignal();
  if (!target) return [];
  return target.kind === "draft"
    ? runner.historyFor(target.accountId, [], target.draftKey)
    : runner.historyFor(target.accountId, target.ids, "");
});

const job = computed<AgentJob | null>(() => {
  const viewed = viewedJobId();
  if (viewed !== "") {
    const conversation = viewedConversationId();
    const found = historyJobs().find((j) => String(j.id) === viewed || (conversation !== "" && String(j.conversationId || j.id) === conversation));
    if (found) return found;
  }
  const fallback = defaultJob();
  return fallback && runner.canContinueSelection(fallback) && String(fallback.id) !== ignoredJobId() ? fallback : null;
});

const shown = computed(() => {
  const current = job();
  return !!current && runner.shownId() === String(current.id);
});

const proposals = computed<Proposal[]>(() => (shown() && runner.apiVersion() >= 6 ? runner.shownProposals() : []));

const conversation = computed<ChatRow[]>(() => {
  if (!shown()) return [];
  const rows = chatEntries(runner.shownTranscript());
  const output = runner.shownOutput();
  return rows.length ? rows : output ? [{ role: "assistant", text: output }] : [];
});

const rows = computed<ChatRow[]>(() => conversationWithProposals(conversation(), proposals()));

const errorText = computed(() => localError() || contextError() || runner.lastError());

export const pending = new PendingQueue({
  jobs: () => runner.jobs(),
  starting: () => runner.starting() || contextBusy(),
  error: () => contextError() || runner.lastError(),
  answer: (jobId, text, fields) => answerAgent(jobId, text, fields),
  draftFields: () => draftFields(),
});

const working = computed(() => {
  const s = submitted();
  pending.version();
  return isActive(job()) || runner.starting() || contextBusy()
    || (s.scope === scope() && s.prompt !== "" && errorText() === "")
    || (pending.visibleHere && pending.dispatching);
});

function watchJob() {
  const current = job();
  if (!openSignal() || !current) return;
  const s = submitted();
  if (s.prompt !== "" && s.scope === scope() && String(current.id) !== s.jobId) {
    if (input() === s.prompt) input.set("");
    submitted.set({ prompt: "", input: "", jobId: "", scope: "" });
  }
  if (runner.shownId() !== String(current.id)) runner.show(String(current.id));
  if (current.resultReady || !isActive(current)) runner.acknowledge(String(current.id));
}

function resetConversationView() {
  viewedJobId.set("");
  viewedConversationId.set("");
  ignoredJobId.set("");
  historyMode.set(false);
}

export const assistant = {
  open: () => openSignal(),
  target: () => targetSignal(),
  historyMode: () => historyMode(),
  job: () => job(),
  historyJobs: () => historyJobs(),
  rows: () => rows(),
  proposals: () => proposals(),
  input: () => input(),
  setInput(value: string) {
    input.set(value);
  },
  errorText: () => errorText(),
  working: () => working(),
  focusTick: () => focusTick(),
  sentProposals: () => sentProposals(),
  proposalEdits: () => proposalEdits(),
  available: () => agentAvailable(),
  /** The chat can take a follow-up (it belongs to the current AI selection). */
  canContinue: computed(() => {
    const current = job();
    return !!current && !!current.canContinue && runner.canContinueSelection(current);
  }),
  /** A draft chat whose answer can go straight into the editor (old backends). */
  draftAnswer: computed(() => {
    const target = targetSignal();
    return target && target.kind === "draft" ? draftAnswer(job(), runner.shownOutput(), conversation()) : "";
  }),
  title: computed(() => {
    const target = targetSignal();
    if (historyMode()) return "AI · History";
    if (!target) return "AI";
    return "AI · " + (target.subject || (target.kind === "draft" ? "Draft" : "Message"));
  }),
  draftFields,

  /** Opens the dock about one message. `id` may be a unified id. */
  openFor(id: string, subject: string, accountId: string, restore?: () => void) {
    const target: DockTarget = { kind: "mail", accountId: String(accountId || ""), ids: [String(id || "")], subject: String(subject || "") };
    const before = targetSignal();
    batch(() => {
      if (!before || before.kind !== "mail" || before.accountId !== target.accountId || before.ids.join("\n") !== target.ids.join("\n")) {
        input.set("");
        resetConversationView();
        pending.clear();
      }
      targetSignal.set(target);
    });
    assistant.show(restore);
  },
  /** Opens the dock about several messages from one mailbox. */
  openForSelection(ids: string[], accountId: string, restore?: () => void) {
    batch(() => {
      resetConversationView();
      input.set("");
      pending.clear();
      targetSignal.set({ kind: "mail", accountId: String(accountId || ""), ids: ids.map(String), subject: pluralizeMessages(ids.length) });
    });
    assistant.show(restore);
  },
  /** Opens the dock about the draft open in the editor. */
  openForDraft(restore?: () => void) {
    const fields = host().composer.fields();
    if (!fields || !fields.draftKey) return;
    const before = targetSignal();
    batch(() => {
      if (!before || before.kind !== "draft" || before.draftKey !== fields.draftKey) {
        resetConversationView();
        input.set("");
      }
      targetSignal.set({ kind: "draft", accountId: String(fields.accountId), draftKey: String(fields.draftKey), subject: String(fields.subject || "") });
    });
    assistant.show(restore);
  },
  show(restore?: () => void) {
    if (!openSignal()) returnFocus = restore ?? null;
    batch(() => {
      localError.set("");
      openSignal.set(true);
      focusTick.update((n) => n + 1);
    });
    watchJob();
  },
  /** Closes the dock and gives the focus back to where it came from. */
  close() {
    if (!openSignal()) return;
    openSignal.set(false);
    cancelContext();
    const restore = returnFocus;
    returnFocus = null;
    if (restore) setTimeout(restore, 0);
  },
  toggle(restore?: () => void) {
    if (openSignal()) assistant.close();
    else if (targetSignal()) assistant.show(restore);
  },
  watchJob,

  showHistory() {
    historyMode.set(true);
  },
  leaveHistory() {
    historyMode.set(false);
    focusTick.update((n) => n + 1);
  },
  selectHistory(id: string) {
    const found = historyJobs().find((j) => String(j.id) === String(id));
    batch(() => {
      viewedJobId.set(String(id));
      viewedConversationId.set(found ? String(found.conversationId || found.id) : "");
      ignoredJobId.set("");
      historyMode.set(false);
      focusTick.update((n) => n + 1);
    });
    watchJob();
  },
  newChat(preserveInput = false) {
    if (working() || pending.busy) return;
    const fallback = defaultJob();
    batch(() => {
      ignoredJobId.set(fallback ? String(fallback.id) : "");
      viewedJobId.set("");
      viewedConversationId.set("");
      historyMode.set(false);
      if (!preserveInput) input.set("");
      localError.set("");
      contextError.set("");
      runner.lastError.set("");
      focusTick.update((n) => n + 1);
    });
  },
  /** Escape over a running request; false when nothing ran. */
  interrupt(): boolean {
    const current = job();
    if (!isActive(current)) return false;
    pending.pause();
    runner.cancelById(String(current!.id));
    return true;
  },

  /** Runs a slash command; false when the input is not one. */
  command(text: string): boolean {
    const command = text.trim();
    if (command === "/history") {
      input.set("");
      assistant.showHistory();
      return true;
    }
    if (command === "/diagnose") {
      input.set("");
      void diagnose().then((text) => app.setNotice(text));
      return true;
    }
    if (command === "/clear") {
      if (working() || pending.busy) {
        localError.set(working() ? "Stop the current request before starting a new chat." : "Remove queued messages before starting a new chat.");
        return true;
      }
      assistant.newChat();
      return true;
    }
    return false;
  },

  /** Sends the input: a new ask, a follow-up, or a queued message. */
  async submit(): Promise<boolean> {
    const text = input();
    if (assistant.command(text)) return true;
    const prompt = text.trim();
    const target = targetSignal();
    if (prompt === "" || !target) return false;
    if (!agentAvailable()) {
      localError.set(runner.available() ? runner.availabilityError() : "AI is not available in this build.");
      return false;
    }
    pending.currentScope = scope();
    pending.currentJob = job();
    if (working() || pending.busy) {
      const s = submitted();
      if (!job() && s.scope !== scope() && !pending.busy) {
        localError.set("AI is starting another request. Try again shortly.");
        return false;
      }
      const queued = pending.add(prompt, s.scope === scope() && s.prompt !== "");
      if (queued) {
        const current = job();
        batch(() => {
          input.set("");
          localError.set("");
          if (current) {
            viewedJobId.set(String(current.id));
            viewedConversationId.set(String(current.conversationId || current.id));
          }
        });
      } else localError.set(pending.error);
      return queued;
    }
    localError.set("");
    const current = job();
    if (current && !assistant.canContinue()) {
      localError.set("Start a new chat to ask again.");
      return false;
    }
    const fields = target.kind === "draft" ? draftFields() : null;
    if (target.kind === "draft" && !fields) {
      localError.set("Open the draft to ask about it.");
      return false;
    }
    const accepted = current
      ? answerAgent(String(current.id), prompt, fields)
      : fields
        ? askAgentDraft(fields, prompt)
        : target.kind === "mail" && target.ids.length > 1
          ? askAgentMany(target.ids, prompt, target.accountId)
          : target.kind === "mail"
            ? await askAgent(target.ids[0], prompt, target.accountId)
            : false;
    if (!accepted) {
      if (!errorText()) localError.set("AI could not start. Check the message and try again.");
      return false;
    }
    batch(() => {
      submitted.set({ prompt, input: text, jobId: current ? String(current.id) : "", scope: scope() });
      input.set("");
    });
    return true;
  },

  /** Takes a pending message back into the input (only into an empty one). */
  editPending(index: number) {
    if (input() !== "") return;
    const text = pending.remove(index);
    if (text !== "") {
      input.set(text);
      focusTick.update((n) => n + 1);
    }
  },
  removePending(index: number) {
    pending.remove(index);
  },

  editProposal(id: string, field: "to" | "cc" | "includeHistory", value: string | boolean) {
    proposalEdits.update((all) => ({ ...all, [id]: { ...(all[id] || {}), [field]: value } }));
  },
  markSent(id: string) {
    sentProposals.update((all) => ({ ...all, [id]: true }));
  },
  setLocalError(text: string) {
    localError.set(text);
  },

  /** The dock's tick: advances the pending queue and watches the job. */
  tick() {
    pending.currentScope = scope();
    pending.currentJob = job();
    pending.advance();
    // A failed start hands the typed text back, as the Qt dock did.
    const s = submitted();
    if (errorText() !== "" && s.prompt !== "" && s.scope === scope() && !isActive(job()) && !runner.starting() && !contextBusy()) {
      if (input() === "") input.set(s.input);
      submitted.set({ prompt: "", input: "", jobId: "", scope: "" });
    }
  },

  /** A new AI selection starts fresh chats: forget the queued messages. */
  selectionChanged() {
    pending.clear();
    batch(() => {
      submitted.set({ prompt: "", input: "", jobId: "", scope: "" });
      resetConversationView();
      localError.set("");
    });
  },
};

export { aiSettings };
