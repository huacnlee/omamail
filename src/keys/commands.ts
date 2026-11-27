// How features answer the shared keymap without owning a key. The router
// (src/keys/router.ts) binds each sequence live in the current context and,
// when one fires, runs the newest handler registered for its binding id.
// Features register while their surface is mounted; a registration made while
// a component renders goes with the component (`cleanup`).
//
//   registerCommand("archive", () => list.archiveCursor());
//   registerCommand("goMailbox", ({ slot }) => sidebar.openSlot(slot));
//   reportKeyState(() => ({ assistantEditing: focused() }));
//   registerEscape(() => (menuOpen() ? (closeMenu(), true) : false));
//
// The shell itself handles the navigation ids (back, help, search, settings,
// toggleSidebar, calendar, mailView, calendarView, backToList, openReader when
// nothing else claims them).
import { cleanup, computed, signal } from "nsh";
import type { ContextState } from "./keymap";

export interface CommandEvent {
  /** The binding id that fired. */
  id: string;
  /** Which of the row's keys fired, its index in `Binding.keys`. */
  slot: number;
  /** The sequence as the table spells it (`Ctrl+1`). */
  sequence: string;
}

export type CommandHandler = (event: CommandEvent) => void;

const handlers = new Map<string, CommandHandler[]>();
const revision = signal(0);

/** Ties `remove` to the component or effect running now, if any: a
 * registration made at module level stays until removed by hand. */
function scoped(remove: () => void) {
  try {
    cleanup(remove);
  } catch {
    // No owner: the caller keeps the remover.
  }
}

function removeFrom<T>(list: T[], item: T) {
  const at = list.lastIndexOf(item);
  if (at >= 0) list.splice(at, 1);
}

/** Answer a binding id; the newest registration wins until it is removed.
 * Returns the function that removes it (also run when the component that
 * registered it goes). */
export function registerCommand(id: string, handler: CommandHandler): () => void {
  const list = handlers.get(id) ?? [];
  list.push(handler);
  handlers.set(id, list);
  revision.update((n) => n + 1);
  let done = false;
  const remove = () => {
    if (done) return;
    done = true;
    removeFrom(list, handler);
    revision.update((n) => n + 1);
  };
  scoped(remove);
  return remove;
}

/** Whether something answers `id` (reactive). */
export function hasCommand(id: string): boolean {
  revision();
  return (handlers.get(id)?.length ?? 0) > 0;
}

/** Runs the newest handler of `id`; false when nothing answers it. */
export function runCommand(id: string, slot = 0, sequence = ""): boolean {
  const list = handlers.get(id);
  const handler = list && list[list.length - 1];
  if (!handler) return false;
  handler({ id, slot, sequence });
  return true;
}

// ------------------------------------------------------------ key context

/** What a feature knows about where the keyboard is (docs/KEYS.md's
 * `contextFor` inputs) and what the status bar should offer. */
export interface KeyReport extends ContextState {
  /** Action ids the open provider cannot honour (hint rows drop them). */
  unavailable?: string[];
  /** What `e`/`d` will ask for on the cursor row, by binding id. */
  actions?: Record<string, string>;
  /** The mail list is checking for mail (header refresh spinner). */
  listLoading?: boolean;
  /** A search is running on the server (search bar spinner). */
  serverSearching?: boolean;
  /** What is still in flight (sends, queued actions), one line. */
  activity?: string;
  /** The last error the status bar should say, until cleared. */
  lastError?: string;
  /** A calendar is available to this account (menu row, Alt+C). */
  calendarAvailable?: boolean;
  /** The open account has a web inbox to open. */
  canOpenWebInbox?: boolean;
  /** The AI assistant exists here (false hides its rows on the help sheet). */
  hasAgent?: boolean;
  /** The assistant dock's width, in points: the mail area is the window less it. */
  assistantWidth?: number;
}

const reports = signal<Array<() => KeyReport>>([]);

/** Report part of the key state while the calling component is mounted.
 * Boolean fields are OR-ed across reports; lists are joined; the newest
 * report wins for the rest. */
export function reportKeyState(report: () => KeyReport): () => void {
  reports.update((list) => [...list, report]);
  let done = false;
  const remove = () => {
    if (done) return;
    done = true;
    reports.update((list) => list.filter((r) => r !== report));
  };
  scoped(remove);
  return remove;
}

/** Every report merged (reactive). */
export const keyReport = computed<KeyReport>(() => {
  const merged: Record<string, unknown> = {};
  for (const read of reports()) {
    const part = read() as Record<string, unknown>;
    for (const key of Object.keys(part)) {
      const value = part[key];
      if (value === undefined) continue;
      const prior = merged[key];
      if (typeof value === "boolean") merged[key] = prior === true || value;
      else if (Array.isArray(value)) merged[key] = [...(Array.isArray(prior) ? prior : []), ...value];
      else merged[key] = value;
    }
  }
  return merged as KeyReport;
});

// ------------------------------------------------------------ Escape layers

const escapes: Array<() => boolean> = [];

/** A layer Escape closes before it goes back: guest suggestions, a calendar
 * preview, the assistant's commands or history, a compose agent. Return true
 * when it handled the key. Newest first. */
export function registerEscape(handler: () => boolean): () => void {
  escapes.push(handler);
  let done = false;
  const remove = () => {
    if (done) return;
    done = true;
    removeFrom(escapes, handler);
  };
  scoped(remove);
  return remove;
}

/** Offers Escape to the layers, newest first; true when one took it. */
export function runEscapeLayers(): boolean {
  for (let i = escapes.length - 1; i >= 0; i--) {
    if (escapes[i]()) return true;
  }
  return false;
}

// ---------------------------------------------------------------- key layers
//
// A popup that walks its own rows (the app menu's j / k) takes a few keys
// while it is open: the router binds the newest layer's keystrokes, in NSH
// keystroke form ("j", "down", "enter"), over the table's, in every context.

export type KeyLayer = Record<string, () => void>;

const layers = signal<KeyLayer[]>([]);

/** Takes `keys` until the returned function runs, or the caller's owner goes. */
export function pushKeyLayer(keys: KeyLayer): () => void {
  layers.update((list) => [...list, keys]);
  let done = false;
  const remove = () => {
    if (done) return;
    done = true;
    layers.update((list) => list.filter((layer) => layer !== keys));
  };
  scoped(remove);
  return remove;
}

/** The newest layer, or null (reactive). */
export const keyLayer = computed<KeyLayer | null>(() => {
  const list = layers();
  return list.length > 0 ? list[list.length - 1] : null;
});

/** For tests: drops the escape layers, key layers and key reports left by
 * earlier tests (an owner-less registration has no cleanup to run). Commands
 * stay: features register theirs once, at import. */
export function resetKeyStateForTests(): void {
  escapes.length = 0;
  layers.set([]);
  reports.set([]);
}
