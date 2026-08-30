import assert from "node:assert/strict";

import { TextareaState } from "gpui-base";
import { createReaderController } from "../app/ui/reader-controller.js";
import {
  beginReaderSelection,
  bindReaderSelection,
  canTakeReaderBody,
  copyReaderBody,
  endReaderSelection,
  readerBodyText,
  toggleReaderSelection,
} from "../app/application/reader-selection.js";

// The window, reduced to what taking a message's words needs of it: a reader
// controller with a message parsed in it, and the two fields the selecting mode
// keeps. `bindReaderSelection` builds the surface, exactly as `init` does.
function windowFor(message) {
  const controller = createReaderController({ dispatch: async () => "{}" });
  controller.open(message);
  const app = { readerController: controller };
  bindReaderSelection(app);
  return app;
}

function contextFor() {
  const written = [];
  let notified = 0;
  return {
    written,
    notifications: () => notified,
    write_to_clipboard(text) {
      written.push(text);
    },
    notify() {
      notified += 1;
    },
  };
}

// ------------------------------------------------------- what a body reads as

assert.equal(readerBodyText(null), "");
assert.equal(readerBodyText({ blocks: [] }), "");
assert.equal(
  readerBodyText({
    blocks: [
      { kind: "heading", text: "Release notes", level: 1 },
      { kind: "paragraph", text: "Two things changed." },
      { kind: "list-item", text: "The first" },
      { kind: "list-item", text: "The second" },
      { kind: "paragraph", text: "That is all." },
      { kind: "paragraph", text: "   " },
    ],
  }),
  [
    "Release notes",
    "",
    "Two things changed.",
    "",
    "• The first",
    "• The second",
    "",
    "That is all.",
  ].join("\n"),
  "a list is copied the way it is drawn — bullets, and no blank line between items",
);

// ------------------------------------------------------------------- copying

{
  const app = windowFor({ html: "<h2>Invoice</h2><p>Due Friday.</p>" });
  assert.equal(canTakeReaderBody(app), true);

  const cx = contextFor();
  assert.equal(copyReaderBody(app, cx), true);
  assert.deepEqual(cx.written, ["Invoice\n\nDue Friday."]);
  assert.equal(cx.notifications(), 1);

  // The text, never the markup: nothing a sender wrote as a tag or an address
  // can ride the clipboard out of this application.
  const markup = windowFor({
    html: '<p>Click <a href="https://tracker.example.com/x">here</a></p>',
  });
  const markupCx = contextFor();
  copyReaderBody(markup, markupCx);
  assert.equal(markupCx.written[0].includes("tracker.example.com"), false);
  assert.equal(markupCx.written[0].includes("<"), false);
  assert.equal(markupCx.written[0], "Click here");
}

{
  // A message with nothing in it has nothing to copy, and says so by writing
  // nothing rather than by putting an empty string on the clipboard.
  const empty = windowFor({ html: "", text: "" });
  const cx = contextFor();
  assert.equal(canTakeReaderBody(empty), false);
  assert.equal(copyReaderBody(empty, cx), false);
  assert.deepEqual(cx.written, []);
}

// ------------------------------------------------------------- the selecting mode

{
  const app = windowFor({ html: "<p>First.</p><p>Second.</p>" });
  assert.equal(app.readerSelecting, false);
  assert.equal(app.readerSelection.value(), "");

  const cx = contextFor();
  toggleReaderSelection(app, cx);
  assert.equal(app.readerSelecting, true);
  assert.equal(app.readerSelection.value(), "First.\n\nSecond.");

  // The whole of the read-only substitute: the host has no read-only textarea,
  // so an edit is put back rather than refused. What the surface holds after
  // somebody types into it is what it held before.
  app.readerSelection.set_value("First.\n\nSecond. and mine");
  app.readerSelection.emit("change", cx);
  assert.equal(app.readerSelection.value(), "First.\n\nSecond.");

  // And the revert does not chase its own tail: `set_value` raises `change`
  // again, and the second pass finds nothing to undo.
  app.readerSelection.emit("change", cx);
  assert.equal(app.readerSelection.value(), "First.\n\nSecond.");

  toggleReaderSelection(app, cx);
  assert.equal(app.readerSelecting, false);
  assert.equal(app.readerSelection.value(), "");
}

{
  // Select-all enters the mode, and a second one leaves a surface somebody is
  // already working in alone.
  const app = windowFor({ html: "<p>Words.</p>" });
  const cx = contextFor();
  beginReaderSelection(app, cx);
  assert.equal(app.readerSelecting, true);
  app.readerSelection.set_value("Words.");
  beginReaderSelection(app, cx);
  assert.equal(app.readerSelecting, true);
  assert.equal(app.readerSelection.value(), "Words.");

  // A message with no text cannot be selected into an empty box that says
  // nothing about why.
  const empty = windowFor({ html: "", text: "" });
  beginReaderSelection(empty, cx);
  assert.equal(empty.readerSelecting, false);
}

{
  // Nothing is stranded: leaving the message ends the mode and empties the
  // surface, so the next message cannot be read under the previous one's words.
  const app = windowFor({ html: "<p>Old message.</p>" });
  const cx = contextFor();
  toggleReaderSelection(app, cx);
  assert.equal(app.readerSelection.value(), "Old message.");
  endReaderSelection(app);
  assert.equal(app.readerSelecting, false);
  assert.equal(app.readerSelectionText, "");
  assert.equal(app.readerSelection.value(), "");

  // Idempotent, because it is called on every render that changes the message
  // and most of those changes are not this one.
  endReaderSelection(app);
  assert.equal(app.readerSelecting, false);
}

{
  // The surface is a plain `TextareaState`, which is the fact the whole design
  // turns on: there is no read-only option and no disabled option on it.
  const state = TextareaState.new({ value: "" });
  assert.equal(typeof state.set_value, "function");
  assert.equal("set_read_only" in state, false);
  assert.equal("set_disabled" in state, false);
}


// An ordered list copies out with its numbers.
//
// The blocks carry the marker they were drawn with — `<ol>` numbers and `<ul>`
// bullets, decided where the list is walked because that is the only place that
// knows which it is. Copying every item as a bullet loses the one thing the
// ordering was for.
{
  const ordered = readerBodyText({
    blocks: [
      { kind: "paragraph", text: "Steps:" },
      { kind: "list-item", text: "Open the lid", marker: "1." },
      { kind: "list-item", text: "Turn the key", marker: "2." },
    ],
  });
  assert.equal(ordered, "Steps:\n\n1. Open the lid\n2. Turn the key");

  // A bulleted list is unchanged, and a block with no marker at all still gets
  // one rather than losing its indent.
  assert.equal(
    readerBodyText({
      blocks: [
        { kind: "list-item", text: "Milk", marker: "\u2022" },
        { kind: "list-item", text: "Eggs" },
      ],
    }),
    "\u2022 Milk\n\u2022 Eggs",
  );
}

console.log("reader selection tests passed");
