// Shared parts of the list's provider clients: the client interface every
// provider implements, page shapes, error sentences and request tokens.
// Owner: the list agent (docs/NSH-PORT.md). Reader, mailbox and others may
// import these read-only; auth and credentials stay in src/mail/providers/.
import { labelChangesFor } from "../../listModel";

export { labelChangesFor };
export interface Rpc {
  call<T = any>(method: string, params: object): Promise<T>;
  on(method: string, listener: (params: any) => void): () => void;
}

export interface ListPage {
  ids: string[];
  nextPageToken: string;
  estimate: number;
  /** A sentence when the listing is incomplete ("The mailbox search could not be completed"). */
  warning: string;
}

export interface ReadResult {
  /** Provider resources, in the order asked, for `message.summaries`. */
  messages: unknown[];
  warning: string;
}

export interface ChangeResult {
  /** Ids the provider said were not changed; empty when all were. */
  failedIds: string[];
  error: string;
}

export interface MailClient {
  readonly provider: string;
  list(query: string, limit: number, pageToken: string): Promise<ListPage>;
  read(ids: string[]): Promise<ReadResult>;
  /** Sends one action for these ids: a label change, or trash / untrash. */
  act(action: string, ids: string[], sourceLabelId?: string): Promise<ChangeResult>;
  /** Abandons work in flight (a new listing replaces the last). */
  cancel(): void;
}

/** What a provider's sign-in knows that its requests need (HEY's program). */
export interface ProviderContext {
  heyProgram?: string;
}

/** A backend error's code (the message the backend sends is its code). */
export function errorCode(error: unknown): string {
  return error && typeof error === "object" && "message" in error ? String((error as Error).message ?? "") : String(error ?? "");
}

const SENTENCES: Record<string, string> = {
  gmail_timeout: "Gmail did not answer in time",
  gmail_unauthorized: "Gmail authorization expired. Sign in again.",
  gmail_invalid_token: "Gmail authorization expired. Sign in again.",
  gmail_signed_out: "Gmail authorization expired. Sign in again.",
  gmail_forbidden: "Gmail refused this request (HTTP 403). Check account permissions.",
  gmail_rate_limited: "Gmail is rate limiting this account (HTTP 403/429). Wait a moment, then try again.",
  gmail_queue_full: "Too many changes are still waiting for Gmail. Wait a moment, then try again.",
  gmail_queue_lost: "The change was not sent before the mail backend stopped",
  jmap_unauthorized: "Sign in to this mailbox again",
  credential_missing: "Sign in to this mailbox again",
  jmap_missing_mailbox: "The destination mailbox is unavailable",
  jmap_message_not_found: "That message is no longer in the mailbox",
  jmap_request_too_large: "This request is larger than the server accepts",
  jmap_spam_unavailable: "This server is not known to learn from its Junk mailbox",
  jmap_timeout: "The mail server took too long to answer",
  request_timed_out: "The mail server took too long to answer",
};

/** The sentence the user reads for a backend failure. Codes only: a server's
 * own text never reaches the screen unfiltered. */
export function sentenceFor(provider: string, error: unknown): string {
  const code = errorCode(error);
  if (SENTENCES[code]) return SENTENCES[code];
  if (code === "Backend unavailable" || code === "Backend is shutting down") return "Mail backend unavailable";
  if (provider === "gmail") return "Gmail backend could not complete this request";
  if (provider === "m365") return "Microsoft 365 could not complete this request";
  if (provider === "hey") return "HEY could not complete this request";
  return "The mail server could not complete this request";
}

export function pageOf(value: any): ListPage {
  const page = value ?? {};
  return {
    ids: Array.isArray(page.ids) ? page.ids.map((id: unknown) => String(id)) : [],
    nextPageToken: String(page.nextPageToken ?? ""),
    estimate: Math.max(0, Math.floor(Number(page.estimate)) || 0),
    warning: "",
  };
}

export const pageSize = (limit: number) => Math.max(1, Math.min(100, Math.floor(Number(limit) || 25)));

let sequence = 0;
export const nextSequence = () => ++sequence;
export const nextToken = (prefix: string) => prefix + ":" + String(++sequence);

/** A failure that means the account is no longer signed in. */
export function isSignedOut(error: unknown): boolean {
  const code = errorCode(error);
  return ["gmail_unauthorized", "gmail_invalid_token", "gmail_signed_out", "jmap_unauthorized", "credential_missing",
    "m365_signed_out", "m365_unauthorized", "imap_auth_failed", "hey_signed_out"].includes(code)
    || code.startsWith("Sign in");
}
