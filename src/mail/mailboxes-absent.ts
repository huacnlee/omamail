// Which optional rail rows (Archive, Junk, Trash) a JMAP or Microsoft 365
// mailbox lacks, as `mailboxes(provider, absent)` takes them. Ports of
// JmapProtocol.js `resolveRole` / `absentMailboxes` and M365Protocol.js
// `absentMailboxes`. Both answer null while nothing has been read, which draws
// every row; an empty list is the positive answer that all three exist.
// Server text is untrusted: only ids, names and roles are read, as strings.

function trimmed(value: unknown): string {
  return String(value === undefined || value === null ? "" : value).trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The rows that may be absent, and the rail key each answers to (Junk is `spam`). */
const OPTIONAL_RAIL_ROWS = [
  { role: "archive", key: "archive" },
  { role: "junk", key: "spam" },
  { role: "trash", key: "trash" },
] as const;

// The leaf-name guesses for a server that publishes no role on a mailbox it
// plainly means as one (JmapProtocol.js ROLE_NAME_GUESSES). Inbox is never
// guessed: RFC 8621 requires its role.
const ROLE_NAME_GUESSES: Record<string, RegExp> = {
  sent: /^sent( mail| items| messages)?$/,
  trash: /^(trash|deleted( items| messages)?)$/,
  drafts: /^drafts?$/,
  junk: /^(junk([ -]?e-?mail)?|spam|bulk mail)$/,
  archive: /^(archive|all mail)$/,
};

/**
 * The JMAP mailbox a rail role means: the one carrying that role, else a
 * top-level mailbox whose name is one of the guesses, else "".
 */
export function resolveJmapRole(role: string, mailboxes: unknown): string {
  const wanted = trimmed(role).toLowerCase();
  if (wanted === "") return "";
  const list = Array.isArray(mailboxes) ? mailboxes : [];
  for (const box of list) {
    if (isObject(box) && trimmed(box.role).toLowerCase() === wanted) return trimmed(box.id);
  }
  const guess = ROLE_NAME_GUESSES[wanted];
  if (!guess) return "";
  for (const box of list) {
    if (!isObject(box) || trimmed(box.parentId) !== "") continue;
    if (guess.test(trimmed(box.name).toLowerCase())) return trimmed(box.id);
  }
  return "";
}

/** The rail rows a JMAP account has no mailbox for; null while none were read. */
export function jmapAbsentMailboxes(mailboxes: unknown): string[] | null {
  const list = Array.isArray(mailboxes) ? mailboxes : [];
  if (list.length === 0) return null;
  return OPTIONAL_RAIL_ROWS.filter((row) => resolveJmapRole(row.role, list) === "").map((row) => row.key);
}

/** An `m365.verify` answer that proves a session. */
export function m365Verified(result: unknown): result is Record<string, unknown> {
  return isObject(result) && result.ok === true;
}

/** The rail rows whose folder an `m365.verify` answer says is missing; null until one answered with roles. */
export function m365AbsentMailboxes(result: unknown): string[] | null {
  if (!m365Verified(result) || !isObject(result.roles)) return null;
  const roles = result.roles;
  return OPTIONAL_RAIL_ROWS.filter((row) => !isObject(roles[row.role])).map((row) => row.key);
}
