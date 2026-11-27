// Every key this window answers to, in one table. Port of
// omarchy/ui/keys/Keymap.js: the shortcut sheet, the status-bar hints and the
// router (src/keys/router.ts) all read this file, so nothing else describes a
// key and the three cannot drift (docs/KEYS.md).
//
// Sequences keep the Qt spelling the docs use (`Ctrl+1`, `Shift+J`, `Return`)
// so docs/KEYS.md's table stays the one written reference; `nshKeystroke`
// turns each into the keystroke `keymap.bind` takes. `Ctrl+` becomes `mod+`:
// Command on macOS, Control on Linux and Windows, as every app's own
// shortcuts are there.

/** The window is in exactly one of these at a time (`contextFor`). */
export const CONTEXTS = [
  "list", "reader", "search", "compose", "eventCompose", "eventDescription",
  "eventGuests", "page", "calendar", "assistant", "assistantCommands",
] as const;
export type KeyContext = (typeof CONTEXTS)[number];

/** Contexts in which a focused text field is the norm: their bindings fire
 * over the field (`when: "always"`), and the table binds no bare key in them
 * but the few the docs name (Escape, AI send, event save). */
export const TEXT_CONTEXTS: readonly KeyContext[] = [
  "search", "compose", "eventCompose", "eventDescription", "eventGuests", "page", "assistant", "assistantCommands",
];

type ContextName = KeyContext | "*";
const MAIL: ContextName[] = ["list", "reader"];
const ANY: ContextName[] = ["*"];

export interface Binding {
  id: string;
  keys: string[];
  contexts: ContextName[];
  group: string;
  label: string;
  /** Live behind the shortcut sheet (help overlay). */
  survivesOverlay?: boolean;
  /** How the status bar writes the key, when not `displayFor`. */
  hintKey?: string;
  /** The status-bar label, per context (or one for every context). */
  hint?: string | Partial<Record<KeyContext, string>>;
  hintNeedsSelection?: boolean;
  hintUnavailableId?: string;
  /** Where the key is already done, the button is its inverse. */
  inverse?: { action: string; hint: string };
  /** How the sheet writes a range instead of every key. */
  display?: string;
  /** Per-sequence contexts that override `contexts`. */
  sequenceContexts?: Record<string, ContextName[]>;
}

export const BINDINGS: readonly Binding[] = [
  // These survive the shortcut sheet: behind it they scroll it.
  { id: "cursorDown", keys: ["j", "Down"], contexts: MAIL, survivesOverlay: true,
    group: "Moving", label: "Move down", hintKey: "j / k", hint: { list: "move" } },
  { id: "cursorUp", keys: ["k", "Up"], contexts: MAIL, survivesOverlay: true,
    group: "Moving", label: "Move up" },
  { id: "scrollDown", keys: ["Shift+J"], contexts: ["reader"], survivesOverlay: true,
    group: "Moving", label: "Scroll down", hintKey: "Shift+J / Shift+K", hint: { reader: "scroll" } },
  { id: "scrollUp", keys: ["Shift+K"], contexts: ["reader"], survivesOverlay: true,
    group: "Moving", label: "Scroll up" },
  { id: "open", keys: ["Return", "Enter", "o"], contexts: MAIL,
    group: "Moving", label: "Open the selected message", hintKey: "o" },
  { id: "openReader", keys: ["Right"], contexts: ["list"],
    group: "Moving", label: "Open the selected message" },
  { id: "backToList", keys: ["u", "Left"], contexts: ["reader"],
    group: "Moving", label: "Back to the list" },
  // Along the conversation rail; no hint, since only a conversation of two or
  // more has anywhere to go.
  { id: "nextMember", keys: ["n"], contexts: ["reader"],
    group: "Moving", label: "Next message in the conversation" },
  { id: "previousMember", keys: ["p"], contexts: ["reader"],
    group: "Moving", label: "Previous message in the conversation" },

  { id: "archive", keys: ["e"], contexts: MAIL,
    group: "Acting", label: "Archive (in Archive: move to Inbox)",
    hint: { list: "archive", reader: "archive" },
    inverse: { action: "unarchive", hint: "move to inbox" } },
  { id: "trash", keys: ["d"], contexts: MAIL,
    group: "Acting", label: "Move to trash (in the trash: restore)",
    hint: { list: "trash", reader: "trash" },
    inverse: { action: "untrash", hint: "restore" } },
  { id: "star", keys: ["s"], contexts: MAIL, group: "Acting", label: "Star or unstar" },
  { id: "moveToLabel", keys: ["v"], contexts: MAIL,
    group: "Acting", label: "Move to", hint: { list: "move to", reader: "move to" },
    hintNeedsSelection: true, hintUnavailableId: "move" },
  { id: "openInBrowser", keys: ["b"], contexts: MAIL, group: "Acting", label: "Open in browser" },
  { id: "markRead", keys: ["Shift+I"], contexts: MAIL, group: "Acting", label: "Mark read" },
  { id: "markUnread", keys: ["Shift+U"], contexts: MAIL, group: "Acting", label: "Mark unread" },
  { id: "toggleCheck", keys: ["x", "Space"], contexts: MAIL,
    group: "Acting", label: "Select or deselect the message", hintKey: "Space", hint: { list: "select" } },
  { id: "checkAll", keys: ["Ctrl+A"], contexts: ["list"],
    group: "Acting", label: "Select every message loaded, or none" },

  { id: "reply", keys: ["r"], contexts: MAIL, group: "Writing", label: "Reply", hint: { reader: "reply" } },
  { id: "replyAll", keys: ["a"], contexts: MAIL, group: "Writing", label: "Reply to all" },
  { id: "forward", keys: ["f"], contexts: MAIL, group: "Writing", label: "Forward" },
  { id: "compose", keys: ["c"], contexts: MAIL,
    group: "Writing", label: "Compose or edit a draft", hint: { list: "compose" } },
  { id: "createEvent", keys: ["c"], contexts: ["calendar"],
    group: "Calendar", label: "Create an event", hint: { calendar: "create" } },
  { id: "calendarNext", keys: ["j", "Down"], contexts: ["calendar"],
    group: "Calendar", label: "Select the next event", hintKey: "j / k", hint: { calendar: "select" } },
  { id: "calendarPrevious", keys: ["k", "Up"], contexts: ["calendar"],
    group: "Calendar", label: "Select the previous event" },
  { id: "openCalendarEvent", keys: ["Return", "o"], contexts: ["calendar"],
    group: "Calendar", label: "Open the selected event", hintKey: "o", hint: { calendar: "open" } },
  { id: "calendarPreviousPeriod", keys: ["h", "Left"], contexts: ["calendar"],
    group: "Calendar", label: "Previous week or month" },
  { id: "calendarNextPeriod", keys: ["l", "Right"], contexts: ["calendar"],
    group: "Calendar", label: "Next week or month" },
  { id: "calendarToday", keys: ["t"], contexts: ["calendar"], group: "Calendar", label: "Go to today" },
  { id: "calendarWeek", keys: ["w"], contexts: ["calendar"], group: "Calendar", label: "Show week view" },
  { id: "calendarDay", keys: ["d"], contexts: ["calendar"], group: "Calendar", label: "Show day view" },
  { id: "calendarAgenda", keys: ["a"], contexts: ["calendar"], group: "Calendar", label: "Show agenda view" },
  { id: "calendarUndo", keys: ["u"], contexts: ["calendar"],
    group: "Calendar", label: "Undo the last event change", hint: { calendar: "undo" } },
  { id: "calendarMonth", keys: ["m"], contexts: ["calendar"], group: "Calendar", label: "Show month view" },
  { id: "calendarZoomIn", keys: ["Ctrl++", "Ctrl+="], contexts: ["calendar"],
    group: "Calendar", label: "Make hours taller in the day and week views" },
  { id: "calendarZoomOut", keys: ["Ctrl+-"], contexts: ["calendar"],
    group: "Calendar", label: "Make hours shorter in the day and week views" },
  { id: "calendarZoomReset", keys: ["Ctrl+0"], contexts: ["calendar"],
    group: "Calendar", label: "Return to the automatic hour height" },
  { id: "send", keys: ["Ctrl+Return", "Ctrl+Enter"], contexts: ["compose"],
    group: "Writing", label: "Send", hint: { compose: "send" } },
  { id: "saveEvent", keys: ["Return", "Enter", "Ctrl+Return", "Ctrl+Enter"], contexts: ["eventCompose", "eventDescription"],
    sequenceContexts: { Return: ["eventCompose"], Enter: ["eventCompose"] }, hintKey: "Ctrl+Enter",
    group: "Calendar editor", label: "Save and close the event", hint: { eventCompose: "save", eventDescription: "save" } },
  { id: "guestNext", keys: ["Down"], contexts: ["eventGuests"], group: "Calendar editor", label: "Next guest suggestion" },
  { id: "guestPrevious", keys: ["Up"], contexts: ["eventGuests"], group: "Calendar editor", label: "Previous guest suggestion" },
  { id: "guestChoose", keys: ["Return", "Enter"], contexts: ["eventGuests"], group: "Calendar editor", label: "Choose guest suggestion" },
  { id: "undoSend", keys: ["Alt+Z"], contexts: ANY, survivesOverlay: true, group: "Writing", label: "Undo send" },

  { id: "search", keys: ["/"], contexts: MAIL, group: "Finding", label: "Search" },

  // The rail by number: hold Ctrl and every row says which digit opens it.
  // Nine, because Ctrl+0 is reset zoom.
  { id: "goMailbox",
    keys: ["Ctrl+1", "Ctrl+2", "Ctrl+3", "Ctrl+4", "Ctrl+5", "Ctrl+6", "Ctrl+7", "Ctrl+8", "Ctrl+9"],
    contexts: MAIL, group: "Going", label: "Go to that mailbox", display: "Ctrl+1…9" },
  { id: "goAccount",
    keys: ["Alt+1", "Alt+2", "Alt+3", "Alt+4", "Alt+5", "Alt+6", "Alt+7", "Alt+8", "Alt+9", "Alt+0"],
    contexts: ["list", "reader", "calendar"], group: "Going", label: "Go to that email account", display: "Alt+1…0" },
  { id: "switchAccount", keys: ["Alt+A"], contexts: MAIL, group: "Going", label: "Switch account" },
  { id: "askAgent", keys: ["Alt+G"], contexts: ["list", "reader", "compose"],
    group: "Acting", label: "Ask AI about the message or draft" },
  { id: "assistantSend", keys: ["Return", "Enter", "Ctrl+Return", "Ctrl+Enter"], contexts: ["assistant", "assistantCommands"],
    sequenceContexts: { Return: ["assistant"], Enter: ["assistant"] }, group: "AI", label: "Send the AI message" },
  { id: "assistantCommandNext", keys: ["Down"], contexts: ["assistantCommands"], group: "AI", label: "Next command" },
  { id: "assistantCommandPrevious", keys: ["Up"], contexts: ["assistantCommands"], group: "AI", label: "Previous command" },
  { id: "assistantChooseCommand", keys: ["Return", "Enter"], contexts: ["assistantCommands"],
    group: "AI", label: "Complete or run the selected AI command" },

  { id: "calendar", keys: ["Alt+C"], contexts: ["list", "reader", "calendar"],
    group: "Going", label: "Switch between mail and calendar" },
  { id: "mailView", keys: ["Ctrl+Shift+M"], contexts: ["list", "reader", "calendar"], group: "Going", label: "Go to mail" },
  { id: "calendarView", keys: ["Ctrl+Shift+C"], contexts: ["list", "reader", "calendar"], group: "Going", label: "Go to calendar" },
  { id: "toggleSidebar", keys: ["["], contexts: ["list", "reader", "calendar"], group: "Going", label: "Show or hide the sidebar" },

  { id: "zoomIn", keys: ["Ctrl++", "Ctrl+="], contexts: ["reader"], group: "Reading", label: "Zoom the message body in" },
  { id: "zoomOut", keys: ["Ctrl+-"], contexts: ["reader"], group: "Reading", label: "Zoom the message body out" },
  { id: "zoomReset", keys: ["Ctrl+0"], contexts: ["reader"], group: "Reading", label: "Reset the zoom" },

  { id: "refresh", keys: ["F5", "Ctrl+R"], contexts: ANY, group: "Mailbox", label: "Check for mail" },
  { id: "settings", keys: ["Ctrl+,"], contexts: ANY, group: "Mailbox", label: "Open settings" },
  { id: "help", keys: ["?"], contexts: MAIL, survivesOverlay: true, group: "Mailbox", label: "Toggle all keybindings" },
  { id: "back", keys: ["Escape"], contexts: ANY, survivesOverlay: true,
    group: "Mailbox", label: "Back, or close the window",
    hint: { reader: "back", page: "back", compose: "close", eventCompose: "close", eventDescription: "close", search: "leave" } },
];

export type CommandId = string;

/** What decides the context: every field optional, missing is false. */
export interface ContextState {
  assistantEditing?: boolean;
  assistantCommands?: boolean;
  showPage?: boolean;
  eventComposing?: boolean;
  guestSuggestions?: boolean;
  eventDescriptionFocused?: boolean;
  composing?: boolean;
  searchFocused?: boolean;
  calendarVisible?: boolean;
  currentView?: string;
  /** A pending send is not a context of its own. */
  sendPending?: boolean;
}

/** The window's one context, by precedence: a form before anything, a draft
 * before reading, a query being typed before the list under it. */
export function contextFor(state: ContextState | null | undefined): KeyContext {
  const value = state ?? {};
  if (value.assistantEditing) return value.assistantCommands ? "assistantCommands" : "assistant";
  if (value.showPage) return "page";
  if (value.eventComposing) {
    return value.guestSuggestions ? "eventGuests" : value.eventDescriptionFocused ? "eventDescription" : "eventCompose";
  }
  if (value.composing) return "compose";
  if (value.searchFocused) return "search";
  if (value.calendarVisible) return "calendar";
  if (value.currentView === "reader") return "reader";
  return "list";
}

export function byId(id: string): Binding | null {
  return BINDINGS.find((b) => b.id === id) ?? null;
}

/** Which of a row's keys fired, as its position in the row's own list. */
export function slotFor(id: string, sequence: string): number {
  const row = byId(id);
  return row ? row.keys.indexOf(String(sequence ?? "")) : -1;
}

function hasContext(contexts: readonly ContextName[], context: string): boolean {
  return contexts.some((c) => c === "*" || c === context);
}

export function matchesContext(binding: Binding | null, context: string): boolean {
  return !!binding && hasContext(binding.contexts, context);
}

export function matchesSequenceContext(binding: Binding | null, sequence: string, context: string): boolean {
  if (!binding) return false;
  const override = binding.sequenceContexts?.[String(sequence ?? "")];
  return hasContext(override ?? binding.contexts, context);
}

/** Context decides what is live; the help sheet stands down all but the rows
 * that survive it. */
export function isEnabled(binding: Binding | null, context: string, overlay: boolean): boolean {
  if (!matchesContext(binding, context)) return false;
  return !(overlay && !binding!.survivesOverlay);
}

export function isSequenceEnabled(binding: Binding | null, sequence: string, context: string, overlay: boolean): boolean {
  if (!matchesSequenceContext(binding, sequence, context)) return false;
  return !(overlay && !binding!.survivesOverlay);
}

export function bindingsFor(context: string): Binding[] {
  return BINDINGS.filter((b) => matchesContext(b, context));
}

export interface SequenceEntry {
  id: string;
  sequence: string;
  binding: Binding;
}

/** One entry per sequence live in `context`. */
export function sequencesFor(context: string): SequenceEntry[] {
  const out: SequenceEntry[] = [];
  for (const row of BINDINGS) {
    for (const key of row.keys) {
      if (matchesSequenceContext(row, key, context)) out.push({ id: row.id, sequence: key, binding: row });
    }
  }
  return out;
}

/** The sequence as people read keycaps: Return is Enter, Escape is Esc. */
export function readableSequence(sequence: string): string {
  let text = String(sequence ?? "");
  if (text.charAt(text.length - 1) === ",") return text;
  if (text.indexOf(",") > 0) return text.split(",").join(" then ");
  text = text.replace("Return", "Enter");
  if (text === "Escape") return "Esc";
  return text;
}

/** How a row reads on the help sheet: every key that works, once each. */
export function displayFor(binding: Binding | null): string {
  if (!binding) return "";
  if (binding.display) return binding.display;
  const out: string[] = [];
  for (const key of binding.keys) {
    const readable = readableSequence(key);
    if (!out.includes(readable)) out.push(readable);
  }
  return out.join(", ");
}

/** How a row reads on the status bar: one short form. */
export function hintKeyFor(binding: Binding | null): string {
  if (!binding) return "";
  return binding.hintKey ?? displayFor(binding);
}

export function keycapLabel(text: string): string {
  return String(text ?? "").toLowerCase();
}

export function hintTextFor(binding: Binding | null, context: string): string {
  const hint = binding?.hint;
  if (!hint) return "";
  if (typeof hint === "string") return hint;
  return (hint as Record<string, string | undefined>)[context] ?? "";
}

export interface HelpRow { keys: string; action: string }
export interface HelpGroup { name: string; rows: HelpRow[] }

/** The sheet's section order: the mail sections first, the calendar's last. A
 * group not named here follows them, in the order it first appears. */
const GROUP_ORDER = ["Moving", "Acting", "Writing", "Finding", "Going", "AI", "Reading", "Mailbox", "Calendar", "Calendar editor"];

/** The sheet's groups, in GROUP_ORDER, rows in table order. */
export function helpGroups(hidden?: readonly string[]): HelpGroup[] {
  const groups: HelpGroup[] = [];
  const byName = new Map<string, HelpGroup>();
  const omitted = Array.isArray(hidden) ? hidden : [];
  for (const binding of BINDINGS) {
    if (omitted.includes(binding.id)) continue;
    let group = byName.get(binding.group);
    if (!group) {
      group = { name: binding.group, rows: [] };
      byName.set(binding.group, group);
      groups.push(group);
    }
    // Two bindings that do the same thing from different places (Enter in
    // the list or reader, Right in the list) read as one row with every key.
    const same = group.rows.find((row) => row.action === binding.label);
    if (same) {
      for (const key of displayFor(binding).split(", ")) {
        if (!same.keys.split(", ").includes(key)) same.keys += `, ${key}`;
      }
    } else {
      group.rows.push({ keys: displayFor(binding), action: binding.label });
    }
  }
  const rank = (name: string) => {
    const at = GROUP_ORDER.indexOf(name);
    return at < 0 ? GROUP_ORDER.length : at;
  };
  return groups.map((group, at) => ({ group, at }))
    .sort((a, b) => rank(a.group.name) - rank(b.group.name) || a.at - b.at)
    .map((entry) => entry.group);
}

export interface Hint { key: string; label: string }

/** What the status bar offers from where the user stands. `unavailable`: ids
 * the provider cannot honour; `actions`: what a binding with an inverse will
 * ask for, by binding id. */
export function hintsFor(context: string, unavailable?: readonly string[], hasSelection?: boolean,
  actions?: Record<string, string> | null): Hint[] {
  const out: Hint[] = [];
  const missing = Array.isArray(unavailable) ? unavailable : [];
  const asked = actions && typeof actions === "object" ? actions : {};
  for (const row of bindingsFor(context)) {
    if (row.hintNeedsSelection && hasSelection !== true) continue;
    if (missing.includes(row.hintUnavailableId ?? row.id)) continue;
    let text = hintTextFor(row, context);
    if (text !== "" && row.inverse && asked[row.id] === row.inverse.action) text = row.inverse.hint;
    if (text !== "") out.push({ key: hintKeyFor(row), label: text });
  }
  return out;
}

/** A heading costs a line as surely as a row does. */
export function helpWeight(group: HelpGroup | null): number {
  return (group && Array.isArray(group.rows) ? group.rows.length : 0) + 1;
}

/** The help groups in `count` columns, split in order, never splitting a group. */
export function helpColumns(count: number, hidden?: readonly string[]): HelpGroup[][] {
  const groups = helpGroups(hidden);
  const columns = Math.max(1, Math.min(groups.length, Math.floor(Number(count)) || 1));
  const out: HelpGroup[][] = [];
  for (let c = 0; c < columns; c++) out.push([]);
  if (columns === 1) {
    out[0] = groups;
    return out;
  }
  let total = 0;
  for (const g of groups) total += helpWeight(g);
  let at = 0;
  let used = 0;
  let placed = 0;
  for (let g = 0; g < groups.length; g++) {
    const left = groups.length - g;
    const free = columns - at;
    const target = (total - placed) / free;
    const nextWeight = helpWeight(groups[g]);
    if (at < columns - 1 && out[at].length > 0
      && (left <= free - 1 || Math.abs(used - target) <= Math.abs(used + nextWeight - target))) {
      placed += used;
      at++;
      used = 0;
    }
    out[at].push(groups[g]);
    used += helpWeight(groups[g]);
  }
  return out;
}

export interface Conflict { context: string; keys: string; ids: [string, string] }

/** Two rows claiming one sequence in one context. */
export function conflicts(): Conflict[] {
  const found: Conflict[] = [];
  for (const context of CONTEXTS) {
    const seen = new Map<string, string>();
    for (const row of sequencesFor(context)) {
      const prior = seen.get(row.sequence);
      if (prior) found.push({ context, keys: row.sequence, ids: [prior, row.id] });
      else seen.set(row.sequence, row.id);
    }
  }
  return found;
}

// ------------------------------------------------------------ nsh keystrokes

const NAMED: Record<string, string> = {
  return: "enter", enter: "enter", escape: "escape", space: "space", up: "up", down: "down",
  left: "left", right: "right", "+": "plus", "=": "plus", "-": "minus", "?": "shift+/",
};

/** The `keymap.bind` keystroke for a Qt-spelled sequence: `Ctrl+1` →
 * `mod+1`, `Shift+J` → `shift+j`, `?` → `shift+/`, `Ctrl++` → `mod+plus`.
 * Two sequences of a row may meet in one keystroke (Return and the numpad's
 * Enter); the router binds it once. */
export function nshKeystroke(sequence: string): string {
  const text = String(sequence ?? "");
  // The key is the last `+`-separated part, except that `+` itself is a key.
  let key: string;
  let mods: string[];
  if (text.endsWith("++")) {
    key = "+";
    mods = text.slice(0, -2).split("+").filter(Boolean);
  } else if (text === "+") {
    key = "+";
    mods = [];
  } else {
    const parts = text.split("+");
    key = parts.pop() ?? "";
    mods = parts;
  }
  const modifiers = mods.map((m) => {
    const lower = m.toLowerCase();
    if (lower === "ctrl" || lower === "control") return "mod";
    if (lower === "meta") return "cmd";
    return lower;
  });
  let name = NAMED[key.toLowerCase()] ?? key.toLowerCase();
  if (name.startsWith("shift+")) {
    if (!modifiers.includes("shift")) modifiers.push("shift");
    name = name.slice("shift+".length);
  }
  const order = ["mod", "cmd", "ctrl", "alt", "shift"];
  modifiers.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...modifiers, name].join("+");
}

/** Whether a sequence is a bare key (no Ctrl, Alt, Meta, nor a function key). */
export function isBare(sequence: string): boolean {
  return !/(^|\+)(Ctrl|Alt|Meta)\+/.test(sequence) && !/^F[0-9]+$/.test(sequence);
}
