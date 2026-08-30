import assert from "node:assert/strict";

import Omamail from "../app/main.js";
import { messageMenuEntries } from "../app/ui/message-menu.js";
import { focusHandle } from "./gpui_stub.mjs";
import { openShortcuts } from "../app/keys/overlay.js";
import { HANDLED_ACTIONS, actionBindings } from "../app/keys/actions.js";
import { mailLayout } from "../app/ui/layout.js";
import { shortcutScrollAfter } from "../app/ui/shortcuts.js";
import {
  appMenuRows,
  moveAccountSwitcher,
  moveAppMenu,
  openAccountSwitcher,
  openAppMenu,
  runAccountSwitcherCursor,
  runAppMenuCursor,
  runMessageMenu,
} from "../app/application/mail-actions.js";

// What the mailbox's own verbs act on, and what the list and the reader do
// afterwards. The list cursor and the open message are two different things,
// and every bug this file is a gate against came from treating them as one.

function memoryStorage(seed) {
  const map = new Map();
  if (seed) map.set("omamail.accounts", JSON.stringify(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

const colors = new Proxy(
  {},
  { get: (_target, name) => `semantic:${String(name)}` },
);
const opened = [];
const copied = [];
const cx = {
  notify() {},
  spawn(task) {
    return task(cx);
  },
  theme: () => ({
    colors,
    spacing: { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
    radius: { sm: 4, md: 8 },
  }),
  bind_keys: () => 0,
  focus_handle: focusHandle,
  stop_propagation() {},
  open_url(url) {
    opened.push(url);
  },
  write_to_clipboard(text) {
    copied.push(text);
  },
  sleep: () => new Promise(() => {}),
};

function ids(element, out = []) {
  if (!element || typeof element !== "object") return out;
  if (element.elementId) out.push(String(element.elementId));
  for (const child of element.childNodes ?? []) ids(child, out);
  return out;
}

function find(element, target) {
  if (!element || typeof element !== "object") return null;
  if (element.elementId === target) return element;
  for (const child of element.childNodes ?? []) {
    const found = find(child, target);
    if (found) return found;
  }
  return null;
}

/** Every string drawn under an element, which is what a hint row is made of. */
function labels(element, out = []) {
  if (typeof element === "string") out.push(element);
  if (!element || typeof element !== "object") return out;
  for (const child of element.childNodes ?? []) labels(child, out);
  return out;
}

/** What an element was handed for one of the builder calls the stub records. */
function styleArg(element, name) {
  return element?.styleCalls?.find((call) => call.name === name)?.args[0];
}

/** The press handler a row installs for one mouse button. */
function mouseDown(element, button) {
  return element?.styleCalls?.find(
    (call) => call.name === "on_mouse_down" && call.args[0] === button,
  )?.args[1];
}

/** @param {string} provider @param {Array<any>} [extra] further mailboxes */
function windowFor(provider = "gmail", extra = []) {
  const completions = [];
  const app = new Omamail();
  const id = provider === "gmail" ? "a@example.com" : `${provider}:a@example.com`;
  app.init(
    {
      storage: memoryStorage({
        version: 1,
        activeId: id,
        accounts: [
          {
            id,
            email: "a@example.com",
            provider,
            // A Gmail mailbox with no OAuth client is a mailbox the host
            // refuses to configure, and the status line then carries that
            // rather than the keyboard's hints.
            clientId: "000000-xxxx.apps.googleusercontent.com",
          },
          ...extra,
        ],
      }),
      width: 1400,
      execute(effect, complete) {
        completions.push({ effect, complete });
        return { cancel() {} };
      },
    },
    cx,
  );
  return { app, completions };
}

function resource(id, subject, labels = ["INBOX"]) {
  return {
    id,
    labelIds: labels,
    payload: {
      headers: [
        { name: "From", value: "Sender <sender@example.test>" },
        { name: "Subject", value: subject },
      ],
      mimeType: "text/plain",
      body: { data: "Qm9keQ" },
    },
  };
}

/** @param {Array<any>} completions */
function answerList(completions, messages) {
  completions.shift().complete({ ok: true, value: { messages } });
}

// ------------------------------------------------- acting on the cursor row

{
  const { app, completions } = windowFor();
  answerList(completions, [
    resource("m1", "One"),
    resource("m2", "Two"),
    resource("m3", "Three"),
  ]);
  app.controller.openMessage("m1");
  completions.shift().complete({ ok: true, value: resource("m1", "One") });
  assert.equal(app.controller.snapshot().mail.selectedId, "m1");

  // Acting on the open message closes it: it is about to leave this list, and
  // the next one takes the reader.
  app.actCurrent("archive", cx);
  assert.deepEqual(
    app.controller.snapshot().mail.messages.map((message) => message.id),
    ["m2", "m3"],
  );
  assert.equal(app.controller.snapshot().mail.selectedId, "m2");
  assert.equal(app.controller.snapshot().mail.cursorId, "m2");

  // Leaving the reader puts the open message down, so the keys that follow act
  // on the row the keyboard is on and not on what was last read.
  app.back(cx);
  assert.equal(app.controller.snapshot().mail.selectedId, null);
  assert.equal(app.readerHidden, true);
  app.moveCursor(1, cx);
  assert.equal(app.controller.snapshot().mail.cursorId, "m3");
  app.actCurrent("archive", cx);
  assert.deepEqual(
    app.controller.snapshot().mail.messages.map((message) => message.id),
    ["m2"],
    "`u`, `j`, `e` archives the row under the cursor, not the message just read",
  );

  // Nothing left to advance to, so the list is where the reader goes.
  app.controller.openMessage("m2");
  completions.shift().complete({ ok: true, value: resource("m2", "Two") });
  app.actCurrent("trash", cx);
  assert.deepEqual(app.controller.snapshot().mail.messages, []);
  assert.equal(app.controller.snapshot().mail.selectedId, null);
  assert.equal(app.readerHidden, true);
}

// The reader's own toolbar acts on the message the reader is showing, which is
// not the row the keyboard is on once `j` has walked away from it.
{
  const { app, completions } = windowFor();
  answerList(completions, [
    resource("m1", "One"),
    resource("m2", "Two"),
    resource("m3", "Three"),
  ]);
  app.controller.openMessage("m1");
  completions.shift().complete({ ok: true, value: resource("m1", "One") });
  app.moveCursor(1, cx);
  assert.equal(app.controller.snapshot().mail.cursorId, "m2");
  find(app.render(cx), "reader-action-archive").clickHandler({}, cx);
  assert.deepEqual(
    app.controller.snapshot().mail.messages.map((message) => message.id),
    ["m2", "m3"],
    "the toolbar files the message it is attached to",
  );
  assert.equal(app.controller.snapshot().mail.selectedId, "m2");
}

// ------------------------------------------------------------- star, unstar

{
  const { app, completions } = windowFor();
  answerList(completions, [
    resource("plain", "One"),
    resource("lit", "Two", ["INBOX", "STARRED"]),
  ]);
  app.toggleStar("plain", cx);
  assert.equal(completions.at(-1).effect.hostOperation.action, "star");
  app.toggleStar("lit", cx);
  assert.equal(
    completions.at(-1).effect.hostOperation.action,
    "unstar",
    "the row's button says Unstar while the star is on, and has to mean it",
  );
  // And `s` reads the cursor, through the same guard.
  app.controller.placeCursor("plain");
  app.actCurrent("star", cx);
  assert.equal(completions.at(-1).effect.hostOperation.action, "unstar");
}

// ------------------------------------------------------------- the row menu

{
  const { app, completions } = windowFor();
  answerList(completions, [
    resource("m1", "One", ["INBOX", "UNREAD"]),
    resource("m2", "Two"),
  ]);
  const row = find(app.render(cx), "message-m1-cursor");
  const press = mouseDown(row, "right");
  assert.ok(press, "a row answers the right button");
  press({ local_position: { x: 12, y: 8 } }, cx);
  const menu = ids(app.render(cx));
  for (const entry of [
    "message-menu-reply",
    "message-menu-replyAll",
    "message-menu-forward",
    "message-menu-archive",
    "message-menu-trash",
    "message-menu-spam",
    "message-menu-read",
    "message-menu-star",
    "message-menu-browser",
  ])
    assert.ok(menu.includes(entry), `${entry} is drawn`);
  assert.equal(app.messageMenu.x, 12);
  assert.equal(app.messageMenu.y, 8);

  // The menu is on top, so the list's own keys move it.
  assert.equal(app.messageMenu.cursorIndex, 0);
  app.moveCursor(1, cx);
  assert.equal(app.messageMenu.cursorIndex, 1);
  app.moveCursor(-1, cx);
  assert.equal(app.messageMenu.cursorIndex, 0);
  app.back(cx);
  assert.equal(app.messageMenu, null);
  assert.equal(
    app.controller.snapshot().mail.cursorId,
    "m1",
    "closing the menu is not leaving the reader",
  );

  // A verb from the menu goes through the cursor, so one path decides what the
  // list does after a row leaves it.
  press({ local_position: { x: 0, y: 0 } }, cx);
  find(app.render(cx), "message-menu-trash").clickHandler({}, cx);
  assert.equal(app.messageMenu, null);
  assert.deepEqual(
    app.controller.snapshot().mail.messages.map((message) => message.id),
    ["m2"],
  );

  // "Open in browser..." is the provider's address, not this window's guess.
  const second = find(app.render(cx), "message-m2-cursor");
  mouseDown(second, "right")({ local_position: { x: 0, y: 0 } }, cx);
  find(app.render(cx), "message-menu-browser").clickHandler({}, cx);
  assert.ok(opened.at(-1).includes("m2"));
}

// ------------------------------------------------ taking the message's words
//
// Qt gave the QML reader a body that selects by mouse; this host cannot make a
// drawn paragraph text as far as the shell's selection layer is concerned. So
// the words leave through a key, a menu row, and a mode that puts them in a
// surface a selection can happen in.

{
  const { app, completions } = windowFor();
  answerList(completions, [resource("m1", "One"), resource("m2", "Two")]);

  // Nothing is open, so there is no parsed body and the two rows are absent
  // from the row menu — the same rule a verb the provider lacks obeys.
  const closed = find(app.render(cx), "message-m1-cursor");
  mouseDown(closed, "right")({ local_position: { x: 0, y: 0 } }, cx);
  const withoutBody = ids(app.render(cx));
  assert.equal(withoutBody.includes("message-menu-copyBody"), false);
  assert.equal(withoutBody.includes("message-menu-selectBody"), false);
  app.back(cx);

  app.controller.openMessage("m1");
  completions.shift().complete({ ok: true, value: resource("m1", "One") });
  app.render(cx);

  const before = copied.length;
  find(app.render(cx), "mail-action-host").actionHandlers
    .get("mail::copyBody")({}, cx);
  assert.deepEqual(
    copied.slice(before),
    ["Body"],
    "the key copies the body's text, and the text is all it copies",
  );

  // The menu row is offered for the open message and does the same thing. The
  // row that is open draws as `selected` rather than as `cursor`.
  const open = find(app.render(cx), "message-m1-selected");
  mouseDown(open, "right")({ local_position: { x: 0, y: 0 } }, cx);
  const withBody = ids(app.render(cx));
  assert.ok(withBody.includes("message-menu-copyBody"));
  assert.ok(withBody.includes("message-menu-selectBody"));
  find(app.render(cx), "message-menu-copyBody").clickHandler({}, cx);
  assert.equal(copied.at(-1), "Body");
  assert.equal(app.messageMenu, null);

  // A menu raised on a different row is a menu about a summary, and a summary
  // has no body to take.
  const other = find(app.render(cx), "message-m2-idle");
  mouseDown(other, "right")({ local_position: { x: 0, y: 0 } }, cx);
  assert.equal(
    ids(app.render(cx)).includes("message-menu-copyBody"),
    false,
  );
  app.back(cx);

  // Select-all opens the surface rather than pretending to highlight the
  // blocks: there is nothing in a `div` for a selection to land on.
  find(app.render(cx), "mail-action-host").actionHandlers
    .get("mail::selectAll")({}, cx);
  assert.equal(app.readerSelecting, true);
  assert.equal(app.readerSelection.value(), "Body");
  assert.ok(ids(app.render(cx)).includes("reader-message-selection"));

  // Typing into it leaves no mark. There is no read-only textarea in this
  // host, so the edit is put back rather than refused.
  app.readerSelection.set_value("Body and mine");
  app.readerSelection.emit("change", cx);
  assert.equal(app.readerSelection.value(), "Body");

  // And it does not follow the reader to the next message. This one is the
  // sender's own markup, so it also has the three readings to choose between.
  app.controller.openMessage("m2");
  completions.shift().complete({
    ok: true,
    value: {
      id: "m2",
      labelIds: ["INBOX"],
      payload: {
        headers: [
          { name: "From", value: "Sender <sender@example.test>" },
          { name: "Subject", value: "Two" },
        ],
        mimeType: "text/html",
        body: {
          data: Buffer.from("<h2>Heading</h2><p>Second.</p>").toString(
            "base64url",
          ),
        },
      },
    },
  });
  app.render(cx);
  assert.equal(app.readerSelecting, false);
  assert.equal(app.readerSelection.value(), "");
  assert.equal(
    ids(app.render(cx)).includes("reader-message-selection"),
    false,
  );

  // Nor does it survive a change of reading, whose text it would no longer be.
  find(app.render(cx), "mail-action-host").actionHandlers
    .get("mail::selectAll")({}, cx);
  assert.equal(app.readerSelecting, true);
  assert.equal(app.readerSelection.value(), "Heading\n\nSecond.");
  find(app.render(cx), "reader-mode-plain").clickHandler({}, cx);
  assert.equal(app.readerSelecting, false);
  assert.equal(
    ids(app.render(cx)).includes("reader-message-selection"),
    false,
  );

  // The toolbar toggle is the mouse's way in, and the same way back out.
  find(app.render(cx), "reader-select-text").clickHandler({}, cx);
  assert.equal(app.readerSelecting, true);
  find(app.render(cx), "reader-select-text").clickHandler({}, cx);
  assert.equal(app.readerSelecting, false);
}

// A provider with no web mailbox is not offered one. `web` is the capability's
// own name: asking about `openOnWeb`, which no provider declares, is asking a
// question that always answers yes.
{
  const hidden = messageMenuEntries(null, {
    archive: false,
    spam: false,
    star: false,
    web: false,
  })
    .filter((entry) => entry.kind === "action" && !entry.visible)
    .map((entry) => entry.id);
  assert.deepEqual(hidden, [
    "archive",
    "spam",
    "star",
    // The two body rows are the only ones whose capability defaults to absent
    // rather than present: they act on the parse, which exists for the message
    // the reader has open and for no other.
    "selectBody",
    "copyBody",
    "browser",
  ]);
  assert.deepEqual(
    messageMenuEntries(null, {})
      .filter((entry) => entry.kind === "action" && !entry.visible)
      .map((entry) => entry.id),
    ["selectBody", "copyBody"],
    "a provider that declares everything is offered everything the provider decides",
  );
  assert.deepEqual(
    messageMenuEntries(null, { bodyText: true })
      .filter((entry) => entry.kind === "action" && !entry.visible)
      .map((entry) => entry.id),
    [],
    "and the body rows appear once there is a parsed body to take",
  );
}

// ------------------------------------------------ what the mailbox refuses

{
  const gmail = windowFor();
  answerList(gmail.completions, [resource("m1", "One")]);
  assert.ok(
    labels(find(gmail.app.render(cx), "key-hints")).includes("archive"),
    "Gmail archives, so the row says so",
  );

  const hey = windowFor("hey");
  answerList(hey.completions, [resource("1:2", "One")]);
  assert.ok(
    !labels(find(hey.app.render(cx), "key-hints")).includes("archive"),
    "HEY has no archive, so the status row does not offer `e` for one",
  );
}

// ------------------------------------------- a failure is not an empty box

{
  const { app, completions } = windowFor();
  completions.shift().complete({ ok: false, error: "Mail is unavailable" });
  assert.ok(labels(app.render(cx)).includes("Mail is unavailable"));
  assert.deepEqual(
    labels(find(app.render(cx), "message-list-empty")),
    [""],
    "a first read that failed is not the window agreeing the mailbox is empty",
  );
  // And the retry the failure offered is what turns it into an answer.
  find(app.render(cx), "mail-retry").clickHandler({}, cx);
  answerList(completions, []);
  assert.deepEqual(labels(find(app.render(cx), "message-list-empty")), [
    "Nothing here",
  ]);
}

// ------------------------------------------------------ "Mark these read"

{
  const { app, completions } = windowFor();
  answerList(completions, [
    resource("m1", "One", ["INBOX", "UNREAD"]),
    resource("m2", "Two"),
    resource("m3", "Three", ["INBOX", "UNREAD"]),
  ]);
  find(app.render(cx), "app-menu-mark-read").clickHandler({}, cx);
  assert.deepEqual(
    completions.at(-1).effect.hostOperation.messageIds,
    ["m1", "m3"],
    "the label says these, and it means the ones that are unread",
  );
}

// ------------------------------------------------ the two reading answers

{
  // Both are standing answers Settings writes, so the reader is told them
  // before it opens anything: a preference already given should not have to be
  // given again on the first message.
  const { app } = windowFor();
  app.storage.setItem("omamail.heavyMessages", "true");
  app.storage.setItem("omamail.remoteImages", "true");
  const started = new Omamail();
  started.init(
    { storage: app.storage, width: 1400, execute: () => ({ cancel() {} }) },
    cx,
  );
  started.readerController.open({
    html: new Array(10).fill(`<p>${"word ".repeat(3000)}</p>`).join(""),
  });
  assert.equal(
    started.readerController.snapshot().shownMode,
    "reader",
    "the stored heavy-message answer reaches the reader",
  );
  started.readerController.open({
    html: '<p>Look</p><img src="https://images.example.com/c.png">',
  });
  assert.equal(started.readerController.snapshot().remoteImagesAllowed, true);
}

// -------------------------------------------------- the sheet is a promise

{
  const { app } = windowFor();
  openShortcuts(app, cx);
  const sheet = labels(app.render(cx));
  assert.ok(sheet.includes("Check for mail"));
  assert.ok(sheet.includes("Go to that mailbox"));
  assert.ok(
    !sheet.includes("Search"),
    "a sheet row for a key this host cannot honour is a promise it breaks",
  );
}

console.log("mail action tests passed");

// ------------------------------------------ the keyboard has somewhere to be

// gpui dispatches a key down the path from the tree root to the *focused* node,
// so a `key_context` on an element nothing focuses is a context that matches
// nothing and a window where no binding fires at all. `App.qml` parks the
// keyboard on a plain `Item` for the same reason its own contexts need one.
{
  const { app, completions } = windowFor();
  answerList(completions, [resource("m1", "One"), resource("m2", "Two")]);
  assert.equal(app.keyboardHome.is_focused(), true, "the window starts focused");
  const host = find(app.render(cx), "mail-action-host");
  assert.equal(styleArg(host, "track_focus"), app.keyboardHome);
  assert.equal(styleArg(host, "key_context"), "MailList");

  // The reader is a context of its own, and the search field is a third: a
  // query being typed beats the list underneath it.
  app.controller.openMessage("m1");
  completions.shift().complete({ ok: true, value: resource("m1", "One") });
  assert.equal(
    styleArg(find(app.render(cx), "mail-action-host"), "key_context"),
    "MailReader",
  );
  app.search.emit("focus", cx);
  assert.equal(
    styleArg(find(app.render(cx), "mail-action-host"), "key_context"),
    "MailSearch",
  );
  app.search.emit("blur", cx);
  assert.equal(
    styleArg(find(app.render(cx), "mail-action-host"), "key_context"),
    "MailReader",
  );
}

// A text-entry context binds no bare key but Escape. That is the whole rule,
// and it is what stops a query from archiving, trashing and replying as it is
// typed: gpui matches a binding against every ancestor's context, and on Linux
// the binding wins over the character.
{
  const bare = actionBindings(HANDLED_ACTIONS)
    .filter((binding) => binding.context === "MailSearch")
    .map((binding) => binding.keystroke)
    .filter((keystroke) => !keystroke.includes("-"));
  for (const key of ["e", "d", "r", "a", "f", "c", "s", "j", "k", "o", "u"])
    assert.equal(
      bare.includes(key),
      false,
      `${key} must not fire while a query is being typed`,
    );
  // Escape leaves, and F5 is not a character anybody can type into a field.
  assert.deepEqual([...bare].sort(), ["escape", "f5"]);
}

// ------------------------------------------------- what survives the overlay

// The sheet documents `e`, `d` and `r`, and without a guard it would let all
// three fire behind itself. `KeyRouter` disables every Shortcut the table does
// not mark `survivesOverlay`; here the sheet takes the keyboard instead, which
// puts the mailbox's own context element off the dispatch path entirely.
{
  const { app, completions } = windowFor();
  answerList(completions, [resource("m1", "One"), resource("m2", "Two")]);
  openShortcuts(app, cx);
  assert.equal(app.overlayFocus.is_focused(), true);
  const framed = app.render(cx);
  assert.equal(framed.elementId, "window-with-overlay");
  assert.equal(styleArg(framed, "key_context"), "Overlay");
  assert.equal(styleArg(find(framed, "shortcut-help"), "track_focus"), app.overlayFocus);

  const overlay = actionBindings(HANDLED_ACTIONS)
    .filter((binding) => binding.context === "Overlay")
    .map((binding) => binding.keystroke);
  for (const key of ["e", "d", "r", "a", "f", "c", "s", "o", "u"])
    assert.equal(
      overlay.includes(key),
      false,
      `${key} must not fire behind the sheet that documents it`,
    );
  // The four rows the table marks, and nothing else: `help` and `back` are how
  // the sheet goes away, `cursorDown`/`cursorUp` are handed to it to scroll it,
  // and `undoSend` is a transient action over the screen rather than a screen.
  assert.deepEqual(
    [...overlay].sort(),
    [
      "?",
      "alt-z",
      "down",
      "escape",
      "j",
      "k",
      "secondary-/",
      "secondary-?",
      "secondary-k",
      "up",
    ],
  );

  // `j` moves the sheet, not the list under it.
  const before = app.controller.snapshot().mail.cursorId;
  framed.actionHandlers.get("mail::cursorDown")({}, cx);
  assert.equal(app.controller.snapshot().mail.cursorId, before);

  // Escape closes the sheet first. `renderMail` answers the same action deeper
  // in the tree, and gpui bubbles leaf-first — so the sheet has to hold the
  // keyboard for this one to be the handler that runs.
  framed.actionHandlers.get("mail::back")({}, cx);
  assert.equal(app.shortcutHelpOpen, false);
  assert.equal(app.keyboardHome.is_focused(), true, "the keyboard is parked again");
  assert.equal(app.controller.snapshot().mail.selectedId, null);
}

// One row per step, clamped at both ends: `scrollBy` in the units this host can
// work in, because gpui gives a script no way to drive a scroll container.
{
  const tall = { width: 1400, height: 200 };
  const step = shortcutScrollAfter(0, 1, tall);
  assert.ok(step > 0, "a sheet taller than the window moves");
  assert.equal(shortcutScrollAfter(0, -1, tall), 0, "and stops at the top");
  assert.equal(
    shortcutScrollAfter(0, 1, { width: 1400, height: 4000 }),
    0,
    "a sheet that fits does not move at all",
  );
}

// ----------------------------------------------------------- Escape, outward

// `goBack` in the order the window is stacked. The query is the last layer the
// list has, and leaving it standing was Escape answering by doing nothing.
{
  const { app, completions } = windowFor();
  answerList(completions, [resource("m1", "One")]);
  app.search.set_value("from:jane");
  app.controller.search("from:jane");
  app.back(cx);
  assert.equal(app.search.value(), "");
  assert.equal(
    app.readerHidden,
    false,
    "Escape in the list has no reader to hide",
  );
}

// ------------------------------------------------------------- the splitter

{
  const { app, completions } = windowFor();
  answerList(completions, [resource("m1", "One")]);
  assert.ok(find(app.render(cx), "mail-splitter"), "both columns, so a divider");
  const proportional = mailLayout(1400, false, { listWidth: 0 }).listWidth;
  app.beginListDrag({ position: { x: 500 }, click_count: 1 }, cx);
  app.dragList({ position: { x: 560 } }, cx);
  assert.equal(app.listWidth, proportional + 60);
  app.endListDrag(cx);
  assert.equal(app.listDrag, null);
  assert.equal(
    mailLayout(1400, false, { listWidth: app.listWidth }).listWidth,
    proportional + 60,
  );
  // Back to the proportional default, which is what most people want after one
  // bad drag.
  app.beginListDrag({ position: { x: 500 }, click_count: 2 }, cx);
  assert.equal(app.listWidth, 0);
}

// --------------------------------------------------------- the two menus

// `AppMenu.qml` and `AccountSwitcher.qml` each run a cursor from a `Keys`
// handler on their popup's content, because an open `QQC.Popup` takes every key
// before the shortcut map sees it. This host's popups take no keys at all, so
// the window runs both cursors — the same inversion, said the other way round.
{
  const { app, completions } = windowFor("gmail", [
    { id: "b@example.com", email: "b@example.com", provider: "hey" },
  ]);
  answerList(completions, [resource("m1", "One")]);

  openAppMenu(app, true, cx);
  const rows = appMenuRows(app).map((row) => row.id);
  assert.equal(rows[app.appMenuCursor], rows[0], "opening rests on the first row");
  moveAppMenu(app, 1, cx);
  assert.equal(rows[app.appMenuCursor], rows[1]);
  // The cursor wraps, where the message list clamps: a menu is a ring of a
  // handful of rows and the ends are not a place anybody means to stop.
  moveAppMenu(app, -1, cx);
  assert.equal(app.appMenuCursor, 0);
  moveAppMenu(app, -1, cx);
  assert.equal(app.appMenuCursor, rows.length - 1);
  // Enter takes the row the cursor is on, and the menu goes away with it.
  app.appMenuCursor = rows.indexOf("keyboard");
  runAppMenuCursor(app, cx);
  assert.equal(app.appMenuOpen, false);
  assert.equal(app.shortcutHelpOpen, true, "Keyboard... opened the sheet");
  app.shortcutHelpOpen = false;

  // Opening the switcher puts the keyboard on the mailbox you are already in,
  // so the first `j` is one step away from it rather than back at the top.
  openAccountSwitcher(app, true, cx);
  assert.equal(app.accountSwitcherCursor, 0);
  moveAccountSwitcher(app, 1, cx);
  assert.equal(app.accountSwitcherCursor, 1);
  moveAccountSwitcher(app, 1, cx);
  assert.equal(app.accountSwitcherCursor, 0, "and it wraps");
  const card = find(app.render(cx), "account-switcher-a@example.com");
  assert.ok(card, "the card draws the mailboxes it is offering");
  moveAccountSwitcher(app, 1, cx);
  runAccountSwitcherCursor(app, cx);
  assert.equal(app.accountSwitcherOpen, false);
  assert.equal(
    app.controller.snapshot().accounts.activeId,
    "hey:b@example.com",
    "Enter takes the mailbox the cursor is on",
  );
}

// "Switch account..." exists for the narrow window, where the rail that carries
// the switcher is gone — and it opened onto nothing. Centred, because opened
// from a menu there is no pointer position to hang the card off.
{
  const { app, completions } = windowFor("gmail", [
    { id: "b@example.com", email: "b@example.com", provider: "hey" },
  ]);
  answerList(completions, [resource("m1", "One")]);
  app.width = 600;
  assert.equal(ids(app.render(cx)).includes("mail-rail"), false);
  openAccountSwitcher(app, true, cx);
  assert.ok(ids(app.render(cx)).includes("account-switcher-centered"));
}

// --------------------------------------- answering goes to the composer only
//
// Reply, reply all and forward from a row's menu used to open the message and
// then the draft, because the only way to get a body was `openCursor`, which
// reads and selects in one act — and a selection is what puts the reader on
// screen. The reader is not on the way to writing a reply. Everything below is
// a gate against it coming back: the route is `compose`, and nothing is
// selected while it gets there.

/** Whether the window is on the mailbox with a message open in the reader. */
function readerOpen(app) {
  return (
    app.state.route === "mail" &&
    Boolean(app.controller.snapshot().mail.selectedId) &&
    app.readerHidden !== true
  );
}

// The reported path, through the pointer: right-click a row nobody has opened,
// choose Reply, and land in the composer without the reader having been drawn
// at all.
{
  const { app, completions } = windowFor();
  answerList(completions, [resource("m1", "One"), resource("m2", "Two")]);
  // The second row, which is neither open nor the one the keyboard is on.
  const row = find(app.render(cx), "message-m2-idle");
  mouseDown(row, "right")({ local_position: { x: 0, y: 0 } }, cx);
  find(app.render(cx), "message-menu-reply").clickHandler({}, cx);
  assert.equal(app.messageMenu, null);
  assert.equal(app.state.route, "compose");
  assert.equal(readerOpen(app), false);
  assert.equal(
    ids(app.render(cx)).includes("message-reader"),
    false,
    "the reader is not drawn on the way to the composer",
  );
}

// The body is already here, because the message is the one being read. There
// is nothing to fetch and nothing to wait for.
{
  const { app, completions } = windowFor();
  answerList(completions, [resource("m1", "One"), resource("m2", "Two")]);
  app.controller.openMessage("m1");
  completions.shift().complete({ ok: true, value: resource("m1", "One") });
  assert.equal(completions.length, 0);

  runMessageMenu(app, "reply", "m1", cx);
  assert.equal(app.state.route, "compose");
  assert.equal(app.compose.snapshot().draft.mode, "reply");
  assert.equal(
    app.compose.snapshot().draft.body.includes("> Body"),
    true,
    "a message already read is quoted in the same breath",
  );
  assert.equal(app.compose.snapshot().quoting.loading, false);
  assert.equal(completions.length, 0, "and nothing is asked for twice");
}

// The body is not here, which is the case that went through the reader.
{
  const { app, completions } = windowFor();
  answerList(completions, [resource("m1", "One"), resource("m2", "Two")]);
  assert.equal(app.controller.snapshot().mail.selectedId, null);

  runMessageMenu(app, "reply", "m2", cx);
  assert.equal(app.state.route, "compose", "Reply opens the composer, at once");
  assert.equal(readerOpen(app), false);
  assert.equal(
    app.controller.snapshot().mail.selectedId,
    null,
    "and nothing was opened on the way there",
  );
  assert.equal(
    app.controller.snapshot().mail.cursorId,
    "m2",
    "the keyboard still follows the row that was acted on",
  );
  // What the row alone can say is said now; the rest is on its way, and the
  // status line is where the wait is explained.
  const waiting = app.compose.snapshot();
  assert.equal(waiting.draft.mode, "reply");
  assert.equal(waiting.draft.to, "Sender <sender@example.test>");
  assert.equal(waiting.draft.subject, "Re: Two");
  assert.equal(waiting.draft.body, "");
  assert.equal(waiting.quoting.loading, true);
  assert.equal(waiting.status, "Loading the message you are answering...");
  // A draft that quotes nothing and threads against nothing may not go.
  assert.equal(waiting.draft.inReplyTo, undefined);
  const asked = completions.length;
  app.compose.send(0, 0);
  assert.equal(
    completions.length,
    asked,
    "Send is held until the message being answered has arrived",
  );

  completions.shift().complete({ ok: true, value: resource("m2", "Two") });
  await Promise.resolve();
  await Promise.resolve();
  const answered = app.compose.snapshot();
  assert.equal(app.state.route, "compose");
  assert.equal(readerOpen(app), false);
  assert.equal(answered.quoting.loading, false);
  assert.equal(answered.draft.body.includes("> Body"), true, "the quote lands");
  assert.equal(answered.draft.inReplyTo, "m2", "and so does the threading");
  assert.equal(app.composeBody.value(), answered.draft.body);
}

// Typing during the wait is typing into this draft. The quote arrives under
// it, the way a reply is written, and nothing typed is thrown away.
{
  const { app, completions } = windowFor();
  answerList(completions, [resource("m1", "One"), resource("m2", "Two")]);
  runMessageMenu(app, "replyAll", "m1", cx);
  assert.equal(app.state.route, "compose");
  app.compose.update({ body: "Yes, tomorrow works." });
  app.compose.update({ subject: "Re: One, then" });
  completions.shift().complete({ ok: true, value: resource("m1", "One") });
  await Promise.resolve();
  await Promise.resolve();
  const draft = app.compose.snapshot().draft;
  assert.equal(draft.body.startsWith("Yes, tomorrow works.\n\n"), true);
  assert.equal(draft.body.includes("> Body"), true);
  assert.equal(
    draft.subject,
    "Re: One, then",
    "an edited field keeps its edit; an untouched one takes the answer's",
  );
  assert.equal(draft.mode, "replyAll");
}

// The keys are the same path. `f` on a row nobody has opened is a forward, not
// a reader.
{
  const { app, completions } = windowFor();
  answerList(completions, [resource("m1", "One"), resource("m2", "Two")]);
  app.moveCursor(1, cx);
  assert.equal(app.controller.snapshot().mail.cursorId, "m2");
  app.openResponse("forward", cx);
  assert.equal(app.state.route, "compose");
  assert.equal(readerOpen(app), false);
  assert.equal(app.controller.snapshot().mail.selectedId, null);
  assert.equal(app.compose.snapshot().draft.subject, "Fwd: Two");
  completions.shift().complete({ ok: true, value: resource("m2", "Two") });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(app.compose.snapshot().draft.body.includes("> Body"), true);
  assert.equal(app.compose.snapshot().quoting.loading, false);
}

// A read that fails leaves the draft standing and says so, rather than a
// composer that waits for something that is never coming.
{
  const { app, completions } = windowFor();
  answerList(completions, [resource("m1", "One")]);
  app.openResponse("reply", cx);
  completions.shift().complete({ ok: false, error: "Network is unreachable" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(app.state.route, "compose");
  assert.equal(app.compose.snapshot().quoting.loading, false);
  assert.equal(app.compose.snapshot().status, "Network is unreachable");
  app.compose.update({ body: "Sending anyway" });
  app.compose.send(0, 0);
  assert.equal(
    completions.at(-1).effect.type,
    "compose.send",
    "a failed read does not lock the form for good",
  );
}

console.log("answering tests passed");
