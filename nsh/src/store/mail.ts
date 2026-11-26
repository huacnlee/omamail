// The mail screens' shared state. Rust owns accounts and messages; these
// signals are what the screens show of them and what the user picked.
import { resource, signal } from "nsh";
import { Accounts, Mail } from "omamail-native";
import type { MessageRow } from "omamail-native";

export type MailboxId = "inbox" | "unread" | "starred" | "sent" | "drafts" | "archive" | "spam" | "trash";

export const accounts = resource(() => Accounts.list(), { initialValue: [] });

export const accountId = signal<string | null>(null);
export const mailbox = signal<MailboxId>("inbox");
export const selectedId = signal<string | null>(null);

/** The account shown: the one picked, else the first. */
export function currentAccount(): string | null {
  return accountId() ?? accounts()[0]?.id ?? null;
}

/** The open mailbox, first page. Reloads when the account or mailbox changes. */
export const page = resource(
  () => {
    const account = currentAccount();
    return account ? { account, mailbox: mailbox() } : null;
  },
  ({ account, mailbox }) => Mail.list(account, mailbox, "", "", 50),
);

/** Rows of the pages after the first, and the token of the next one. */
const more = signal<{ rows: MessageRow[]; token: string | null }>({ rows: [], token: null });
let loadingMore = false;

/** Every loaded row of the open mailbox, newest first. */
export function rows(): MessageRow[] {
  const first = page()?.messages ?? [];
  const extra = more().rows;
  return extra.length ? [...first, ...extra] : first;
}

/** Loads the next page of the open mailbox, once the list nears its end. */
export async function loadMore() {
  const account = currentAccount();
  const token = more().token ?? page()?.nextPageToken ?? "";
  if (!account || !token || loadingMore) return;
  loadingMore = true;
  const box = mailbox();
  try {
    const next = await Mail.list(account, box, "", token, 50);
    if (box !== mailbox() || account !== currentAccount()) return;
    more.set({ rows: [...more().rows, ...next.messages], token: next.nextPageToken });
  } finally {
    loadingMore = false;
  }
}

/** Moves the selection `step` rows down (negative: up). */
export function moveSelection(step: number) {
  const list = rows();
  if (list.length === 0) return;
  const index = list.findIndex((row) => row.id === selectedId());
  const next = index < 0 ? 0 : Math.min(list.length - 1, Math.max(0, index + step));
  selectedId.set(list[next].id);
}

/** The open message. */
export const detail = resource(
  () => {
    const account = currentAccount();
    const id = selectedId();
    return account && id ? { account, id } : null;
  },
  ({ account, id }) => Mail.read(account, id),
);

export function openMailbox(next: MailboxId) {
  mailbox.set(next);
  selectedId.set(null);
  more.set({ rows: [], token: null });
}

/** Runs `operation` on the open message, then shows the mailbox as the server has it. */
export async function act(operation: "read" | "unread" | "star" | "unstar" | "archive" | "trash") {
  const account = currentAccount();
  const id = selectedId();
  if (!account || !id) return;
  await Mail.act(account, operation, [id]);
  if (operation === "archive" || operation === "trash") selectedId.set(null);
  more.set({ rows: [], token: null });
  page.refetch();
}
