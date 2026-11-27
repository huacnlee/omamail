// Which mailboxes each provider offers, and the few capabilities the rail and
// the label menu ask about. Port of the MAILBOXES tables in
// omarchy/ui/providers/*.js, Registry.mailboxes and the label capabilities in
// providers/NativeDomain.js. If src/mail/providers grows a full registry, this
// table should fold into it.
import type { Mailbox } from "./labels";

export interface MailboxEntry extends Mailbox {
  icon: string;
  /** Dropped where the server reported it has no such folder. */
  optional?: boolean;
  minimumApiVersion?: number;
  maximumApiVersion?: number;
}

/** The backend API revision this client speaks (core/src/backend/mod.rs). */
export const API_VERSION = 10;

const STANDARD: MailboxEntry[] = [
  { key: "inbox", label: "Inbox", icon: "inbox" },
  { key: "unread", label: "Unread", icon: "unread" },
  { key: "starred", label: "Flagged", icon: "star" },
  { key: "drafts", label: "Drafts", icon: "compose" },
  { key: "sent", label: "Sent", icon: "sent" },
  { key: "archive", label: "Archive", icon: "archive", optional: true },
  { key: "spam", label: "Junk", icon: "spam", optional: true },
  { key: "trash", label: "Trash", icon: "trash", optional: true },
];

export const MAILBOXES: Record<string, readonly MailboxEntry[]> = {
  gmail: [
    { key: "inbox", label: "Inbox", icon: "inbox" },
    { key: "unread", label: "Unread", icon: "unread" },
    { key: "starred", label: "Starred", icon: "star" },
    { key: "drafts", label: "Drafts", icon: "compose" },
    { key: "sent", label: "Sent", icon: "sent" },
    { key: "all", label: "All mail", icon: "archive", optional: true },
    { key: "spam", label: "Spam", icon: "spam", optional: true },
    { key: "trash", label: "Trash", icon: "trash", optional: true },
  ],
  hey: [
    { key: "inbox", label: "Imbox", icon: "inbox" },
    { key: "unread", label: "New for you", icon: "unread" },
    { key: "drafts", label: "Drafts", icon: "compose" },
    { key: "later", label: "Reply Later", icon: "reply" },
    { key: "aside", label: "Set Aside", icon: "pin" },
    { key: "feed", label: "The Feed", icon: "label" },
    { key: "papertrail", label: "Paper Trail", icon: "archive", optional: true },
    { key: "trash", label: "Trash", icon: "trash", optional: true },
  ],
  outlook: STANDARD,
  m365: STANDARD,
  jmap: STANDARD,
  imap: [
    { key: "inbox", label: "Inbox", icon: "inbox" },
    { key: "unread", label: "Unread", icon: "unread" },
    { key: "starred", label: "Flagged", icon: "star" },
    { key: "drafts", label: "Drafts", icon: "compose" },
    { key: "sent", label: "Sent", icon: "sent" },
    { key: "archive", label: "Archive", icon: "archive", maximumApiVersion: 5, optional: true },
    { key: "all", label: "All mail", icon: "archive", minimumApiVersion: 6, optional: true },
    { key: "spam", label: "Junk", icon: "spam", optional: true },
    { key: "trash", label: "Trash", icon: "trash", optional: true },
  ],
};

/** The provider the Qt registry falls back to for an unknown id. */
export const DEFAULT_PROVIDER = "gmail";

/** A provider's mailboxes, without the ones the server reported absent or the API cannot reach. */
export function mailboxes(provider: string, absent?: readonly string[] | null, apiVersion: number = API_VERSION): MailboxEntry[] {
  const table = MAILBOXES[provider] ?? MAILBOXES[DEFAULT_PROVIDER];
  const drop = new Set((Array.isArray(absent) ? absent : []).map(String));
  return table.filter(
    (row) =>
      !drop.has(row.key) &&
      apiVersion >= (row.minimumApiVersion ?? 0) &&
      (!row.maximumApiVersion || apiVersion <= row.maximumApiVersion),
  );
}

/** The rows every one of these mailboxes has, in the first one's order (Unified.sharedMailboxRows). */
export function sharedMailboxes(lists: readonly (readonly MailboxEntry[])[]): MailboxEntry[] {
  if (lists.length === 0) return [];
  return lists[0].filter((row) => row.key !== "" && lists.every((other) => other.some((r) => r.key === row.key)));
}

export interface LabelCapabilities {
  /** Gmail-style labels (a message can carry several). */
  labels: boolean;
  /** Labels or folders can be created, renamed and deleted here. */
  manageLabels: boolean;
  /** Messages move between folders. */
  move: boolean;
  spam: boolean;
}

const CAPABILITIES: Record<string, LabelCapabilities> = {
  gmail: { labels: true, manageLabels: true, move: true, spam: true },
  hey: { labels: true, manageLabels: false, move: false, spam: true },
  imap: { labels: false, manageLabels: true, move: true, spam: false },
  jmap: { labels: false, manageLabels: false, move: false, spam: true },
  m365: { labels: false, manageLabels: false, move: false, spam: false },
  outlook: { labels: false, manageLabels: true, move: true, spam: false },
};

const NONE: LabelCapabilities = { labels: false, manageLabels: false, move: false, spam: false };

export function capabilities(provider: string): LabelCapabilities {
  return CAPABILITIES[provider] ?? NONE;
}

/** A provider whose labels are folders: the Inbox is a move destination there. */
export function labelsAreFolders(provider: string): boolean {
  const caps = capabilities(provider);
  return !caps.labels && caps.move;
}
