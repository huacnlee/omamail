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

const KEY_NAMES = Object.freeze({
  Down: "down",
  Up: "up",
  Left: "left",
  Right: "right",
  Return: "enter",
  Escape: "escape",
});

/** @param {string} sequence */
export function gpuiKeystroke(sequence) {
  let rest = String(sequence);
  const modifiers = [];
  const prefixes = [
    ["Ctrl+", "cmd"],
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

/** @param {ReadonlySet<string>|undefined} allowed */
export function actionBindings(allowed) {
  const out = [];
  for (const binding of BINDINGS) {
    if (allowed && !allowed.has(binding.id)) continue;
    for (const sequence of binding.keys ?? []) {
      for (const context of contextsFor(binding, sequence)) {
        out.push({
          keystroke: gpuiKeystroke(sequence),
          action: `mail::${binding.id}`,
          context: /** @type {Record<string, string>} */ (CONTEXT_NAMES)[context],
        });
      }
    }
  }
  return out;
}
