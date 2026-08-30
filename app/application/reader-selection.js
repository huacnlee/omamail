// @ts-check

// Getting the words out of a message: copying the whole body, and putting it
// into a surface a pointer and a select-all can work inside.
//
// Qt gave the QML reader all of this for nothing.
// `components/MessageReader.qml` draws the body in a read-only `TextEdit` with
// `selectByMouse: true`, so a drag highlights, the copy key takes what was
// highlighted, and the widget answers the platform's select-all itself once it
// holds the keyboard.
//
// This host has the machinery and not the seam. `ShellRoot` already renders a
// `TextSelectionLayer` and already binds `Copy` to
// `TextSelection::selected_text`, but nothing a plugin builds from JavaScript
// ever registers with it: `TextSelectionRegistration`, `TextSelectionRun` and
// `TextSelectionHandle` are used by the shell's own failure screen and appear
// nowhere in `materialize`. So a `div` carrying a paragraph of a message is, as
// far as the selection layer is concerned, not text at all — and there is no way
// to make it text from this side of the boundary.
//
// So there are two answers, because neither alone is what was lost:
//
//   * Copy the whole body. It needs no selection at all, and "put this message
//     somewhere else" is what most reaching for the mouse was for.
//   * A selecting mode, which swaps the reading blocks for a textarea holding
//     the same text. A textarea *is* a real editor as far as the host is
//     concerned, so inside it a drag highlights, the select-all key selects the
//     whole body for real, and the copy key takes exactly the highlighted run.

import { TextareaState } from "gpui-base";

/**
 * The message as text, in the order the reader lays it out.
 *
 * Off the blocks rather than off the sanitised HTML, and that is deliberate:
 * the blocks are what is on screen, so what lands on the clipboard is what was
 * being read — including the fall back to the plain text when the chosen mode
 * was refused. They are also the one shape here that carries no markup at all,
 * which is what keeps a paste out of this application from ever carrying a
 * sender's `href`.
 *
 * @param {any} presentation the reader snapshot's presentation
 * @returns {string}
 */
export function readerBodyText(presentation) {
  const blocks = Array.isArray(presentation?.blocks) ? presentation.blocks : [];
  let text = "";
  let previous = "";
  for (const block of blocks) {
    const line = String(block?.text ?? "").trim();
    if (line === "") continue;
    // A list item is drawn with a bullet in front of it and its neighbours
    // directly under it, so it is copied that way: a blank line between every
    // item would turn a five-item list into five paragraphs.
    const kind = String(block?.kind ?? "paragraph");
    // The marker the block was drawn with, not a bullet for everything: an
    // ordered list carries its own number now, and copying "1. 2. 3." out as
    // three bullets loses the one thing the ordering was for.
    const bulleted =
      kind === "list-item" ? `${block?.marker ?? "•"} ${line}` : line;
    if (text === "") text = bulleted;
    else if (kind === "list-item" && previous === "list-item")
      text += `\n${bulleted}`;
    else text += `\n\n${bulleted}`;
    previous = kind;
  }
  return text;
}

/** @param {any} app the window */
function bodyTextOf(app) {
  return readerBodyText(app.readerController?.snapshot()?.presentation);
}

/**
 * Whether there is a message body to take, which is what decides whether the
 * menu draws its rows. A row that would copy nothing, or open an empty
 * selecting surface, is the same broken promise as a button for a verb the
 * provider does not have.
 * @param {any} app the window
 */
export function canTakeReaderBody(app) {
  return bodyTextOf(app) !== "";
}

/**
 * Put the whole message body on the clipboard.
 *
 * Silent on success, because there is nowhere in the reader's chrome a
 * transient line belongs — the notices above the body are standing statements
 * about the message rather than acknowledgements of something just done.
 * @param {any} app the window @param {import("gpui").Context} cx
 * @returns {boolean} whether there was anything to copy
 */
export function copyReaderBody(app, cx) {
  const text = bodyTextOf(app);
  if (text !== "") cx.write_to_clipboard(text);
  cx.notify();
  return text !== "";
}

/**
 * Build the selecting mode's text surface and make it refuse edits.
 *
 * **This is the port's substitute for Qt's `readOnly: true`, and it is a revert
 * rather than a refusal.** `TextareaState` carries `value`, `set_value`, four
 * events, the row count, auto-grow and soft wrap — there is no read-only option
 * and no disabled option anywhere on it, and the host offers no other retained
 * multi-line surface. So the only place a keystroke can be answered is after it
 * has landed: `change` fires, this puts the stored text straight back, and the
 * frame that draws is the one with the text restored. Typing into it therefore
 * cannot leave a mark, but it is not the same thing as a field that never took
 * the key, and it should not be described as one.
 *
 * The comparison is what stops the recursion: `set_value` raises `change` in
 * turn, and the second pass finds the value already equal to the stored text
 * and returns.
 *
 * @param {any} app the window
 */
export function bindReaderSelection(app) {
  app.readerSelection = TextareaState.new({ value: "" });
  app.readerSelecting = false;
  app.readerSelectionText = "";
  app.readerSelection.on(
    "change",
    (/** @type {any} */ _event, /** @type {import("gpui").Context} */ eventCx) => {
      const stored = String(app.readerSelectionText ?? "");
      if (app.readerSelection.value() === stored) return;
      app.readerSelection.set_value(stored);
      eventCx.notify();
    },
  );
}

/**
 * Leave the selecting mode and forget what it was holding.
 *
 * Called whenever the reader stops showing the message the text came from — a
 * different message opened, the reader closed, another reading chosen. Without
 * it the surface would go on offering the previous message's words under the
 * next message's header, which is worse than showing nothing at all.
 *
 * The stored text is cleared *before* the surface is, so the guard above sees
 * an emptying it agrees with rather than an edit to undo.
 * @param {any} app the window
 */
export function endReaderSelection(app) {
  if (app.readerSelecting !== true && !app.readerSelectionText) return;
  app.readerSelecting = false;
  app.readerSelectionText = "";
  app.readerSelection?.set_value("");
}

/**
 * Enter the selecting mode: the body's text, in a surface that can be selected
 * inside.
 *
 * A mode rather than the default, and this is the trade the whole file turns
 * on. The reading blocks are what make a heading look like a heading, a quote
 * sit in its own tone and a list carry its bullets; a textarea has one type size
 * and one colour for the lot. Making everything selectable would mean making
 * everything plain, so the rich reading stays the way a message is *read* and
 * this is the way a message is *taken*.
 *
 * **What it cannot do.** It puts the text where a selection can happen; it
 * cannot make the selection. The host exposes no focus call on a
 * `TextareaState` — the frame takes the keyboard on its own mouse-down and
 * nothing else — so the pointer has to land in the surface once. From then on
 * the surface's own keys are live and deeper in the dispatch path than this
 * window's, so select-all and copy inside it are the host's real ones.
 *
 * Idempotent, because both a key and a menu row lead here and the second press
 * of either should leave a surface somebody is already working in alone.
 *
 * @param {any} app the window @param {import("gpui").Context} cx
 */
export function beginReaderSelection(app, cx) {
  const text = bodyTextOf(app);
  if (app.readerSelecting === true || text === "") {
    cx.notify();
    return;
  }
  app.readerSelectionText = text;
  app.readerSelection?.set_value(text);
  app.readerSelecting = true;
  cx.notify();
}

/**
 * The toolbar's toggle: in if it is out, out if it is in.
 * @param {any} app the window @param {import("gpui").Context} cx
 */
export function toggleReaderSelection(app, cx) {
  if (app.readerSelecting === true) {
    endReaderSelection(app);
    cx.notify();
    return;
  }
  beginReaderSelection(app, cx);
}
