import assert from "node:assert/strict";

import { createReaderController } from "../app/ui/reader-controller.js";

const calls = [];
const controller = createReaderController({
  async dispatch(request) {
    const parsed = JSON.parse(request);
    calls.push(parsed);
    if (parsed.operation === "image.fetch")
      return JSON.stringify({ ok: true, data: { dataUri: "data:image/png;base64,AA==" } });
    return JSON.stringify({ ok: true, data: { httpStatus: 204, unsubscribed: true } });
  },
});

controller.open({
  html: '<h1>Hello</h1><img src="https://images.example.com/a.png"><script>bad()</script>',
  text: "Hello\n\nPlain body",
  unsubscribe: {
    oneClick: true,
    postUrl: "https://list.example.com/unsubscribe",
  },
});
assert.equal(controller.snapshot().mode, "reader");
assert.deepEqual(controller.snapshot().availableModes, ["reader", "original", "plain"]);
assert.equal(
  JSON.stringify(controller.snapshot().presentation).includes("images.example.com"),
  false,
);
assert.deepEqual(controller.snapshot().imageSources, [
  "https://images.example.com/a.png",
]);
assert.equal(JSON.stringify(controller.snapshot()).includes("<script"), false);

controller.setMode("original");
assert.equal(controller.snapshot().presentation.mode, "original");
controller.setMode("plain");
assert.equal(controller.snapshot().presentation.mode, "plain");
assert.throws(() => controller.setMode("html"));

await controller.loadImage(0);
assert.deepEqual(calls[0], {
  operation: "image.fetch",
  deadlineMs: 20000,
  url: "https://images.example.com/a.png",
});
assert.equal(controller.snapshot().images[0].state, "ready");
assert.equal(controller.snapshot().images[0].dataUri, "data:image/png;base64,AA==");

await controller.unsubscribe();
assert.deepEqual(calls[1], {
  operation: "unsubscribe",
  deadlineMs: 20000,
  url: "https://list.example.com/unsubscribe",
  contentType: "application/x-www-form-urlencoded",
  body: "List-Unsubscribe=One-Click",
});
assert.equal(controller.snapshot().unsubscribe.state, "done");

// The unsubscribe notice says what pressing it does before it is pressed, and
// keeps saying what was done afterwards.
assert.equal(controller.snapshot().unsubscribe.label, "");
assert.equal(
  controller.snapshot().unsubscribe.detail,
  "Unsubscribed from this list",
);

// The chosen mode is the window's, not the message's: it survives opening the
// next one, which is what keeps the picker showing the choice.
controller.open({ html: "<p>Another</p>" });
assert.equal(controller.snapshot().mode, "plain");
assert.equal(controller.snapshot().unsubscribe.plan, "");
assert.equal(controller.snapshot().unsubscribe.detail, "");
controller.setMode("reader");

// A document past the bounds gets the text instead — until somebody insists.
// Long rather than deep: this one is heavy for the layout and still reads as a
// handful of paragraphs, so insisting has something to give back.
const long = new Array(10)
  .fill(`<p>${"word ".repeat(3000)}</p>`)
  .join("");
const heavy = createReaderController({ dispatch: async () => "{}" });
heavy.open({ html: long, text: "the plain reading" });
assert.equal(heavy.snapshot().mode, "reader");
assert.equal(heavy.snapshot().shownMode, "plain");
assert.equal(heavy.snapshot().tooHeavy, true);
assert.equal(heavy.snapshot().presentation.mode, "plain");
heavy.showAnyway();
assert.equal(heavy.snapshot().shownMode, "reader");
assert.equal(heavy.snapshot().tooHeavy, false);
assert.equal(
  heavy.snapshot().presentation.html.match(/<p>/g)?.length,
  10,
  "insisting shows the reading it was refused, not an empty pane",
);
// And the insistence is about this message, not about every one after it.
heavy.open({ html: long });
assert.equal(heavy.snapshot().shownMode, "plain");
heavy.setAlwaysRenderHeavyMessages(true);
assert.equal(heavy.snapshot().shownMode, "reader");

// The other refusal, which is this port's alone: gpui lays out one element per
// block on the thread that draws the window, so past the cap the walk gives
// back nothing at all. Insisting cannot buy what was never built, so the plain
// text stays and the reader says which refusal it is.
const capped = createReaderController({ dispatch: async () => "{}" });
capped.open({
  html: new Array(7000).fill("<p>hostile block</p>").join(""),
  text: "the plain reading",
});
assert.equal(capped.snapshot().shownMode, "plain");
assert.equal(capped.snapshot().tooHeavy, true);
assert.equal(
  capped.snapshot().refused,
  false,
  "the plain text on screen was not refused; the reading has not been asked for yet",
);
capped.showAnyway();
assert.equal(
  capped.snapshot().shownMode,
  "reader",
  "insisting hands the sanitized HTML to TextView",
);
assert.equal(capped.snapshot().refused, false);
assert.ok(capped.snapshot().presentation.html.includes("hostile block"));

// Reading was asked for and there was nothing to rebuild, so the sender's own
// formatting is what is on screen while the picker still says Reader.
const rebuilt = createReaderController({ dispatch: async () => "{}" });
rebuilt.open({ html: "<style>body{display:none}</style>" });
assert.equal(rebuilt.snapshot().mode, "reader");
assert.equal(rebuilt.snapshot().shownMode, "original");
assert.equal(rebuilt.snapshot().readingEmpty, true);
assert.equal(rebuilt.snapshot().hasHtml, true);

// The notice counts the pictures the reading on screen is missing, and the
// standing answer is the controller's rather than the message's.
const pictured = createReaderController({ dispatch: async () => "{}" });
pictured.open({ html: '<p>Look</p><img src="https://images.example.com/a.png">' });
assert.equal(pictured.snapshot().shownMode, "reader");
assert.equal(pictured.snapshot().remoteImages, 1);
assert.equal(pictured.snapshot().remoteImagesAllowed, false);
// Saying yes is a re-parse and never a boolean: whether a picture is withheld
// is decided while the document is walked, so a flag set afterwards hid the
// notice and loaded nothing. The answer names the sources still to fetch.
assert.deepEqual(pictured.showRemoteImages(), [0]);
assert.equal(pictured.snapshot().remoteImagesAllowed, true);
assert.equal(
  pictured.snapshot().images[0].state,
  "blocked",
  "allowing a picture is not fetching it",
);
assert.deepEqual(
  pictured.showRemoteImages(),
  [],
  "the standing answer is given once",
);

// A picture the host fetched goes back into the document it came from, which
// is the only way one ever reaches a reading.
const fetched = createReaderController({
  dispatch: async () =>
    JSON.stringify({
      ok: true,
      data: { dataUri: "data:image/png;base64,AA==" },
    }),
});
fetched.open({
  html: '<p>Look</p><img src="https://images.example.com/b.png">',
});
assert.deepEqual(fetched.showRemoteImages(), [0]);
await fetched.loadImage(0);
assert.equal(fetched.snapshot().images[0].state, "ready");
assert.equal(fetched.snapshot().blockedImages, 0);

// `body` is what every adapter calls the plain text, so a message with no
// markup at all still has something to read. Reading `text` alone left the
// pane blank under "This message has no text to show".
const textOnly = createReaderController({ dispatch: async () => "{}" });
textOnly.open({ body: "Only a plain part" });
assert.equal(textOnly.snapshot().hasHtml, false);
assert.equal(textOnly.snapshot().shownMode, "plain");
assert.equal(textOnly.snapshot().presentation.html, "<p>Only a plain part</p>");
assert.equal(textOnly.snapshot().presentation.empty, false);

// No markup at all: the text is the message rather than one reading of it.
const bare = createReaderController({ dispatch: async () => "{}" });
bare.open({ text: "Just words" });
assert.equal(bare.snapshot().hasHtml, false);
assert.equal(bare.snapshot().shownMode, "plain");
assert.equal(bare.snapshot().tooHeavy, false, "no markup is not a refusal");
assert.equal(bare.snapshot().presentation.html, "<p>Just words</p>");

const hostile = createReaderController({ dispatch: async () => "{}" });
hostile.open({ html: "<p>x</p>", unsubscribe: { oneClick: false, postUrl: "file:///x" } });
await assert.rejects(hostile.unsubscribe());
await assert.rejects(hostile.loadImage(0));

// ---------------------------------------------- the other two ways off a list

// `Unsubscribe.plan` picks between three, in the order of how little the user
// has to do. Two of them are not this controller's own work — a page needs
// something that can open one and a message needs an account that can send —
// so both arrive as the caller's functions. Neither was reachable at all
// before: `plan` was asked with `canSend` hard-coded false and anything but a
// POST threw, so a list offering only a page had a live button that did
// nothing.
const opened = [];
const paged = createReaderController({ dispatch: async () => "{}" });
paged.open({
  html: "<p>Newsletter</p>",
  unsubscribe: {
    available: true,
    oneClick: false,
    url: "https://list.example.com/off/9",
    postUrl: "",
    mail: null,
  },
});
assert.equal(paged.snapshot().unsubscribe.plan, "browser");
assert.equal(paged.snapshot().unsubscribe.state, "ready");
// A page is the only one of the three that leaves the window, and the label
// says so before it is pressed.
assert.equal(paged.snapshot().unsubscribe.label, "Unsubscribe...");
assert.equal(
  paged.snapshot().unsubscribe.detail,
  "Unsubscribing opens this sender's page in a browser",
);
await paged.unsubscribe({ openUrl: (url) => opened.push(url) });
assert.deepEqual(opened, ["https://list.example.com/off/9"]);
// What happened is that a page opened. Whether the list acted on it is between
// the user and that page.
assert.equal(
  paged.snapshot().unsubscribe.detail,
  "The unsubscribe page is open in your browser",
);
assert.equal(paged.snapshot().unsubscribe.label, "");
await paged.unsubscribe({ openUrl: (url) => opened.push(url) });
assert.deepEqual(opened, ["https://list.example.com/off/9"], "answered once");

// The same message on an account that can send: a mailto finishes without
// leaving the window either, so it is preferred to the page.
const outgoing = [];
const posted = createReaderController({ dispatch: async () => "{}" });
const both = {
  available: true,
  oneClick: false,
  url: "https://list.example.com/off/9",
  postUrl: "",
  mail: { to: "leave@list.example.com", subject: "off", body: "Unsubscribe" },
};
posted.open({ html: "<p>Newsletter</p>", unsubscribe: both });
assert.equal(posted.snapshot({ canSend: true }).unsubscribe.plan, "mail");
assert.equal(
  posted.snapshot({ canSend: true }).unsubscribe.detail,
  "Unsubscribing sends a message to this list",
);
// And the same message on an account that cannot: the page, not a button that
// could not do what it said.
assert.equal(posted.snapshot().unsubscribe.plan, "browser");
await posted.unsubscribe({
  canSend: true,
  sendMail: async (message) => outgoing.push(message),
});
assert.deepEqual(outgoing, [
  { to: "leave@list.example.com", subject: "off", body: "Unsubscribe" },
]);
assert.equal(
  posted.snapshot({ canSend: true }).unsubscribe.detail,
  "Unsubscribe request sent to leave@list.example.com",
);

// A send that failed says so and stays pressable, rather than claiming the
// address is off the list.
const refused = createReaderController({ dispatch: async () => "{}" });
refused.open({ html: "<p>x</p>", unsubscribe: both });
await assert.rejects(
  refused.unsubscribe({
    canSend: true,
    sendMail: async () => {
      throw new Error("no");
    },
  }),
);
assert.equal(refused.snapshot({ canSend: true }).unsubscribe.state, "error");

// Both addresses are the sender's, and `plan` reads a shape rather than
// judging one — so each is put back through the gate that produced it before
// it is acted on. A page on the machine this runs on is not a page.
const local = createReaderController({ dispatch: async () => "{}" });
local.open({
  html: "<p>x</p>",
  unsubscribe: {
    available: true,
    oneClick: false,
    url: "http://127.0.0.1/off",
    postUrl: "",
    mail: null,
  },
});
let localOpened = 0;
await assert.rejects(local.unsubscribe({ openUrl: () => (localOpened += 1) }));
assert.equal(localOpened, 0);

const forged = createReaderController({ dispatch: async () => "{}" });
forged.open({
  html: "<p>x</p>",
  unsubscribe: {
    available: true,
    oneClick: false,
    url: "",
    postUrl: "",
    mail: { to: "not an address", subject: "off", body: "Unsubscribe" },
  },
});
let forgedSent = 0;
await assert.rejects(
  forged.unsubscribe({
    canSend: true,
    sendMail: async () => (forgedSent += 1),
  }),
);
assert.equal(forgedSent, 0);

// A record that has been on disk since it was written, and a `to` that would
// come apart into a second recipient or a header of the list's own. It only
// goes out if the parse that produced it gives back exactly what is stored.
for (const to of [
  "leave@list.example.com?bcc=everyone@list.example.com",
  "leave@list.example.com,else@list.example.com",
  "leave@list.example.com\r\nBcc: everyone@list.example.com",
]) {
  const tampered = createReaderController({ dispatch: async () => "{}" });
  tampered.open({
    html: "<p>x</p>",
    unsubscribe: {
      available: true,
      oneClick: false,
      url: "",
      postUrl: "",
      mail: { to, subject: "off", body: "Unsubscribe" },
    },
  });
  let tamperedSent = 0;
  await assert.rejects(
    tampered.unsubscribe({
      canSend: true,
      sendMail: async () => (tamperedSent += 1),
    }),
    undefined,
    to,
  );
  assert.equal(tamperedSent, 0, to);
}

// Nothing on offer is not a button at all.
const none = createReaderController({ dispatch: async () => "{}" });
none.open({ html: "<p>x</p>" });
assert.equal(none.snapshot().unsubscribe.state, "unavailable");
assert.equal(none.snapshot().unsubscribe.detail, "");
await assert.rejects(none.unsubscribe());

console.log("reader controller tests passed");
