// Whether an account withdraws "send" from its provider's ceiling. Every
// provider's ceiling sends (NativeDomain.js `send: true`); an account may only
// withdraw it, as Registry.js `can(id, "send", refusals)` reads:
//
//   - JMAP: the session's account has no submission capability
//     (JmapProtocol.js `refusals`, `hasSubmission`). Null until both a session
//     and a mailbox list are in hand.
//   - Microsoft 365: the mailbox check lists a `send` refusal (no Sent folder;
//     M365Protocol.js `refusals`). Null until a check has answered.
//
// Null means "nothing read yet", which answers the ceiling. A string is the
// sentence a user reads. Server text is untrusted: only keys are judged, and
// a refusal sentence is clipped to one line.

const CAPABILITY_MAIL = "urn:ietf:params:jmap:mail";
const CAPABILITY_SUBMISSION = "urn:ietf:params:jmap:submission";
export const REFUSAL_NO_SEND = "This account cannot send mail";

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsed(value: unknown): Record<string, any> | null {
  if (isObject(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const doc = JSON.parse(value);
    return isObject(doc) ? doc : null;
  } catch {
    return null;
  }
}

function has(capabilities: unknown, urn: string): boolean {
  return isObject(capabilities) && capabilities[urn] !== undefined && capabilities[urn] !== null;
}

/** The JMAP refusal of "send" for a session's primary mail account. */
export function jmapSendRefusal(session: unknown, mailboxes: unknown): string | null {
  const doc = parsed(session);
  if (!doc || !Array.isArray(mailboxes) || mailboxes.length === 0) return null;
  const primary = isObject(doc.primaryAccounts) ? String(doc.primaryAccounts[CAPABILITY_MAIL] ?? "").trim() : "";
  const account = primary !== "" && isObject(doc.accounts) ? doc.accounts[primary] : null;
  return isObject(account) && has(account.accountCapabilities, CAPABILITY_SUBMISSION) ? "" : REFUSAL_NO_SEND;
}

/** The Microsoft 365 refusal of "send" from a mailbox check's answer. */
export function m365SendRefusal(result: unknown): string | null {
  if (!isObject(result) || result.ok !== true) return null;
  const raw = isObject(result.refusals) ? result.refusals.send : undefined;
  if (raw === undefined || raw === null || raw === false) return "";
  const line = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300) : "";
  return line || "This mailbox cannot do that";
}

/** Registry.can for "send": the ceiling, less what the account refused. */
export function canSend(refusal: string | null | undefined): boolean {
  return refusal === null || refusal === undefined || refusal === "";
}
