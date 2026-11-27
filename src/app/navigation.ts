// Where the user is and how they got there: a history stack, one entry per
// place. Port of omarchy/ui/account/Navigation.js. Pure, and every mutator
// returns a new array except `pop` of a lone root, which hands back the same
// array: "Back did nothing" is what the window closes on, and identity is the
// cheapest way for the caller to tell.

/** The two places a stack can start; switching between them is `replaceRoot`. */
export const ROOTS = ["list", "calendar"] as const;
/** Drawn over a page rather than instead of it. */
export const OVERLAYS = ["compose", "eventComposer", "help"] as const;
/** Every place there is. */
export const KINDS = [
  "list", "calendar", "reader", "calendarDetail", "settings",
  "picker", "setup", "compose", "eventComposer", "help",
] as const;
export type NavKind = (typeof KINDS)[number];

export interface NavEntry {
  kind: NavKind;
  /** A reader's message id, a form's provider, a draft flag. */
  [field: string]: unknown;
  /** Compose and the event composer: the depth to land on when they close. */
  returnTo?: number;
}

export type NavStack = readonly NavEntry[];

const DEFAULT_KIND: NavKind = "list";

function trimmed(value: unknown): string {
  return String(value ?? "").trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isOverlay(kind: unknown): boolean {
  return (OVERLAYS as readonly string[]).includes(trimmed(kind));
}

function normalizeKind(kind: unknown): NavKind {
  const name = trimmed(kind);
  return (KINDS as readonly string[]).includes(name) ? (name as NavKind) : DEFAULT_KIND;
}

/** `{ kind }` plus what that kind carries, copied; `kind` is written last so a
 * field of that name cannot smuggle an unknown kind past the check. */
export function entry(kind: unknown, fields?: unknown): NavEntry {
  const made: Record<string, unknown> = {};
  if (isObject(fields)) {
    for (const key of Object.keys(fields)) made[key] = fields[key];
  }
  made.kind = normalizeKind(kind);
  return made as NavEntry;
}

/** A fresh array of fresh entries; anything else is the list on its own. */
export function copy(stack: unknown): NavEntry[] {
  const source = Array.isArray(stack) ? stack : [];
  const next: NavEntry[] = [];
  for (const item of source) if (isObject(item)) next.push(entry(item.kind, item));
  if (next.length === 0) next.push(entry(DEFAULT_KIND));
  return next;
}

export function depth(stack: unknown): number {
  return Array.isArray(stack) ? stack.length : 0;
}

export function top(stack: unknown): NavEntry {
  const source = Array.isArray(stack) ? stack : [];
  const last = source.length > 0 ? source[source.length - 1] : null;
  return isObject(last) ? (last as NavEntry) : entry(DEFAULT_KIND);
}

/** Reader over reader, and an overlay over itself, replace rather than
 * lengthen history. A draft records the depth it was raised from. */
export function push(stack: unknown, item: unknown): NavEntry[] {
  const next = copy(stack);
  if (!isObject(item)) return next;
  const added = entry(item.kind, item);
  const above = next[next.length - 1];
  const replaces = (added.kind === "reader" && above.kind === "reader")
    || (isOverlay(added.kind) && above.kind === added.kind);
  if (replaces) next.pop();
  const remembers = added.kind === "compose" || added.kind === "eventComposer";
  if (remembers && typeof added.returnTo !== "number") added.returnTo = next.length;
  next.push(added);
  return next;
}

/** Back. A lone root comes back as the very same array. A `returnTo` is
 * trusted only between the root and one step down. */
export function pop<S extends NavStack>(stack: S): S | NavEntry[];
export function pop(stack: unknown): unknown {
  if (Array.isArray(stack) && stack.length === 1 && isObject(stack[0])) return stack;
  const next = copy(stack);
  if (next.length === 1) return next;
  const leaving = next[next.length - 1];
  let keep = next.length - 1;
  if (typeof leaving.returnTo === "number" && Number.isFinite(leaving.returnTo)) {
    keep = Math.min(keep, Math.floor(leaving.returnTo));
  }
  return next.slice(0, Math.max(1, keep));
}

/** Swap the top without recording a step. */
export function replace(stack: unknown, item: unknown): NavEntry[] {
  const next = copy(stack);
  if (!isObject(item)) return next;
  next[next.length - 1] = entry(item.kind, item);
  return next;
}

/** A new stack of one. */
export function replaceRoot(_stack: unknown, kind: unknown): NavEntry[] {
  return [entry(kind)];
}

/** "Start over" because the list under the stack changed (a search, a
 * mailbox or account switch), not because the user went somewhere. */
export function resetTo(stack: unknown, kind: unknown): NavEntry[] {
  return replaceRoot(stack, kind);
}

/** The topmost entry drawn as a page. */
export function page(stack: unknown): NavEntry {
  const source = Array.isArray(stack) ? stack : [];
  for (let i = source.length - 1; i >= 0; i--) {
    if (isObject(source[i]) && !isOverlay(source[i].kind)) return source[i] as NavEntry;
  }
  return entry(DEFAULT_KIND);
}

/** The topmost overlay, or null. */
export function overlay(stack: unknown): NavEntry | null {
  const source = Array.isArray(stack) ? stack : [];
  for (let i = source.length - 1; i >= 0; i--) {
    if (isObject(source[i]) && isOverlay(source[i].kind)) return source[i] as NavEntry;
  }
  return null;
}

export interface RootState {
  anyReady?: boolean;
  view?: string;
  hasSavedAccounts?: boolean;
  setupUnderway?: boolean;
  provider?: string;
}

/** Where the stack starts. The picker sits under a first-run form, so Back
 * from the form lands on the question it answered. */
export function rootFor(state: unknown): NavEntry[] {
  const value: RootState = isObject(state) ? (state as RootState) : {};
  if (value.anyReady === true) return [entry(trimmed(value.view) === "calendar" ? "calendar" : "list")];
  if (value.hasSavedAccounts === true && value.setupUnderway === true) {
    return [entry("picker"), entry("setup", { provider: trimmed(value.provider), draft: false })];
  }
  return [entry("picker")];
}

export function kinds(stack: unknown): string[] {
  const source = Array.isArray(stack) ? stack : [];
  return source.map((item) => (isObject(item) ? String(item.kind ?? "") : ""));
}
