// What dropping dragged messages on a sidebar row would do. Port of
// omarchy/ui/account/Drop.js: a row accepts a drop only where the drop would
// change something, so a highlighted target is a promise, not a guess.

/** The action a mailbox row runs on the dropped messages. */
const VERBS: Record<string, string> = {
  inbox: "unarchive",
  archive: "archive",
  trash: "trash",
  spam: "spam",
  starred: "star",
  unread: "markUnread",
};

/** What is on screen while the drag runs. */
export interface DropView {
  mailboxKey: string;
  searchQuery: string;
  rawQuery: string;
  rawLabelId: string;
  canReportSpam?: boolean;
}

/** A dragged message, as much of it as the rules read. */
export interface DropRow {
  id: string;
  unread?: boolean;
  starred?: boolean;
  labelIds?: readonly string[];
}

function viewing(view: DropView): boolean {
  return view.rawQuery === "" && view.searchQuery === "";
}

export function wouldAct(kind: "mailbox" | "label", key: string, view: DropView, rows: readonly DropRow[]): boolean {
  if (rows.length === 0) return false;
  if (kind === "mailbox") {
    if (!VERBS[key] && key !== "all") return false;
    if (viewing(view) && view.mailboxKey === key) return false;
    if (key === "spam" && view.canReportSpam === false) return false;
    if (key === "all") return viewing(view) && (view.mailboxKey === "inbox" || view.mailboxKey === "trash");
    if (key === "unread") return rows.some((r) => !r.unread);
    if (key === "starred") return rows.some((r) => !r.starred);
    return true;
  }
  if (view.rawQuery !== "" && view.rawLabelId === key) return false;
  return rows.some((r) => (r.labelIds ?? []).indexOf(key) < 0);
}

/** The action a drop on a mailbox row runs; "" for a row that takes nothing. */
export function verbFor(key: string, view: DropView): string {
  if (key === "all") return view.mailboxKey === "trash" ? "untrash" : "archive";
  return VERBS[key] ?? "";
}
