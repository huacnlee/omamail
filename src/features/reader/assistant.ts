// What the reader gives the assistant dock, and the events the agent finds in
// the message being read. Ports of Service.qml's `agentReplyEnvelope` and of
// agent/EventSuggester.qml.
//
// Routing is the app's, never the model's: the reply envelope is built here
// from the open message and the account's own addresses, and the dock only
// changes its subject and body. A suggested event is a guess: "Add" opens the
// calendar's editor filled with it, and nothing is written to any calendar
// until the owner presses Save there.
import { computed, effect, signal, untracked } from "nsh";
import { app } from "../../app/store";
import { call } from "../../backend/client";
import { listStore } from "../list/store";
import { registerAssistantHost, type MessageSummary } from "../assistant/host";
import { agentAvailable, runner } from "../assistant/service";
import { settings } from "../settings/store";
import { calendarComposer } from "../calendar";
import { composeHost } from "../../mail/compose/host";
import { replyFields } from "../../mail/compose/recipients";
import { preferredSendAs } from "../../mail/compose/senders";
import type { ProposalEnvelope } from "../../mail/agent/agent";
import * as Events from "../../mail/agent/events";
import { messageTime } from "../../mail/unified";
import { reader } from "./store";

// ------------------------------------------------------------------ the host

/** The open message, when it is the one asked about. */
function openMessage(accountId: string, messageId: string) {
  const at = untracked(() => reader.owner());
  const summary = untracked(() => reader.summary());
  if (!summary || at.accountId !== String(accountId) || at.sourceId !== String(messageId)) return null;
  return summary;
}

function summaryFor(accountId: string, messageId: string): MessageSummary | null {
  const open = openMessage(accountId, messageId);
  if (open) return open as MessageSummary;
  for (const row of untracked(() => listStore.messages())) {
    const owner = listStore.ownerOf(row.id);
    if (owner.accountId === accountId && owner.sourceId === messageId) return { ...row, id: messageId } as MessageSummary;
  }
  return null;
}

/** The reply the app would write to the open message (Service.qml
 * agentReplyEnvelope): sender, recipients and thread chosen here. */
export async function replyEnvelope(accountId: string, messageId: string): Promise<ProposalEnvelope | null> {
  const message: any = openMessage(accountId, messageId);
  const account = app.accounts().find((a) => a.id === accountId);
  if (!message || !account) return null;
  const host = composeHost();
  const aliases = host.aliasesFor(accountId);
  let identities: { accountId?: string; email?: string }[] = [];
  try {
    identities = (await host.identities()).filter((i: any) => String(i.accountId) === accountId);
  } catch {
    // Without the backend's list the account's own address and aliases still count.
  }
  // The open message may have changed while the identities were read.
  if (!openMessage(accountId, messageId)) return null;
  const own = [{ email: account.email }, ...aliases, ...identities];
  const recipients = replyFields(message, "reply", own);
  const addressed = recipients.outgoing ? [message.from] : [...(message.to || []), ...(message.cc || [])];
  const choice: any = preferredSendAs(aliases, addressed);
  const from = choice && String(choice.email || "") !== "" ? String(choice.email) : String(account.email || "");
  return {
    accountId, from, to: recipients.to, cc: recipients.cc, bcc: "", replyTo: "",
    subject: "", body: String(host.signatureFor(accountId).text || ""), attachments: [],
    draftId: "", threadId: String(message.threadId || ""), inReplyTo: String(message.messageId || ""),
    replyMessageId: messageId,
  };
}

let registered = false;

/** Hands the dock the reader's part of its host, once. */
export function registerReaderAssistant() {
  if (registered) return;
  registered = true;
  registerAssistantHost({
    hasAccount: (accountId) => untracked(() => app.accounts()).some((a) => a.id === accountId),
    accountEmail: (accountId) => String(untracked(() => app.accounts()).find((a) => a.id === accountId)?.email ?? ""),
    mailboxKey: () => untracked(() => app.mailbox()),
    summary: summaryFor,
    bodyText: (accountId, messageId) => (openMessage(accountId, messageId) ? untracked(() => reader.bodyText()) : ""),
    replyEnvelope,
  });
}

// ------------------------------------------------------------------ suggested events

interface Look {
  key: string;
  accountId: string;
  id: string;
  summary: MessageSummary;
  folder: string;
}

/** Waved away this session; a restart shows them again, the honest answer for a guess. */
const dismissed = signal<string[]>([]);
/** Handed to the editor, waved away once it is saved, forgotten if it is closed. */
let pending: Events.EventSuggestion | null = null;
let waiting: Look[] = [];
let started: string[] = [];
let preparing = false;
let serial = 0;
/** The selected AI is not one the native worker runs: ask nothing more until the selection changes. */
let unavailable = false;

function lookedAt(accountId: string, messageId: string): boolean {
  return Events.lookFor(untracked(() => runner.eventLooks()), accountId, messageId) !== null;
}

/** Whether the open message is worth a look, and the look if so. */
function consider(): boolean {
  if (untracked(() => settings.suggestEvents()) !== true || !agentAvailable() || unavailable || untracked(() => runner.apiVersion()) < 2) return false;
  const at = untracked(() => reader.owner());
  const summary: any = untracked(() => reader.summary());
  if (at.sourceId === "" || !summary || untracked(() => reader.loading())) return false;
  // The subject counts: "Dinner Thursday at 7pm" over "see you there" is about a date.
  const text = String(summary.subject || "") + "\n" + String(untracked(() => reader.bodyText()) || "");
  if (!Events.worthALook(summary, text, untracked(() => reader.listMail()))) return false;
  if (Events.tooOldForEvents(messageTime(summary), Date.now())) return false;
  const key = at.accountId + " " + at.sourceId;
  if (started.includes(key) || lookedAt(at.accountId, at.sourceId)) return false;
  return tryStart({ key, accountId: at.accountId, id: at.sourceId, summary: { ...summary, id: at.sourceId }, folder: untracked(() => app.mailbox()) });
}

function tryStart(look: Look): boolean {
  const free = !preparing && !untracked(() => runner.starting()) && untracked(() => runner.activeEventLooks()) < Events.EVENTS_IN_FLIGHT;
  if (free && start(look)) {
    started = [...started, look.key];
    return true;
  }
  waiting = [...waiting.filter((w) => w.key !== look.key), look];
  return false;
}

/** The message, read by Rust inside its account, handed to the runner with the flag. */
function start(look: Look): boolean {
  const token = ++serial;
  const selected = runner.selection();
  preparing = true;
  const forget = () => {
    started = started.filter((key) => key !== look.key);
  };
  call<any>("agent.context", {
    accountId: look.accountId, requestId: "events-" + Date.now() + "-" + token, ids: [look.id],
    summaries: [look.summary], folder: look.folder, prompt: Events.EVENTS_PROMPT,
  }).then(
    (result) => {
      if (token !== serial) return;
      preparing = false;
      const payload = result ? result.payload : null;
      if (!payload || String(payload.accountId || "") !== look.accountId) forget();
      else if (!runner.start({ ...payload, events: true }, true, selected)) forget();
      drain();
    },
    () => {
      if (token !== serial) return;
      preparing = false;
      forget();
      drain();
    },
  );
  return true;
}

/** The looks kept waiting, tried in order until one cannot start. */
function drain() {
  started = started.filter((key) => {
    const at = key.indexOf(" ");
    return !lookedAt(key.slice(0, at), key.slice(at + 1));
  });
  const queue = waiting;
  waiting = [];
  for (let i = 0; i < queue.length; i++) {
    const look = queue[i];
    if (!untracked(() => app.accounts()).some((a) => a.id === look.accountId)) continue;
    if (started.includes(look.key) || lookedAt(look.accountId, look.id)) continue;
    if (!tryStart(look)) {
      waiting = [...waiting, ...queue.slice(i + 1)];
      return;
    }
  }
}

function dismiss(key: string) {
  const value = String(key || "");
  if (value !== "" && !untracked(() => dismissed()).includes(value)) dismissed.update((list) => [...list, value]);
}

/** Add: the editor opens on the suggestion, for the owner to look over and save. */
function add(suggestion: Events.EventSuggestion): boolean {
  if (!suggestion) return false;
  if (untracked(() => calendarComposer.calendarChoices()).length === 0) {
    reader.notice("No calendar to add it to: add one in the calendar's settings first");
    return false;
  }
  if (!calendarComposer.beginWith(Events.eventPrefill(suggestion, untracked(() => reader.owner()).accountId))) {
    reader.notice("Finish the event you are editing first");
    return false;
  }
  pending = suggestion;
  return true;
}

let suggesting = false;

/** Runs the looks and feeds the reader's card while the reader is mounted. */
export function useEventSuggestions() {
  if (suggesting) return;
  suggesting = true;
  reader.onAddSuggestion = (suggestion) => void add(suggestion);
  reader.onDismissSuggestion = (key) => dismiss(key);
  // The look the runner lists for the open message is the card.
  const shown = computed(() => {
    const at = reader.owner();
    return Events.eventSuggestions(Events.lookFor(runner.eventLooks(), at.accountId, at.sourceId), dismissed());
  });
  effect(() => {
    const list = shown();
    untracked(() => reader.setSuggestions(list));
  });
  // The body arriving, or the setting or the agent changing, may start a look.
  effect(() => {
    reader.bodyText();
    reader.summary();
    reader.loading();
    settings.suggestEvents();
    agentAvailable();
    untracked(() => consider());
  });
  effect(() => {
    settings.suggestEvents();
    runner.selectedAgent();
    runner.selectedModel();
    untracked(() => {
      unavailable = false;
    });
  });
  // A start lands or a look finishes: the queue moves.
  effect(() => {
    runner.eventLooks();
    const busy = runner.starting();
    if (!busy) untracked(() => drain());
  });
  runner.onStartRefused = (code) => {
    if (String(code) === "agent_choose_claude") {
      unavailable = true;
      waiting = [];
    }
    started = [];
  };
  // Saved from the editor: the suggestion it came from goes. Closed unsaved: forgotten.
  let saving = false;
  effect(() => {
    const writing = calendarComposer.writePending();
    const opened = calendarComposer.opened();
    untracked(() => {
      if (!pending) return;
      if (writing) {
        saving = true;
        return;
      }
      if (opened) {
        // A save that failed leaves the editor open with its error.
        if (saving && calendarComposer.result() !== "") saving = false;
        return;
      }
      if (saving) dismiss(pending.key);
      saving = false;
      pending = null;
    });
  });
}
