// What compose gives the assistant dock (`registerAssistantHost`): the open
// editor's identity and fields, proposals applied into it, and proposals the
// owner sends from the dock. Port of ComposeView.qml's currentFields,
// applyProposal, beginProposal, sendProposal and proposalRoutingChanged.
//
// Routing is never the model's: applying a proposal changes only the subject
// and the reply text, and a proposal whose sender, recipients or quoted
// history no longer match the editor is refused (the dock says so). Only the
// owner's press in the dock sends, through the normal outbox.
import { registerAssistantHost, type AssistantComposer } from "../assistant/host";
import * as Agent from "../../mail/agent/agent";
import type { DraftFields, ProposalEnvelope } from "../../mail/agent/agent";
import * as Draft from "../../mail/compose/draft";
import { beginProposalDraft, compose, deliveryStateOf, sendProposalDraft, update } from "./store";

/** The quote the reply still carries, as the app placed it. */
function retainedQuote(): string {
  const d = compose.draft();
  if (!Draft.isReply(d.mode)) return "";
  return Agent.replyOnly(d.body, d.bodyQuote) !== d.body ? d.bodyQuote : "";
}

/** The editor's message as it would go: null while files are still arriving. */
function outgoingEnvelope(): ProposalEnvelope | null {
  if (compose.forwardLoading() || compose.forwardError() !== "" || compose.attaching()) return null;
  const d = compose.draft();
  return {
    accountId: d.accountId,
    draftKey: d.draftKey,
    from: d.fromEmail,
    to: d.to,
    cc: d.cc,
    bcc: d.bcc,
    replyTo: d.replyTo,
    subject: d.subject,
    body: d.body,
    attachments: JSON.parse(JSON.stringify(Draft.outgoingAttachments(d))),
    draftId: d.sourceDraftId,
    threadId: d.mode === "forward" ? "" : d.threadId,
    inReplyTo: d.mode === "forward" ? "" : d.inReplyTo,
    replyMessageId: d.replyMessageId,
    replyQuote: retainedQuote(),
  };
}

/** The proposal is about the open editor's draft (or its reply). */
function sameDraft(envelope: ProposalEnvelope): boolean {
  const d = compose.draft();
  return envelope.draftKey
    ? String(envelope.draftKey) === d.draftKey
    : d.replyMessageId !== "" && String(envelope.replyMessageId || "") === d.replyMessageId;
}

export function routingChanged(envelope: ProposalEnvelope): boolean {
  if (!compose.opened() || !envelope || !sameDraft(envelope)) return false;
  const d = compose.draft();
  return (
    String(envelope.accountId || "") !== d.accountId ||
    String(envelope.from || "") !== d.fromEmail ||
    String(envelope.to || "") !== d.to ||
    String(envelope.cc || "") !== d.cc ||
    String(envelope.bcc || "") !== d.bcc ||
    String(envelope.replyTo || "") !== d.replyTo ||
    String(envelope.replyQuote || "") !== retainedQuote()
  );
}

export const composer: AssistantComposer = {
  fields(): DraftFields | null {
    if (!compose.opened()) return null;
    const d = compose.draft();
    return {
      accountId: d.accountId,
      draftKey: d.draftKey,
      replyMessageId: d.replyMessageId,
      from: d.fromEmail,
      to: d.to,
      cc: d.cc,
      bcc: d.bcc,
      subject: d.subject,
      body: Agent.replyOnly(d.body, retainedQuote()),
      draftId: d.sourceDraftId,
      envelope: outgoingEnvelope() ?? undefined,
    };
  },
  applyProposal(envelope) {
    const d = compose.draft();
    if (!compose.opened() || String(envelope.accountId) !== d.accountId || !sameDraft(envelope)) return false;
    const quote = retainedQuote();
    const reply = Agent.replyOnly(String(envelope.body || ""), String(envelope.replyQuote || ""));
    update({ subject: String(envelope.subject || ""), body: quote ? reply + "\n\n" + quote : reply, bodyWasEdited: true });
    return true;
  },
  beginProposal(draft) {
    beginProposalDraft({ ...draft, draftKey: draft.draftKey || Draft.newDraftKey() });
  },
  async sendProposal(envelope, sendId, jobId) {
    if (routingChanged(envelope)) {
      return { ok: false, error: "The sender, recipients or quoted history changed. Edit the draft to send with your current choices." };
    }
    const draft = Agent.proposalDraft(envelope, jobId, String(envelope.draftKey || Draft.newDraftKey()));
    return sendProposalDraft(draft, sendId);
  },
  routingChanged: (envelope) => routingChanged(envelope),
  deliveryState: (accountId, sendId) => deliveryStateOf(accountId, sendId) as ReturnType<AssistantComposer["deliveryState"]>,
  replaceBody(text) {
    update({ body: String(text || ""), bodyWasEdited: true });
  },
  insertAtCursor(text) {
    // The caret is the platform's; the answer goes after the reply, before any quote.
    const d = compose.draft();
    const quote = retainedQuote();
    const reply = Agent.replyOnly(d.body, quote);
    const joined = reply === "" ? String(text || "") : reply.replace(/\s*$/, "") + "\n\n" + String(text || "");
    update({ body: quote ? joined + "\n\n" + quote : joined, bodyWasEdited: true });
  },
};

let registered = false;

/** Hands the dock compose's part of its host, once. */
export function registerComposeAssistant() {
  if (registered) return;
  registered = true;
  registerAssistantHost({ composer });
}
