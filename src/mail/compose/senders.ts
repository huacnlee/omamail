// Who a new message may be sent as. Port of omarchy/ui/compose/Senders.js.
//
// One mailbox can have several of its own addresses; several mailboxes can be
// signed in at once. The From list holds both, because a From that only names
// the current mailbox's aliases leaves every other connected account
// unreachable. A reply or forward stays on the mailbox that holds the
// original: sending that draft from a different account would hand another
// server a thread id it has never seen.

/** One row of `account.identities`. */
export interface SendIdentity {
  accountId: string;
  email: string;
  displayName?: string;
  label?: string;
  isDefault?: boolean;
  isPrimary?: boolean;
}

export function visible<T extends { accountId?: unknown }>(rows: readonly T[] | null | undefined, accountId: string, mode: string): T[] {
  const list = Array.isArray(rows) ? rows.slice() : [];
  const kind = String(mode || "new");
  if (kind === "new" || kind === "") return list;
  const wanted = String(accountId || "");
  return list.filter((row) => String(row.accountId ?? "") === wanted);
}

/** The second line of a From row: a name, or a label that is not the address. */
export function subtitle(identity: Partial<SendIdentity> | null | undefined): string {
  const row = identity ?? {};
  const name = String(row.displayName ?? "").trim();
  if (name !== "") return name;
  const label = String(row.label ?? "").trim();
  const email = String(row.email ?? "").trim();
  if (label !== "" && label.toLowerCase() !== email.toLowerCase()) return label;
  return "";
}

function aliasEmail(value: unknown): string {
  const raw = value && typeof value === "object" ? (value as { email?: unknown }).email : value;
  const email = String(raw ?? "").trim().toLowerCase();
  return email.indexOf("@") > 0 ? email : "";
}

/**
 * The address to answer from: the alias a recipient of the original was
 * (To or Cc), else the default, the primary, the first (GmailApi.js
 * preferredSendAs). Reading the original's recipients keeps a thread on the
 * address it was sent to.
 */
export function preferredSendAs<T>(aliases: readonly T[] | null | undefined, recipients: readonly unknown[] | null | undefined): T | null {
  const choices = Array.isArray(aliases) ? aliases : [];
  for (const recipient of Array.isArray(recipients) ? recipients : []) {
    const wanted = aliasEmail(recipient);
    if (!wanted) continue;
    const hit = choices.find((c) => aliasEmail(c) === wanted);
    if (hit) return hit;
  }
  const flag = (c: T, key: "isDefault" | "isPrimary") => !!c && (c as any)[key] === true;
  return choices.find((c) => flag(c, "isDefault")) ?? choices.find((c) => flag(c, "isPrimary")) ?? choices[0] ?? null;
}

/** The alias `email` names, or null: a From not on the list is refused. */
export function sendAsFor<T>(aliases: readonly T[] | null | undefined, email: string): T | null {
  const wanted = aliasEmail(email);
  if (!wanted) return null;
  return (Array.isArray(aliases) ? aliases : []).find((c) => aliasEmail(c) === wanted) ?? null;
}
