import assert from "node:assert/strict";
import fs from "node:fs";
import { readFileSync } from "node:fs";

import { HANDLED_ACTIONS, actionBindings } from "../app/keys/actions.js";

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

// The two rows this table has that `keys/Keymap.js` does not.
//
// The QML reader draws its body in a read-only `TextEdit` with `selectByMouse`,
// so dragging, select-all and copy are Qt's and need no binding. This host
// cannot register a text element with the shell's selection layer at all, so
// they are keys here. The plugin's own table must not grow them — `App.qml`
// answers nothing to them, and `docs/KEYS.md` asserts that table row for row —
// so this is where the divergence is written down and held.
{
  const copyBody = byId("copyBody");
  const selectAll = byId("selectAll");
  assert.deepEqual(copyBody.contexts, ["reader"]);
  assert.deepEqual(selectAll.keys, ["Ctrl+A"]);
  assert.deepEqual(
    selectAll.contexts,
    ["reader"],
    "bound in the reader alone, so a draft and a query keep their own select-all",
  );
  assert.equal(HANDLED_ACTIONS.has("copyBody"), true);
  assert.equal(HANDLED_ACTIONS.has("selectAll"), true);
  assert.equal(
    actionBindings(HANDLED_ACTIONS).some(
      (binding) =>
        binding.action === "mail::selectAll" &&
        // `secondary` is gpui's "cmd on macOS, ctrl everywhere else". `cmd` is
        // the platform key, which on Linux is Super — where Hyprland takes it
        // first and it never arrives.
        binding.keystroke === "secondary-a" &&
        binding.context === "MailReader",
    ),
    true,
  );
  assert.equal(
    actionBindings(HANDLED_ACTIONS).some(
      (binding) =>
        binding.action === "mail::selectAll" &&
        ["Compose", "MailSearch", "MailList"].includes(binding.context),
    ),
    false,
    "nothing that types keeps a window-level select-all over its own",
  );

  const doc = readFileSync(
    new URL("../docs/KEYS.md", import.meta.url),
    "utf8",
  );
  const plugin = doc.split("<!-- BEGIN BINDINGS -->")[1].split("<!-- END BINDINGS -->")[0];
  for (const row of [copyBody, selectAll]) {
    assert.equal(
      plugin.includes(`\`${row.id}\``),
      false,
      `${row.id} must stay out of the table the plugin's keymap is asserted against`,
    );
    assert.equal(
      doc.includes(`| \`${row.id}\` | `),
      true,
      `${row.id} is documented beneath that table instead`,
    );
  }
}


// Every key the table binds on a route has a handler on that route.
//
// `actionBindings` installs a binding for every row of `HANDLED_ACTIONS` in
// every context the table names, and the shortcut sheet advertises the same
// list. A row bound on a route that answers nothing is a key the window
// promises and then ignores — `c` did nothing at all on the mailbox, and the
// three view keys left the calendar with no keyboard route in or out.
{
  const answered = (source) =>
    new Set(
      [...source.matchAll(/on_action\(\s*[`"]([^`"]+)[`"]/g)].map((m) => m[1]),
    );
  const host = answered(
    fs.readFileSync(new URL("../app/keys/mail-host.js", import.meta.url), "utf8"),
  );
  for (const action of [
    "mail::compose",
    "mail::calendar",
    "mail::calendarView",
    "mail::mailView",
  ])
    assert.ok(host.has(action), `the mail screen must answer ${action}`);

  // `refresh` and `settings` are `ANY` in the table, so every route installs
  // them through one shared helper rather than four copies.
  assert.ok(host.has("mail::refresh"));
  assert.ok(host.has("mail::settings"));
  const window = fs.readFileSync(
    new URL("../app/main.js", import.meta.url),
    "utf8",
  );
  assert.equal(
    (window.match(/globalActions\(/g) ?? []).length,
    4,
    "settings, compose, calendar and setup each install the ANY keys",
  );
}

console.log("app keymap tests passed");
