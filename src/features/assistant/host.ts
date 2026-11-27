// What the dock needs from the rest of the app, as one interface the mail
// features fill in (`registerAssistantHost`). The dock never reads another
// feature's state directly, and nothing here lets model text choose where
// mail goes: every envelope comes from the host, built from the account and
// message the owner opened, and only a press of "Send email" in the dock
// hands one to the host's normal outbox.
import { signal } from "nsh";
import type { DraftFields, ProposalEnvelope } from "../../mail/agent";

/** A list row as the backend returned it: what `agent.context` reads. */
export type MessageSummary = Record<string, unknown> & { id: string };

/** The delivery of one proposal sent through the outbox, as the outbox says it. */
export type DeliveryState = "" | "queued" | "sending" | "sent" | "failed" | "cancelled" | "unknown";

export interface AssistantComposer {
  /** The open editor's identity and fields, or null when none is open. */
  fields(): DraftFields | null;
  /** Puts a proposal's subject and body into the open editor, keeping its
   * routing; false when the editor is not the proposal's draft. */
  applyProposal(envelope: ProposalEnvelope, proposalId: string, jobId: string): boolean;
  /** Opens a new editor with a proposal (see `proposalDraft`). */
  beginProposal(draft: ReturnType<typeof import("../../mail/agent").proposalDraft>): void;
  /** Queues the proposal in the outbox exactly as shown. The outbox owns
   * delivery, undo and retries; `sendId` makes a repeated press one send. */
  sendProposal(envelope: ProposalEnvelope, sendId: string, jobId: string): Promise<{ ok: boolean; error?: string }>;
  /** The sender, recipients or quoted history differ from the proposal's. */
  routingChanged(envelope: ProposalEnvelope, proposalId: string): boolean;
  /** Where the outbox has a send of `sendId` got to. */
  deliveryState(accountId: string, sendId: string): DeliveryState;
  /** Inserts text at the editor's caret (old backends' plain answers). */
  insertAtCursor?(text: string): void;
  replaceBody?(text: string): void;
}

export interface AssistantHost {
  /** The account is still set up. */
  hasAccount(accountId: string): boolean;
  /** The owner's address in that account (the draft's default sender). */
  accountEmail(accountId: string): string;
  /** The mailbox the list shows for that account (`agent.context`'s `folder`). */
  mailboxKey(accountId: string): string;
  /** The list's row for a message, if it has one loaded. */
  summary(accountId: string, messageId: string): MessageSummary | null;
  /** The reader's plain body text when that message is open, else "". */
  bodyText(accountId: string, messageId: string): string;
  /** The reply the app would write to that message: sender, recipients and
   * thread fields chosen by the app, never by the model. null: no reply. */
  replyEnvelope(accountId: string, messageId: string): Promise<ProposalEnvelope | null>;
  composer: AssistantComposer;
}

function none(): AssistantHost {
  return {
    hasAccount: () => true,
    accountEmail: () => "",
    mailboxKey: () => "",
    summary: () => null,
    bodyText: () => "",
    replyEnvelope: async () => null,
    composer: {
      fields: () => null,
      applyProposal: () => false,
      beginProposal: () => {},
      sendProposal: async () => ({ ok: false, error: "Sending from AI is not available yet." }),
      routingChanged: () => true,
      deliveryState: () => "",
    },
  };
}

const current = signal<AssistantHost>(none());

/** The mail features fill the parts they own; the rest keeps safe defaults
 * (no reply envelope, no editor, no sending). Returns a function that
 * restores what was there. */
export function registerAssistantHost(parts: Partial<Omit<AssistantHost, "composer">> & { composer?: Partial<AssistantComposer> }): () => void {
  const before = current();
  current.set({ ...before, ...parts, composer: { ...before.composer, ...(parts.composer ?? {}) } } as AssistantHost);
  return () => current.set(before);
}

export function host(): AssistantHost {
  return current();
}
