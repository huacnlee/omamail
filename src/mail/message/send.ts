// A message sent on one explicit press, outside compose: the list's
// unsubscribe address, an invitation answered by mail (Unsubscribe.qml,
// Rsvp.qml). The routing comes from the message the person chose to act on
// (its List-Unsubscribe header, its organiser), never from model text.
//
// The MIME is built by the backend (`message.compose`, Message.js
// buildSendPayload), then sent the way each provider client's `sendMessage`
// sent it in the Qt client.
import { call } from "../../backend/client";
import { clientFor } from "../compose/host";

export interface SendFields {
  /** The address the message was received at (an alias, or the account's own). */
  from: string;
  fromName: string;
  /** The account's own address, for providers that put it on the envelope. */
  accountAddress: string;
  to: string;
  subject: string;
  body: string;
  /** An RFC 5546 part: `{ method, text }`. */
  calendar?: { method: string; text: string } | null;
  inReplyTo?: string;
  threadId?: string;
}

/** The provider request that sends a built payload, as each Qt client made it. */
export function sendRequest(provider: string, payload: Record<string, any>): { method: string; params: Record<string, unknown> } {
  const raw = String(payload?.raw ?? "");
  const threadId = String(payload?.threadId ?? "");
  switch (clientFor(provider)) {
    case "gmail": {
      // GmailApi.sendBody: the raw message and, when there is one, its thread.
      const params: Record<string, unknown> = { raw };
      if (threadId !== "") params.threadId = threadId;
      return { method: "gmail.send", params };
    }
    case "jmap":
      return { method: "jmap.send", params: { ...payload } };
    case "m365":
      return { method: "m365.send", params: { raw } };
    case "hey":
      return {
        method: "hey.send",
        params: { raw, threadId, attachments: Array.isArray(payload?.attachments) ? payload.attachments : [] },
      };
    default:
      return { method: "imap.send", params: { raw } };
  }
}

export class UnwritableAddress extends Error {}

/** Builds the message and sends it from `accountId`. Rejects with
 * `UnwritableAddress` when an address cannot be written into a header. */
export async function sendMail(accountId: string, provider: string, fields: SendFields): Promise<void> {
  const built: Record<string, unknown> = {
    from: fields.from,
    fromName: fields.fromName,
    accountAddress: fields.accountAddress,
    to: fields.to,
    subject: fields.subject,
    body: fields.body,
    threadId: fields.threadId ?? "",
    inReplyTo: fields.inReplyTo ?? "",
    draftId: "",
  };
  if (fields.calendar) built.calendar = fields.calendar;
  let payload: Record<string, any> | null = null;
  try {
    payload = await call<Record<string, any>>("message.compose", { fields: built });
  } catch {
    payload = null;
  }
  if (!payload || String(payload.raw ?? "") === "") throw new UnwritableAddress();
  const request = sendRequest(provider, payload);
  await call(request.method, { ...request.params, accountId });
}
