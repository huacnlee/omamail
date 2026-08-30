// @ts-check

import { BINDINGS, CONTEXTS } from "./keymap.js";

const CONTEXT_NAMES = Object.freeze({
  list: "MailList",
  reader: "MailReader",
  search: "MailSearch",
  compose: "Compose",
  page: "Page",
  calendar: "Calendar",
});

// The shortcut sheet's own context, and the whole of `survivesOverlay` in this
// host.
//
// It is not a seventh context the window can be in: it is the layer standing
// over whichever of the six is underneath. `KeyRouter` implements the guard by
// disabling every Shortcut the table does not mark `survivesOverlay`; gpui has
// no such switch, so the sheet takes the keyboard instead and the mailbox's own
// context element drops off the focus path — and the four rows that survive are
// the four bound here as well. `help` and `back` keep their own meaning because
// they are how the sheet goes away; `cursorDown` and `cursorUp` are handed to
// the sheet, to scroll it.
export const OVERLAY_CONTEXT = "Overlay";

const KEY_NAMES = Object.freeze({
  Down: "down",
  Up: "up",
  Left: "left",
  Right: "right",
  Return: "enter",
  Escape: "escape",
});

// What this host installs a handler for, and so what its sheet may promise.
//
// A key is not a button, and neither is a row on the shortcut sheet: the sheet
// renders every binding in the table, so a binding this window installs no
// handler for is a key the sheet documents and nothing answers. This is the set
// the bindings are built from and the set the sheet is drawn from, which is what
// keeps those two the same list.
//
// `search` is the one row of the table that is not here. gpui's `Input` builds
// its own focus handle and takes none, so nothing in this host can move the
// keyboard into the search field: `/` would look bound and do nothing. The field
// is on the header strip and takes a click.
export const HANDLED_ACTIONS = new Set([
  "cursorDown",
  "cursorUp",
  "open",
  "backToList",
  "back",
  "compose",
  "archive",
  "trash",
  "star",
  "spam",
  "markRead",
  "markUnread",
  "reply",
  "replyAll",
  "forward",
  "calendar",
  "calendarView",
  "mailView",
  "send",
  "undoSend",
  "createEvent",
  "calendarNext",
  "calendarPrevious",
  "openCalendarEvent",
  "calendarPreviousPeriod",
  "calendarNextPeriod",
  "calendarToday",
  "calendarWeek",
  "calendarMonth",
  "settings",
  "help",
  "refresh",
  "toggleSidebar",
  "switchAccount",
  "goMailbox",
  "goAccount",
  "zoomIn",
  "zoomOut",
  "zoomReset",
  "copyBody",
  "selectAll",
]);

/** @param {string} sequence */
export function gpuiKeystroke(sequence) {
  let rest = String(sequence);
  const modifiers = [];
  // `Ctrl` is `secondary`, not `cmd`. gpui reads `cmd` as the *platform*
  // modifier, which on Linux is Super — so every Ctrl binding in the keymap was
  // installed on Super, where Hyprland takes it first and it never arrives.
  // `secondary` is gpui's own name for "cmd on macOS, ctrl everywhere else",
  // which is exactly what the keymap means. `Meta` really is the platform key.
  const prefixes = [
    ["Ctrl+", "secondary"],
    ["Alt+", "alt"],
    ["Shift+", "shift"],
    ["Meta+", "cmd"],
  ];
  let matched = true;
  while (matched) {
    matched = false;
    for (const [prefix, name] of prefixes) {
      if (rest.startsWith(prefix)) {
        modifiers.push(name);
        rest = rest.slice(prefix.length);
        matched = true;
        break;
      }
    }
  }
  const key = /** @type {Record<string, string>} */ (KEY_NAMES)[rest] ?? rest.toLowerCase();
  return [...modifiers, key].join("-");
}

/** @param {any} binding @param {string} sequence */
function contextsFor(binding, sequence) {
  const declared = binding.sequenceContexts?.[sequence] ?? binding.contexts ?? [];
  return declared.includes("*") ? CONTEXTS : declared;
}

// The two numbered rows, whose ten keys mean ten different things.
//
// GPUI hands an `on_action` handler the action's name and nothing else — no
// keystroke — so ten keys sharing one action are ten keys the window cannot
// tell apart, and `Ctrl+3` has to be able to say three. The keymap still holds
// one row: the slot rides in the action's own name, which is the only channel
// there is, and `mail::goMailbox::2` is what the window listens for.
const SLOTTED = new Set(["goMailbox", "goAccount"]);

/** @param {any} binding @param {number} slot */
export function actionNameFor(binding, slot) {
  const id = typeof binding === "string" ? binding : String(binding.id);
  return SLOTTED.has(id) ? `mail::${id}::${slot}` : `mail::${id}`;
}

/** @param {ReadonlySet<string>|undefined} allowed */
export function actionBindings(allowed) {
  const out = [];
  for (const binding of BINDINGS) {
    if (allowed && !allowed.has(binding.id)) continue;
    let slot = -1;
    for (const sequence of binding.keys ?? []) {
      slot += 1;
      for (const context of contextsFor(binding, sequence)) {
        out.push({
          keystroke: gpuiKeystroke(sequence),
          action: actionNameFor(binding, slot),
          context: /** @type {Record<string, string>} */ (CONTEXT_NAMES)[context],
        });
      }
      // Once per sequence rather than once per context: the sheet is one layer
      // whatever screen it went up over, so a row that survives it is bound
      // there once.
      if (binding.survivesOverlay)
        out.push({
          keystroke: gpuiKeystroke(sequence),
          action: actionNameFor(binding, slot),
          context: OVERLAY_CONTEXT,
        });
    }
  }
  return out;
}
