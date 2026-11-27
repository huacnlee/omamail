// Labels and folders as the rail, the pickers and the label menu see them.
// Port of the label half of omarchy/ui/account/Model.js: the tree the rail
// draws, the numbered slots, the move destinations, the path helpers and the
// watched-id migration. Pure functions; the store in
// src/features/mailbox/store.ts owns the lists they are given.
//
// Everything here reads label names, which the server chose: they are data
// for plain-text display and comparison, never markup or routing.

/** A label or folder as a provider reported it. */
export interface Label {
  id: string;
  name?: string;
  rawName?: string;
  system?: boolean;
  unread?: number;
  total?: number;
  /** The server's nesting separator: absent means "/", "" means flat (IMAP NIL). */
  delimiter?: string | null;
  [key: string]: unknown;
}

/** One row of the rail's label tree. */
export interface LabelRow {
  /** "" for an ancestor no label names. */
  id: string;
  rawName: string;
  /** The row's own segment. */
  name: string;
  path: string;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  /** False for an ancestor no label names: it folds, it does not open. */
  selectable: boolean;
  /** The label's own count, or its subtree's while folded. */
  unread: number;
}

export interface Mailbox {
  key: string;
  label: string;
  icon?: string;
}

export type Slot =
  | { kind: "mailbox"; key: string; name: string; icon: string }
  | { kind: "label"; id: string; name: string };

/** What the window shows the label view under: "label:<id>" in app.mailbox(). */
export const LABEL_PREFIX = "label:";

export function labelMailboxKey(id: string): string {
  return LABEL_PREFIX + id;
}

/** The label id of a mailbox key, or "" when the key names a mailbox. */
export function labelIdOfMailbox(key: string): string {
  const text = String(key ?? "");
  return text.startsWith(LABEL_PREFIX) ? text.slice(LABEL_PREFIX.length) : "";
}

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function sepOf(delimiter: unknown): string {
  return delimiter === undefined || delimiter === null ? "/" : String(delimiter);
}

function list<T>(value: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(value) ? value : [];
}

export function indexById(items: readonly ({ id?: unknown } | null | undefined)[] | null | undefined, id: string): number {
  const all = list(items);
  for (let i = 0; i < all.length; i++) if (all[i] && str(all[i]!.id) === id) return i;
  return -1;
}

/** The separator a provider nests with: its own, "/" when it said nothing, "" for none. */
export function labelDelimiter(label: { delimiter?: unknown } | null | undefined): string {
  if (!label || label.delimiter === undefined || label.delimiter === null) return "/";
  return String(label.delimiter);
}

/** Adds or removes `id`; an empty id changes nothing. A new array either way. */
export function toggleId(ids: readonly string[] | null | undefined, id: string): string[] {
  const out = list(ids).slice();
  const key = str(id);
  if (key === "") return out;
  const at = out.indexOf(key);
  if (at >= 0) out.splice(at, 1);
  else out.push(key);
  return out;
}

export const togglePath = toggleId;

/** A count as a badge writes it: "" for none, `cap+` past the cap. */
export function badgeText(count: number, cap = 99): string {
  const value = Math.max(0, Math.floor(Number(count) || 0));
  const limit = Math.max(1, Math.floor(Number(cap) || 99));
  if (value === 0) return "";
  return value > limit ? `${limit}+` : String(value);
}

interface Node {
  name: string;
  path: string;
  label: Label | null;
  unread: number;
  children: Map<string, Node>;
}

/**
 * The rail's tree: children under parents, a missing ancestor a row of its
 * own, siblings A to Z case-folded, folded children left out. `keep` lets a
 * system label through (the move picker's Inbox on a folder provider).
 */
export function labelTree(
  labels: readonly (Label | null)[] | null | undefined,
  collapsedPaths?: readonly string[] | null,
  keep?: (label: Label) => boolean,
): LabelRow[] {
  const folded = list(collapsedPaths);
  // A Map, so a label named "constructor" or "__proto__" is a label.
  const root: Node = { name: "", path: "", label: null, unread: 0, children: new Map() };
  for (const label of list(labels)) {
    if (!label || (label.system && !(keep && keep(label)))) continue;
    const delimiter = labelDelimiter(label);
    const full = str(label.name || label.rawName);
    if (full === "") continue;
    const parts = delimiter === "" ? [full] : full.split(delimiter);
    let node = root;
    let path = "";
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      if (part === "" && p > 0) continue;
      path = path === "" ? part : path + delimiter + part;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path, label: null, unread: 0, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.label = label;
    node.unread = Math.max(0, Math.floor(Number(label.unread) || 0));
  }

  const subtree = (node: Node): number => {
    let sum = node.unread;
    for (const child of node.children.values()) sum += subtree(child);
    return sum;
  };

  const out: LabelRow[] = [];
  const walk = (node: Node, depth: number) => {
    const names = [...node.children.keys()].sort((a, b) => {
      const left = a.toLowerCase();
      const right = b.toLowerCase();
      return left < right ? -1 : left > right ? 1 : 0;
    });
    for (const name of names) {
      const child = node.children.get(name)!;
      const hasChildren = child.children.size > 0;
      const expanded = !hasChildren || folded.indexOf(child.path) < 0;
      out.push({
        id: child.label ? str(child.label.id) : "",
        rawName: child.label ? str(child.label.rawName || child.label.name) : "",
        name: child.name,
        path: child.path,
        depth,
        hasChildren,
        expanded,
        selectable: !!child.label,
        unread: expanded ? child.unread : subtree(child),
      });
      if (expanded) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** The labels in the rail's order, folded rows left out: what the digits number. */
export function visibleLabels(labels: readonly (Label | null)[] | null | undefined, collapsedPaths?: readonly string[] | null): Label[] {
  const byId = new Map<string, Label>();
  for (const label of list(labels)) if (label && !byId.has(str(label.id))) byId.set(str(label.id), label);
  const out: Label[] = [];
  for (const row of labelTree(labels, collapsedPaths)) {
    if (!row.selectable) continue;
    const label = byId.get(row.id);
    if (label) out.push(label);
  }
  return out;
}

/** One numbered list over the rail: mailboxes, then the labels as given; `limit` rows at most. */
export function sidebarSlots(
  mailboxes: readonly (Mailbox | null)[] | null | undefined,
  labels: readonly (Label | null)[] | null | undefined,
  limit: number,
): Slot[] {
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  const out: Slot[] = [];
  for (const box of list(mailboxes)) {
    if (out.length >= max) break;
    if (!box || !box.key) continue;
    out.push({ kind: "mailbox", key: str(box.key), name: str(box.label), icon: str(box.icon || "mail") });
  }
  for (const label of list(labels)) {
    if (out.length >= max) break;
    if (!label || label.system === true) continue;
    out.push({ kind: "label", id: str(label.id), name: str(label.rawName || label.name) });
  }
  return out;
}

/** The one-based number a row's chip shows, 0 for a row past the last. */
export function slotNumberOf(slots: readonly Slot[] | null | undefined, kind: Slot["kind"], handle: string): number {
  const all = list(slots);
  for (let i = 0; i < all.length; i++) {
    const slot = all[i];
    if (slot.kind !== kind) continue;
    if ((slot.kind === "mailbox" ? slot.key : slot.id) !== str(handle)) continue;
    return i + 1;
  }
  return 0;
}

/** A to Z by name, case folded, then by id so two that print the same never swap. */
export function compareLabelNames(left: Label | null, right: Label | null): number {
  const a = str(left?.name).toLowerCase();
  const b = str(right?.name).toLowerCase();
  if (a !== b) return a < b ? -1 : 1;
  const x = str(left?.id);
  const y = str(right?.id);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The user's own labels, A to Z: no system label, the given list untouched. */
export function railLabels(labels: readonly (Label | null)[] | null | undefined): Label[] {
  return list(labels).filter((l): l is Label => !!l && l.system !== true).sort(compareLabelNames);
}

export function isInboxLabel(label: Label | null | undefined): boolean {
  return str(label && (label.id || label.name)).toLowerCase() === "inbox";
}

function movableKeep(folders: boolean | undefined): (label: Label) => boolean {
  return folders === true ? isInboxLabel : () => false;
}

/** A move destination: the label plus where the picker draws it. */
export type MovableLabel = Label & { depth: number; leaf: string; score?: number; sourceIndex?: number };

/**
 * Where a message can be moved. Nothing typed: the tree, a child stepped in
 * under its parent. Typed: the best matches first, flat, by whole path. The
 * label on screen is never one; on a folder provider the Inbox is.
 */
export function movableLabels(
  labels: readonly (Label | null)[] | null | undefined,
  query: string,
  currentLabelId = "",
  folders = false,
): MovableLabel[] {
  const candidates = list(labels);
  const typed = str(query).trim();
  const current = str(currentLabelId);
  const keep = movableKeep(folders);
  const out: MovableLabel[] = [];
  if (typed === "") {
    for (const row of labelTree(candidates, [], keep)) {
      if (!row.selectable || row.id === current) continue;
      const at = indexById(candidates, row.id);
      if (at < 0) continue;
      out.push({ ...candidates[at]!, depth: row.depth, leaf: row.name });
    }
    return out;
  }
  candidates.forEach((label, i) => {
    if (!label || (label.system === true && !keep(label))) return;
    if (str(label.id) === current) return;
    const name = str(label.name);
    const score = fuzzyScore(typed, name);
    if (score <= 0) return;
    out.push({ ...label, depth: 0, leaf: name, score, sourceIndex: i });
  });
  out.sort((a, b) => b.score! - a.score! || a.leaf.length - b.leaf.length || a.sourceIndex! - b.sourceIndex!);
  return out;
}

// ------------------------------------------------------------ label names

export function labelLeaf(path: string, delimiter?: string | null): string {
  const text = str(path);
  const sep = sepOf(delimiter);
  if (sep === "") return text;
  const at = text.lastIndexOf(sep);
  return at < 0 ? text : text.slice(at + sep.length);
}

export function labelParent(path: string, delimiter?: string | null): string {
  const text = str(path);
  const sep = sepOf(delimiter);
  if (sep === "") return "";
  const at = text.lastIndexOf(sep);
  return at < 0 ? "" : text.slice(0, at);
}

export function labelPathJoin(parent: string, leaf: string, delimiter?: string | null): string {
  const head = str(parent);
  const tail = str(leaf).trim();
  const sep = sepOf(delimiter);
  if (head === "" || sep === "") return tail;
  return head + sep + tail;
}

/** Why a typed name cannot be a label, or "". */
export function labelNameProblem(name: string, delimiter?: string | null): string {
  const text = str(name).trim();
  const sep = sepOf(delimiter);
  if (text === "") return "A label needs a name";
  if (sep !== "" && text.indexOf(sep) >= 0) return `A name cannot contain ${sep}; use New sub-label to nest`;
  return "";
}

/** What a flat server says to nesting, or "" where nesting works. */
export function labelNestProblem(parentPath: string, delimiter?: string | null): string {
  const sep = sepOf(delimiter);
  if (sep !== "" || str(parentPath) === "") return "";
  return `This server keeps its folders in one flat list, so nothing can go under ${parentPath}`;
}

export interface MoveTarget {
  id: string;
  name: string;
  path: string;
}

/** Where a label may move: the top level, then every label not itself, beneath it or its parent. */
export function labelMoveTargets(labels: readonly (Label | null)[] | null | undefined, movingPath: string, delimiter?: string | null): MoveTarget[] {
  const sep = sepOf(delimiter);
  const moving = str(movingPath);
  const out: MoveTarget[] = [{ id: "", name: "Top level", path: "" }];
  if (sep === "") return out;
  for (const label of list(labels)) {
    if (!label || label.system) continue;
    const path = str(label.name || label.rawName);
    if (path === "" || path === moving) continue;
    if (moving !== "" && path.indexOf(moving + sep) === 0) continue;
    if (path === labelParent(moving, sep)) continue;
    out.push({ id: str(label.id), name: path, path });
  }
  return out;
}

/** A rename, move or delete (`newPath` "") waiting for the next listing. */
export interface LabelMove {
  before: readonly (Label | null)[];
  oldPath: string;
  newPath: string;
  delimiter?: string | null;
}

/**
 * The watched ids after the queued path changes, resolved against the final
 * listing. A watch follows a renamed path to its new id and is dropped when
 * the label went. The same array comes back when nothing changed.
 */
export function migrateMonitoredChanges(
  monitored: readonly string[] | null | undefined,
  moves: readonly LabelMove[],
  after: readonly (Label | null)[] | null | undefined,
): string[] {
  const ids = list(monitored) as string[];
  const now = list(after);
  const pathOf = (label: Label | null | undefined) => (label ? str(label.name || label.rawName) : "");
  const out: string[] = [];
  for (const raw of ids) {
    const id = str(raw);
    if (id === "") continue;
    if (indexById(now, id) >= 0) {
      out.push(id);
      continue;
    }
    let path = "";
    for (const move of moves) {
      const before = list(move.before);
      if (path === "") {
        const old = indexById(before, id);
        if (old >= 0) path = pathOf(before[old]);
      }
      const from = str(move.oldPath);
      const to = str(move.newPath);
      const sep = sepOf(move.delimiter);
      if (from !== "" && path !== "" && (path === from || (sep !== "" && path.indexOf(from + sep) === 0))) {
        if (to === "") {
          path = "";
          break;
        }
        path = to + path.slice(from.length);
      }
    }
    if (path === "") continue;
    for (const label of now) {
      if (label && pathOf(label) === path && str(label.id) !== "") {
        if (out.indexOf(str(label.id)) < 0) out.push(str(label.id));
        break;
      }
    }
  }
  if (out.length === ids.length && out.every((v, i) => v === ids[i])) return ids;
  return out;
}

export function migrateMonitoredIds(
  monitored: readonly string[] | null | undefined,
  before: readonly (Label | null)[],
  after: readonly (Label | null)[],
  oldPath: string,
  newPath: string,
  delimiter?: string | null,
): string[] {
  return migrateMonitoredChanges(monitored, [{ before, oldPath, newPath, delimiter }], after);
}

/** "3 new in Receipts", or the two that grew most and how many more. */
export function monitoredNote(grown: readonly { name: string; delta: number }[] | null | undefined): string {
  const all = list(grown).slice();
  if (all.length === 0) return "";
  all.sort((a, b) => Number(b.delta || 0) - Number(a.delta || 0));
  const parts = all.slice(0, 2).map((g) => `${Math.max(1, Math.floor(Number(g.delta) || 1))} new in ${str(g.name)}`);
  const more = all.length - parts.length;
  return parts.join(", ") + (more > 0 ? ` and ${more} more` : "");
}

// ------------------------------------------------------------ type to find

const WORD_BREAK = /[^a-z0-9]/;

/** How well typed letters name a text: in order, case folded; 0 is no match. */
export function fuzzyScore(query: string, text: string): number {
  const needle = str(query).toLowerCase().replace(/\s+/g, "");
  const hay = str(text).toLowerCase();
  if (needle === "") return 1;
  if (hay === "") return 0;
  const at = hay.indexOf(needle);
  if (at >= 0) return 1000 - at + (at === 0 || WORD_BREAK.test(hay.charAt(at - 1)) ? 200 : 0);
  let score = 0;
  let from = 0;
  let last = -2;
  for (const letter of needle) {
    const found = hay.indexOf(letter, from);
    if (found < 0) return 0;
    score += 10;
    if (found === last + 1) score += 8;
    if (found === 0 || WORD_BREAK.test(hay.charAt(found - 1))) score += 12;
    last = found;
    from = found + 1;
  }
  return score;
}

/** The rows a query keeps, best first, each with its `sourceIndex`; nothing typed keeps all in order. */
export function filterRows<T extends { name?: unknown; label?: unknown; email?: unknown }>(
  rows: readonly (T | null)[] | null | undefined,
  query: string,
): (T & { sourceIndex: number; score: number })[] {
  const typed = str(query).trim();
  const out: (T & { sourceIndex: number; score: number })[] = [];
  list(rows).forEach((row, i) => {
    if (!row) return;
    const text = [row.name, row.label, row.email].filter((v) => v !== undefined && v !== null && str(v) !== "").join(" ");
    const score = typed === "" ? 1 : fuzzyScore(typed, text);
    if (score <= 0) return;
    out.push({ ...row, sourceIndex: i, score });
  });
  if (typed !== "") out.sort((a, b) => b.score - a.score || a.sourceIndex - b.sourceIndex);
  return out;
}

/** A step through `count` rows that wraps at both ends. */
export function wrappedIndex(index: number, delta: number, count: number): number {
  const total = Math.max(0, Math.floor(Number(count) || 0));
  if (total === 0) return 0;
  const from = Math.floor(Number(index) || 0);
  const step = Math.floor(Number(delta) || 0);
  return (((from + step) % total) + total) % total;
}
