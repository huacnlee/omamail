import assert from "node:assert/strict";

import {
  BINDINGS,
  CONTEXTS,
  bindingsFor,
  conflicts,
  contextFor,
  displayFor,
  helpColumns,
  helpGroups,
  hintsFor,
  isEnabled,
  isSequenceEnabled,
  readableSequence,
  sequencesFor,
  slotFor,
} from "../app/keys/keymap.js";

const byId = (id) => BINDINGS.find((binding) => binding.id === id);

assert.equal(BINDINGS.length > 20, true);
assert.deepEqual(conflicts(), []);
assert.equal(contextFor({ calendarVisible: true }), "calendar");
assert.equal(contextFor({ composing: true }), "compose");
assert.equal(displayFor(byId("goMailbox")), "Ctrl+1…0");
assert.equal(readableSequence("Ctrl+Return"), "Ctrl+Enter");
assert.equal(slotFor("goAccount", "Alt+0"), 9);
assert.equal(isEnabled(byId("archive"), "list", false), true);
assert.equal(isEnabled(byId("archive"), "list", true), false);
assert.equal(isSequenceEnabled(byId("help"), "Ctrl+K", "compose", false), true);
assert.equal(bindingsFor("reader").some((binding) => binding.id === "reply"), true);
assert.equal(sequencesFor("compose").some((row) => row.sequence === "?"), false);
assert.deepEqual(hintsFor("list", ["archive"]).map((hint) => hint.label), [
  "move",
  "open",
  "compose",
]);
assert.equal(helpGroups().reduce((sum, group) => sum + group.rows.length, 0), BINDINGS.length);
assert.deepEqual(helpColumns(3).flat().map((group) => group.name), helpGroups().map((group) => group.name));
assert.deepEqual(CONTEXTS, ["list", "reader", "search", "compose", "page", "calendar"]);

console.log("app keymap tests passed");
