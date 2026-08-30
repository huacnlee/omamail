// The two things the reader draws that nothing in the port ever fed it.
//
// Both are read out of a detail fetch by the provider adapter, kept beside the
// body in the cache, and reach the pane through `readerModel`. Every other test
// around them starts from a hand-written model — which is exactly why they
// could be finished, rendered, and never once run. This one starts at the
// message Google would have sent.

import assert from "node:assert/strict";

import { createGmailAdapter } from "../app/adapters/gmail.js";
import {
  createEffectPort,
  requestIdentity,
} from "../app/adapters/effect-port.js";
import * as Registry from "../app/providers/Registry.js";
import { readerModel } from "../app/application/reader-model.js";
import { createReaderController } from "../app/ui/reader-controller.js";
import { renderReader } from "../app/ui/reader.js";

const colors = new Proxy(
  {},
  { get: (_target, name) => `semantic:${String(name)}` },
);
const cx = {
  theme: () => ({
    colors,
    spacing: { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
    radius: { sm: 4, md: 8 },
  }),
};

function ids(element, out = []) {
  if (!element || typeof element !== "object") return out;
  if (element.elementId) out.push(element.elementId);
  for (const child of element.childNodes ?? []) ids(child, out);
  return out;
}
function texts(element, out = []) {
  if (typeof element === "string" || typeof element === "number") {
    out.push(String(element));
    return out;
  }
  if (!element || typeof element !== "object") return out;
  for (const child of element.childNodes ?? []) texts(child, out);
  return out;
}

const ics = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "UID:evt-1",
  "SUMMARY:Architecture sync",
  "DTSTART:20260901T090000Z",
  "DTEND:20260901T093000Z",
  "LOCATION:Sunfish Studio",
  "ORGANIZER;CN=Ada:mailto:ada@example.test",
  "ATTENDEE;CN=Reader;PARTSTAT=ACCEPTED:mailto:reader@example.com",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const identity = requestIdentity({
  accountId: "reader@example.com",
  query: "in:inbox",
  objectId: "m1",
  revision: 1,
});

/** The message read, run through the adapter that a live window would use. */
function detailFor(payload) {
  let completion = null;
  const adapter = createGmailAdapter(
    createEffectPort(
      (_effect, complete) => {
        completion = complete;
        return { cancel() {} };
      },
      () => identity,
    ),
  );
  let answer = null;
  adapter.detail({ identity, full: true }, (result) => {
    answer = result;
  });
  completion({ ok: true, value: { id: "m1", labelIds: [], payload } });
  assert.equal(answer.ok, true);
  return answer.value;
}

/** The window around the reader, with the host stubbed at both seams. */
function windowFor(detail, options = {}) {
  const dispatched = [];
  const controller = createReaderController({
    async dispatch(request) {
      dispatched.push(JSON.parse(request));
      return JSON.stringify({
        ok: true,
        data: { httpStatus: 204, unsubscribed: true },
      });
    },
  });
  controller.open(detail);
  const effects = [];
  const app = {
    readerHidden: false,
    readerController: controller,
    readerSelecting: false,
    readerSelection: null,
    bodyZoom: 1,
    executeEffect(effect, complete) {
      effects.push(effect);
      complete({ ok: true, value: null });
    },
  };
  const summary = { id: "m1", subject: detail.subject, unread: false };
  const snapshot = {
    detail,
    accounts: {
      accounts: [
        {
          id: "reader@example.com",
          email: "reader@example.com",
          provider: options.provider ?? "gmail",
        },
      ],
      activeId: "reader@example.com",
    },
  };
  const mail = {
    selectedId: "m1",
    messages: [summary],
    mailboxKey: "inbox",
    searchText: "",
    loading: false,
  };
  const model = readerModel(
    app,
    snapshot,
    mail,
    Registry.get(options.provider ?? "gmail"),
  );
  return { model, dispatched, effects };
}

const opened = [];
const eventCx = {
  notify() {},
  open_url(url) {
    opened.push(url);
  },
  spawn(task) {
    return task(eventCx);
  },
};

// ------------------------------------------------------- the one-click POST

const oneClick = detailFor({
  mimeType: "multipart/mixed",
  headers: [
    { name: "From", value: "Ada <ada@example.test>" },
    { name: "Subject", value: "This week" },
    { name: "List-Unsubscribe", value: "<https://list.example.com/off/9>" },
    { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
  ],
  parts: [
    {
      mimeType: "text/html",
      body: { data: Buffer.from("<p>Hello</p>").toString("base64") },
    },
  ],
});
let wired = windowFor(oneClick);
assert.equal(wired.model.unsubscribe.plan, "post");
assert.equal(
  wired.model.unsubscribe.detail,
  "This sender accepts a one-click unsubscribe",
);
assert.ok(
  ids(renderReader(wired.model, cx)).includes("reader-notice-unsubscribe"),
  "the notice draws for a message that carries the header",
);
await wired.model.onUnsubscribe({}, eventCx);
assert.deepEqual(wired.dispatched, [
  {
    operation: "unsubscribe",
    deadlineMs: 20000,
    url: "https://list.example.com/off/9",
    contentType: "application/x-www-form-urlencoded",
    body: "List-Unsubscribe=One-Click",
  },
]);
assert.equal(wired.effects.length, 0, "a POST is not an outgoing message");

// ------------------------------------------------------------- the page

// Only a URL, and no promise that posting to it is enough. Before this was
// wired the reader offered a live button that threw.
const paged = detailFor({
  mimeType: "text/html",
  headers: [
    { name: "Subject", value: "This week" },
    { name: "List-Unsubscribe", value: "<https://list.example.com/off/9>" },
  ],
  body: { data: Buffer.from("<p>Hello</p>").toString("base64") },
});
wired = windowFor(paged);
assert.equal(wired.model.unsubscribe.plan, "browser");
assert.equal(wired.model.unsubscribe.label, "Unsubscribe...");
await wired.model.onUnsubscribe({}, eventCx);
assert.deepEqual(opened, ["https://list.example.com/off/9"]);
assert.deepEqual(wired.dispatched, []);

// ------------------------------------------------------- the message to send

const mailed = detailFor({
  mimeType: "text/html",
  headers: [
    { name: "Subject", value: "This week" },
    {
      name: "List-Unsubscribe",
      value: "<mailto:leave@list.example.com?subject=unsubscribe%20me>",
    },
  ],
  body: { data: Buffer.from("<p>Hello</p>").toString("base64") },
});
wired = windowFor(mailed);
assert.equal(wired.model.unsubscribe.plan, "mail");
assert.equal(
  wired.model.unsubscribe.detail,
  "Unsubscribing sends a message to this list",
);
await wired.model.onUnsubscribe({}, eventCx);
assert.equal(wired.effects.length, 1);
assert.deepEqual(wired.effects[0], {
  type: "compose.send",
  provider: "gmail",
  accountId: "reader@example.com",
  draft: {
    mode: "new",
    to: ["leave@list.example.com"],
    cc: [],
    bcc: [],
    subject: "unsubscribe me",
    body: "Unsubscribe",
    from: "reader@example.com",
  },
});

// A list offering both. On an account that can send, the message wins: it
// finishes without leaving the window. The standalone host's `compose.send`
// carries a new message for Gmail and IMAP, while HEY's own command takes a
// reply or a forward and nothing else — so on HEY the page is what is offered,
// rather than a button that could not do what it said.
const either = detailFor({
  mimeType: "text/html",
  headers: [
    { name: "Subject", value: "This week" },
    {
      name: "List-Unsubscribe",
      value:
        "<mailto:leave@list.example.com>, <https://list.example.com/off/9>",
    },
  ],
  body: { data: Buffer.from("<p>Hello</p>").toString("base64") },
});
assert.equal(windowFor(either).model.unsubscribe.plan, "mail");
assert.equal(
  windowFor(either, { provider: "hey" }).model.unsubscribe.plan,
  "browser",
);

// ------------------------------------------------------------ the invitation

const invited = detailFor({
  mimeType: "multipart/mixed",
  headers: [
    { name: "From", value: "Ada <ada@example.test>" },
    { name: "Subject", value: "Invitation: Architecture sync" },
  ],
  parts: [
    {
      mimeType: "text/html",
      body: { data: Buffer.from("<p>Please come</p>").toString("base64") },
    },
    {
      mimeType: "text/calendar; method=REQUEST",
      filename: "invite.ics",
      body: { data: Buffer.from(ics).toString("base64"), size: ics.length },
    },
  ],
});
wired = windowFor(invited);
assert.equal(wired.model.message.invite.summary, "Architecture sync");
// Read back out of the invitation rather than remembered beside it: the copy
// on disk is what the card and the file have to agree about.
assert.equal(wired.model.message.response, "accepted");
// Answering is sending an RFC 5546 REPLY, and the host's message builder has
// no `text/calendar` part to put one in — so the card says what was answered
// and offers no buttons that would send a reply nothing would act on.
assert.equal(wired.model.message.canRespond, false);
const drawn = renderReader(wired.model, cx);
const drawnIds = ids(drawn);
assert.ok(drawnIds.includes("reader-invite"));
assert.ok(drawnIds.includes("reader-invite-when"));
assert.ok(!drawnIds.includes("reader-invite-rsvp"));
const drawnText = texts(drawn);
assert.ok(drawnText.includes("Architecture sync"));
assert.ok(drawnText.includes("Sunfish Studio"));
assert.ok(drawnText.includes("You are going"));

console.log("reader wiring tests passed");
