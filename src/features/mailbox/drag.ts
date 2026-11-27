// Dragging messages onto the sidebar. NSH has no in-app drag and drop, so the
// view that drags (the message list) drives this from its own pan gesture,
// in page coordinates, and the sidebar's rows register as targets. A row
// lights up only where `wouldAct` says the drop changes something (port of
// omarchy/ui/account/Drop.js and RowDrag.qml's hit-testing).
//
//   messageDrag.begin(rows)        on pan start, with the dragged messages
//   messageDrag.move(pagePosition) on every pan update
//   const target = messageDrag.end()   on release: null, or what to run
//   messageDrag.cancel()           on Escape or a cancelled pan
//
// The caller runs the action: `target.verb` for a mailbox row ("archive",
// "trash", "spam", "unarchive", "untrash", "star", "markUnread"), or
// `label:<target.key>` for a label row, the action string the Qt list used.
import { computed, signal, type Point, type ViewRef } from "nsh";
import { app } from "../../app/store";
import { verbFor, wouldAct, type DropRow, type DropView } from "../../mail/mailboxes-drop";
import { labelIdOfMailbox } from "../../mail/labels";

export interface DropTarget {
  kind: "mailbox" | "label";
  /** A mailbox key, or a label id. */
  key: string;
  /** The mailbox verb; "" for a label row (apply `label:<key>`). */
  verb: string;
}

interface Registered {
  kind: DropTarget["kind"];
  key: string;
  ref: ViewRef;
}

interface Measured extends Registered {
  x: number;
  y: number;
  width: number;
  height: number;
}

const targets = new Map<string, Registered>();
let measured: Measured[] = [];
let generation = 0;

const rowsSignal = signal<DropRow[] | null>(null);
const overSignal = signal<string>("");
/** Whether the open view can report spam; the sidebar keeps it current. */
const spamSignal = signal<boolean>(true);

function token(kind: DropTarget["kind"], key: string): string {
  return `${kind}:${key}`;
}

/** What is on screen, as the drop rules read it. */
export function dropView(): DropView {
  const labelId = labelIdOfMailbox(app.mailbox());
  return {
    mailboxKey: labelId === "" ? app.mailbox() : "",
    searchQuery: app.query(),
    rawQuery: labelId === "" ? "" : `label:${labelId}`,
    rawLabelId: labelId,
    canReportSpam: spamSignal(),
  };
}

async function measureAll(serial: number) {
  const out: Measured[] = [];
  for (const target of targets.values()) {
    const box = await target.ref.measure().catch(() => null);
    if (!box || serial !== generation) continue;
    out.push({ ...target, x: box.pagePosition.x, y: box.pagePosition.y, width: box.bounds.size.width, height: box.bounds.size.height });
  }
  if (serial === generation) measured = out;
}

export const messageDrag = {
  /** A drag is running. */
  active: computed(() => rowsSignal() !== null),
  /** The row token under the pointer that would take the drop ("mailbox:archive", "label:L1"), or "". */
  over: () => overSignal(),
  isOver(kind: DropTarget["kind"], key: string): boolean {
    return overSignal() === token(kind, key);
  },
  /** Starts a drag of `rows`; measures the rows that could take it. */
  begin(rows: DropRow[]) {
    generation++;
    measured = [];
    rowsSignal.set(rows.slice());
    overSignal.set("");
    void measureAll(generation);
  },
  /** The pointer moved, in the root view's coordinates (a PressEvent's or pan's `pagePosition`). */
  move(point: Point) {
    const rows = rowsSignal();
    if (!rows) return;
    const view = dropView();
    const hit = measured.find(
      (t) => point.x >= t.x && point.x < t.x + t.width && point.y >= t.y && point.y < t.y + t.height,
    );
    overSignal.set(hit && wouldAct(hit.kind, hit.key, view, rows) ? token(hit.kind, hit.key) : "");
  },
  /** The drag ended over the pointer's row: what to run there, or null. */
  end(): DropTarget | null {
    const over = overSignal();
    const view = dropView();
    this.cancel();
    if (over === "") return null;
    const split = over.indexOf(":");
    const kind = over.slice(0, split) as DropTarget["kind"];
    const key = over.slice(split + 1);
    return { kind, key, verb: kind === "mailbox" ? verbFor(key, view) : "" };
  },
  cancel() {
    generation++;
    measured = [];
    rowsSignal.set(null);
    overSignal.set("");
  },
};

/** Registers a sidebar row as a drop target; returns the unregister. Rows call it from their ref. */
export function registerDropTarget(kind: DropTarget["kind"], key: string, ref: ViewRef): () => void {
  const id = token(kind, key);
  targets.set(id, { kind, key, ref });
  return () => {
    if (targets.get(id)?.ref === ref) targets.delete(id);
  };
}

/** The sidebar tells the drag whether the open view's provider can report spam. */
export function setDropSpam(can: boolean) {
  spamSignal.set(can);
}

/** Which mailbox keys can ever take a drop (Drop.js: every verb plus All mail). */
export function isDropMailbox(key: string): boolean {
  return ["inbox", "archive", "trash", "spam", "starred", "unread", "all"].indexOf(key) >= 0;
}
