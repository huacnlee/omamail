// The mail screens' shared state. Rust owns accounts and messages; these
// signals are what the screens show of them and what the user picked.
import { resource, signal } from "nsh";
import { Accounts, Mail } from "omamail-native";

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
}

/** Runs `operation` on the open message, then shows the mailbox as the server has it. */
export async function act(operation: "read" | "unread" | "star" | "unstar" | "archive" | "trash") {
  const account = currentAccount();
  const id = selectedId();
  if (!account || !id) return;
  await Mail.act(account, operation, [id]);
  if (operation === "archive" || operation === "trash") selectedId.set(null);
  page.refetch();
}
