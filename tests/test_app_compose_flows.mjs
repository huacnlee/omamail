import assert from "node:assert/strict";

import Omamail from "../app/main.js";
import { composeModel } from "../app/application/compose-model.js";
import { focusHandle } from "./gpui_stub.mjs";

// The four compose behaviours that live in the window rather than in the
// controller: naming files to attach, saving a draft on the way out, telling
// the completion which row has the keyboard, and where its addresses come
// from. Each of them is a wire between two pieces that already worked, and
// each was missing — the controller has answered "which field is focused"
// since it was written and nothing had ever asked it.

const colors = new Proxy(
  {},
  { get: (_target, name) => `semantic:${String(name)}` },
);
const pending = [];
let running = false;
const cx = {
  theme: () => ({
    colors,
    spacing: { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
    radius: { sm: 4, md: 8 },
  }),
  focus_handle: focusHandle,
  bind_keys: () => 1,
  // Off during `init`, which spawns the theme read and the host handshake, and
  // on afterwards: this test is about what the compose calls spawn.
  spawn(task) {
    if (!running) return undefined;
    const result = task(cx);
    if (result && typeof result.then === "function") pending.push(result);
    return result;
  },
  notify() {},
};
async function settle() {
  while (pending.length) await pending.shift();
}

function memoryStorage(initial) {
  const values = new Map([["omamail.accounts", JSON.stringify(initial)]]);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

const effects = [];
const app = new Omamail();
app.init(
  {
    storage: memoryStorage({
      version: 1,
      activeId: "writer@example.test",
      accounts: [
        {
          id: "writer@example.test",
          email: "writer@example.test",
          provider: "gmail",
          label: "Writer",
        },
      ],
    }),
    execute(effect, complete) {
      effects.push({ effect, complete });
      return { cancel() {} };
    },
    width: 1024,
  },
  cx,
);
running = true;
// The toast clock is the window's own 250ms loop and is not what this covers;
// saying it is already running keeps `startOutboxClock` from starting one that
// would outlive the test.
app.outboxClockRunning = true;

// ------------------------------------------------------------ the addresses

// Two books, merged: the mailbox's own senders answer a reply, and the
// desktop's address book — `scripts/contact-suggestions.py`, which is what
// `Service.refreshRecipientContacts` reads — answers a first message to
// somebody this mailbox has never heard from.
app.contactsHost = () =>
  Promise.resolve(
    JSON.stringify({
      ok: true,
      contacts: [{ name: "Grace Hopper", email: "grace@example.test" }],
    }),
  );
app.openCompose(cx);
await settle();
assert.equal(
  app.state.route,
  "compose",
  "the composer is the screen after `c`",
);
assert.deepEqual(
  app.compose.snapshot().suggestions,
  { field: "", contacts: [], highlighted: -1 },
  "nothing has the keyboard yet, so nothing is offered",
);

// ------------------------------------------------- which row is being typed

app.composeTo.emit("focus", cx);
app.compose.update({ to: "gra" });
const offered = app.compose.snapshot().suggestions;
assert.equal(offered.field, "to");
assert.deepEqual(
  offered.contacts.map((contact) => contact.email),
  ["grace@example.test"],
  "the desktop address book reaches the completion",
);
app.composeCc.emit("focus", cx);
assert.equal(
  app.compose.snapshot().suggestions.field,
  "cc",
  "the popup follows the keyboard rather than staying where it opened",
);
app.composeCc.emit("blur", cx);
assert.equal(
  app.compose.snapshot().suggestions.field,
  "",
  "leaving a row closes its menu rather than leaving one attached to nothing",
);
// A blur that arrives after another field already has the keyboard belongs to
// the field that lost it, not to the one that took it.
app.composeTo.emit("focus", cx);
app.composeBcc.emit("blur", cx);
assert.equal(app.compose.snapshot().suggestions.field, "to");

// ------------------------------------------------------------- naming files

// GPUI draws no file dialog. The host runs `scripts/attachment.sh choose`,
// which is the same chooser in the same separate process the QML plugin uses,
// and answers with what each file is rather than with what is in it: this
// client sends an attachment by path and its host opens the file at send time.
app.pickAttachmentsHost = () =>
  Promise.resolve(
    JSON.stringify({
      ok: true,
      files: [
        {
          path: "/home/writer/report.pdf",
          filename: "report.pdf",
          mimeType: "application/pdf",
          size: 2048,
        },
      ],
    }),
  );
const compose = app.compose;
const gmail = { id: "writer@example.test", provider: "gmail" };
// The handler the Attach button is given, built the way the compose page
// builds it. `renderCompose` only draws the button when this exists.
const attach = () =>
  composeModel(app, compose.snapshot(), gmail, false).onAttach({}, cx);
// HEY's compose command carries no files, so the draft that would be refused
// on the way out never gets the button on the way in.
assert.equal(
  composeModel(app, compose.snapshot(), { provider: "hey" }, false).onAttach,
  undefined,
);
attach();
await settle();
assert.deepEqual(
  compose.snapshot().attachments,
  [
    {
      path: "/home/writer/report.pdf",
      filename: "report.pdf",
      mimeType: "application/pdf",
      size: 2048,
    },
  ],
  "the chosen file lands on the draft as a path, never as bytes",
);
assert.equal(
  compose.snapshot().attaching,
  false,
  "the button comes back whatever the chooser said",
);

// A cancelled chooser is the ordinary outcome of opening a file dialog and
// says nothing at all.
app.pickAttachmentsHost = () =>
  Promise.resolve(JSON.stringify({ ok: false, error: "cancelled" }));
attach();
await settle();
assert.equal(compose.snapshot().status, "");
assert.equal(compose.snapshot().attachments.length, 1);

app.pickAttachmentsHost = () =>
  Promise.resolve(
    JSON.stringify({ ok: false, error: "That file is larger than the limit" }),
  );
attach();
await settle();
assert.match(
  compose.snapshot().status,
  /could not be attached/,
  "a refusal the user did not make is said out loud",
);

// ---------------------------------------------------------- leaving the form

// `App.saveAndLeaveCompose`: Back and Escape are the same question, and the
// answer is not "hide the form". A half-written reply that only exists in this
// process is one the process takes with it.
compose.compose({ accountId: "writer@example.test" });
app.syncComposeFields();
app.state = { ...app.state, route: "compose" };
effects.length = 0;
app.back(cx);
assert.equal(
  effects.length,
  0,
  "an untouched form has nothing worth writing to Drafts",
);
assert.equal(app.state.route, "mail");

app.state = { ...app.state, route: "compose" };
compose.update({ to: "ada@example.test", subject: "Half written" });
app.back(cx);
assert.equal(app.state.route, "mail", "the window leaves without waiting");
assert.equal(effects.length, 1);
assert.equal(effects[0].effect.type, "compose.draft");
assert.equal(effects[0].effect.provider, "gmail");
assert.equal(effects[0].effect.draft.subject, "Half written");
effects[0].complete({ ok: true, value: { id: "draft-1" } });
assert.equal(
  compose.snapshot().notice,
  "Draft saved",
  "the toast is at the window root, where the composer no longer is",
);
assert.equal(
  compose.snapshot().draft.draftId,
  "draft-1",
  "re-opening updates the same draft rather than creating a second one",
);

app.state = { ...app.state, route: "compose" };
effects.length = 0;
app.back(cx);
// Leaving, re-opening and leaving again before the first answer arrives is one
// save, not two: the `draftId` that turns the next one into an update is what
// the first answer carries, so a second in flight would land as a second draft
// on the server.
app.state = { ...app.state, route: "compose" };
app.back(cx);
assert.equal(effects.length, 1);
effects[0].complete({ ok: false, error: "Draft quota exceeded" });
assert.match(compose.snapshot().notice, /Could not save draft/);
assert.equal(
  compose.snapshot().draft.subject,
  "Half written",
  "a save that failed leaves the draft where the user can still see it",
);

console.log("app compose flow tests passed");
