// The providers a mailbox can be: what the chooser and the setup pages say
// about each, how each signs in and which mailboxes it has. Port of the
// presentation half of providers/Registry.js and its descriptors (Gmail.js,
// Outlook.js, M365.js, Hey.js, Imap.js, Jmap.js). Provider differences stay
// here and in the per-provider modules beside it, never in the views.
//
// The chooser lists them in this order: the specific protocol before the
// catch-all (docs/providers/README.md).
import gmailMark from "./assets/gmail.png";
import heyMark from "./assets/hey-mark.png";
import outlookMark from "./assets/outlook.svg";
import type { ProviderId } from "../accounts";
import * as Jmap from "./jmap";

type ImageAsset = typeof gmailMark;

export type AuthKind = "oauth" | "password" | "cli";

export interface MailboxEntry {
  key: string;
  label: string;
  icon: string;
  optional?: boolean;
  minimumApiVersion?: number;
  maximumApiVersion?: number;
}

export interface Provider {
  id: ProviderId;
  name: string;
  summary: string;
  auth: AuthKind;
  /** The provider's own artwork, in its own colors; null for the themed envelope. */
  mark: ImageAsset | null;
  /** The provider's web mail, for "Open in browser"; "" when there is none. */
  webHomeUrl: string;
  /** The program a provider runs on, when that is not the service (HEY's CLI). */
  clientUrl: string;
  /** Why it cannot be added now; "" when it can. */
  unavailable: string;
  mailboxes: MailboxEntry[];
}

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

export const PROVIDERS: Provider[] = [
  {
    id: "gmail",
    name: "Gmail",
    summary: "Google's own API. Needs an OAuth client you create once.",
    auth: "oauth",
    mark: gmailMark,
    webHomeUrl: "https://mail.google.com/mail/u/0/",
    clientUrl: "",
    unavailable: "",
    mailboxes: [
      { key: "inbox", label: "Inbox", icon: "inbox" },
      { key: "unread", label: "Unread", icon: "unread" },
      { key: "starred", label: "Starred", icon: "star" },
      { key: "drafts", label: "Drafts", icon: "compose" },
      { key: "sent", label: "Sent", icon: "sent" },
      { key: "all", label: "All mail", icon: "archive", optional: true },
      { key: "spam", label: "Spam", icon: "spam", optional: true },
      { key: "trash", label: "Trash", icon: "trash", optional: true },
    ],
  },
  {
    id: "outlook",
    name: "Outlook",
    summary: "Outlook.com and Hotmail, signed in securely with Microsoft.",
    auth: "oauth",
    mark: outlookMark,
    webHomeUrl: "https://outlook.live.com/mail/",
    clientUrl: "",
    unavailable: "",
    mailboxes: STANDARD,
  },
  {
    id: "m365",
    name: "Microsoft 365",
    summary: "Work or school mail and calendar, one sign-in, no IMAP needed.",
    auth: "oauth",
    mark: outlookMark,
    webHomeUrl: "",
    clientUrl: "",
    unavailable: "",
    mailboxes: STANDARD,
  },
  {
    id: "hey",
    name: "HEY",
    summary: "37signals' own mailbox, read through the HEY CLI they publish.",
    auth: "cli",
    mark: heyMark,
    webHomeUrl: "https://app.hey.com",
    clientUrl: "https://github.com/basecamp/hey-cli",
    unavailable: "",
    mailboxes: [
      { key: "inbox", label: "Imbox", icon: "inbox" },
      { key: "unread", label: "New for you", icon: "unread" },
      { key: "drafts", label: "Drafts", icon: "compose" },
      { key: "later", label: "Reply Later", icon: "reply" },
      { key: "aside", label: "Set Aside", icon: "pin" },
      { key: "feed", label: "The Feed", icon: "label" },
      { key: "papertrail", label: "Paper Trail", icon: "archive", optional: true },
      { key: "trash", label: "Trash", icon: "trash", optional: true },
    ],
  },
  {
    id: "jmap",
    name: "JMAP",
    summary: "Any server that speaks JMAP",
    auth: "password",
    mark: null,
    webHomeUrl: "",
    clientUrl: "",
    unavailable: "",
    mailboxes: STANDARD,
  },
  {
    id: "imap",
    name: "IMAP",
    summary: "Any standard mailbox — Fastmail, iCloud, Zoho, your own server.",
    auth: "password",
    mark: null,
    webHomeUrl: "",
    clientUrl: "",
    unavailable: "",
    mailboxes: [
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
  },
];

export const DEFAULT_ID: ProviderId = "gmail";

/** The chooser's order. */
export function ids(): ProviderId[] {
  return PROVIDERS.map((provider) => provider.id);
}

export function exists(id: unknown): boolean {
  const wanted = String(id ?? "").trim().toLowerCase();
  return PROVIDERS.some((provider) => provider.id === wanted);
}

/** The provider named `id`; Gmail for anything unknown, as an account's provider reads. */
export function get(id: unknown): Provider {
  const wanted = String(id ?? "").trim().toLowerCase();
  return PROVIDERS.find((provider) => provider.id === wanted) ?? PROVIDERS[0];
}

export function isConnectable(id: unknown): boolean {
  return !get(id).unavailable;
}

export function badge(id: unknown): string {
  return get(id).name;
}

export function usesOAuth(id: unknown): boolean {
  return get(id).auth === "oauth";
}

export function signsInWithMicrosoft(id: unknown): boolean {
  return id === "outlook" || id === "m365";
}

/** The detail line under an account in Settings: JMAP names its server. */
export function detail(id: unknown, account: { jmap?: { sessionUrl?: string } } | null): string {
  const provider = get(id);
  if (provider.id !== "jmap") return provider.name;
  const host = Jmap.sessionHost(account?.jmap?.sessionUrl ?? "");
  return host === "" ? provider.name : provider.name + " · " + host;
}

/** The mailboxes a provider shows, without those `absent` names and those outside the backend's API. */
export function mailboxes(id: unknown, absent?: string[], apiVersion?: number): MailboxEntry[] {
  const drop = (Array.isArray(absent) ? absent : []).map(String);
  return get(id).mailboxes.filter(
    (box) =>
      drop.indexOf(box.key) < 0 &&
      (apiVersion === undefined || Number(apiVersion) >= Number(box.minimumApiVersion || 0)) &&
      (!box.maximumApiVersion || (apiVersion !== undefined && Number(apiVersion) <= box.maximumApiVersion)),
  );
}
