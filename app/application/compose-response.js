// @ts-check

// Reply, reply all and forward: the composer, and the message being answered.
//
// Lifted out of `main.js` the way the menus and the models were, and for one
// more reason of its own — the window's copy of this asked the controller to
// *open* the message whenever the body was not already loaded, and opening a
// message is what puts the reader on screen. Reply from a row's menu therefore
// went to the reader first and to the composer a moment later, which is not
// what anybody chose Reply for. `controller.loadDetail` is the half of
// `openCursor` that reads without showing, and this is what asks for it.
//
// What happens while the read is in flight is a decision this port has to make
// on its own, because the QML does not have one to copy. `App.qml` answers
// from the list by opening the message and *holding* the draft — see
// `composeFromCursor` and `resumeHeldCompose` — so its wait is spent in the
// reader, watching the skeleton. That is exactly the behaviour being reported
// as the bug here, so it is not the thing to port. The composer opens at once
// instead, carrying everything the list row already knows, and the quote, the
// threading headers and the addresses only the full read can know land in a
// form that is already up. Send is held until they do — a reply sent without
// them would quote nothing and thread against no message — and the status line
// says what is being waited for.

import { accountIn, providerFor, sendRefusal } from "./account-capabilities.js";

/**
 * Which of the three verbs a mailbox may be asked for.
 * @param {any} provider @param {string} mode
 */
function canAnswer(provider, mode) {
  const supported =
    mode === "replyAll"
      ? ["gmail", "imap"]
      : ["gmail", "hey", "imap"];
  return supported.includes(provider.id) && provider.capabilities.send;
}

/**
 * Begin the draft one of the three verbs makes out of a message. Reply-all is
 * the only one that needs to know who the user is, because it is the only one
 * that has to leave them off the recipients.
 * @param {any} app @param {string} mode @param {any} message @param {string} own
 */
function beginAnswer(app, mode, message, own) {
  const compose = /** @type {any} */ (app.compose);
  if (mode === "replyAll") compose.replyAll(message, own);
  else compose[mode](message);
}

/**
 * A list row, as a message to answer before its body has arrived.
 *
 * It carries no ids, and that is deliberate: `sourceFields` threads a draft
 * against `message.id` where the message has no Message-ID of its own, and a
 * row's id is the server's handle for it rather than a header any other mail
 * server has ever heard of. Threading arrives with the read. Until it does the
 * draft carries none — which is also why it may not be sent yet, and why one
 * saved on the way out is saved without them rather than with something made
 * up.
 * @param {any} row @param {string} accountId
 */
function fromRow(row, accountId) {
  return {
    ...row,
    accountId,
    id: "",
    messageId: "",
    inReplyTo: "",
    references: "",
    threadId: "",
    body: "",
  };
}

/**
 * The message the answer is about.
 *
 * A row's menu names one; the keys and the reader's own buttons name none and
 * mean whatever is being read, falling back to the row under the cursor. An
 * already-loaded body counts only where it is a body *of that message* — the
 * reader can be open on one message while the menu is raised on another, and
 * answering the wrong one is worse than waiting for the right one.
 * @param {any} snapshot @param {string} targetId
 */
function subjectOf(snapshot, targetId) {
  const mail = snapshot?.mail;
  const detail = snapshot?.detail ?? null;
  const id = String(targetId || "");
  // The cursor before the selection, which is the order `openCursor` read them
  // in and the order `composeFromCursor` reads them in: with nothing open, or
  // with a body that has not arrived, the message meant is the row the
  // keyboard is on.
  if (!id)
    return { id: String(mail?.cursorId || mail?.selectedId || ""), detail };
  return { id, detail: String(detail?.id || "") === id ? detail : null };
}

/**
 * The body arrived — or did not. Either way the form has been live throughout,
 * so nothing here may overwrite what somebody has typed into it: every field
 * the user left alone takes the answer's version, every field they touched
 * keeps theirs, and the body they wrote goes above the quote the way a reply
 * is written.
 * @param {any} app @param {string} mode @param {any} opened the draft as it opened
 * @param {any} loaded @param {string} error @param {string} own @param {string} accountId
 */
function fillAnswer(app, mode, opened, loaded, error, own, accountId) {
  const compose = /** @type {any} */ (app.compose);
  if (!loaded) {
    compose.loadedQuote(error || "The message you are answering could not be read");
    return;
  }
  const typed = compose.snapshot();
  beginAnswer(app, mode, { ...loaded, accountId }, own);
  const answer = compose.snapshot().draft;
  const kept = /** @type {any} */ ({});
  for (const field of ["to", "cc", "bcc", "subject"])
    kept[field] =
      typed.draft[field] === opened[field] ? answer[field] : typed.draft[field];
  // The body is the one field with two authors. Whatever was written was
  // written above a quote that was not there yet, so the quote goes under it.
  kept.body = typed.draft.body
    ? `${typed.draft.body}\n\n${answer.body}`
    : answer.body;
  compose.update(kept);
  // Beginning a draft rebuilds the form around it, so anything the form was
  // holding is put back: files chosen while the read was in flight belong to
  // this draft, and a copy row somebody typed into has to stay open.
  for (const file of typed.attachments ?? []) compose.attach(file);
  if (kept.cc && !compose.snapshot().ccVisible) compose.showCc();
  if (kept.bcc && !compose.snapshot().bccVisible) compose.showBcc();
  compose.loadedQuote();
  app.syncComposeFields();
}

/**
 * Answer a message: reply, reply all, or forward.
 *
 * `targetId` names the message where the caller has one — the row menu does,
 * because the menu can be raised on a row that is neither open nor under the
 * cursor. Everything else leaves it out and means the message being read, or
 * the row the keyboard is on.
 *
 * @param {any} app the window
 * @param {"reply"|"replyAll"|"forward"} mode
 * @param {import("gpui").Context} cx
 * @param {string} [targetId]
 */
export function openResponse(app, mode, cx, targetId = "") {
  app.primeCompose(cx);
  const snapshot = app.controller?.snapshot();
  const account = accountIn(snapshot);
  const provider = providerFor(account);
  if (!canAnswer(provider, mode)) {
    app.controller?.refuse(
      sendRefusal(account) || `${provider.name} cannot reply from Omamail`,
    );
    cx.notify();
    return;
  }
  const accountId = String(snapshot?.accounts.activeId || "");
  const own = String(account?.email || account?.id || "");
  const wanted = subjectOf(snapshot, targetId);
  const show = () => {
    app.syncComposeFields();
    app.state = { ...app.state, route: "compose" };
  };
  // The body is already here — read a moment ago, or off the body cache. There
  // is nothing to wait for and nothing to fill in later.
  if (wanted.detail) {
    beginAnswer(app, mode, { ...wanted.detail, accountId }, own);
    show();
    cx.notify();
    return;
  }
  const row = (snapshot?.mail?.messages ?? []).find(
    (/** @type {any} */ message) => String(message.id) === wanted.id,
  );
  // Nothing named and nothing under the cursor: there is no message to answer,
  // and an empty composer is not what Reply means.
  if (!row) {
    cx.notify();
    return;
  }
  beginAnswer(app, mode, fromRow(row, accountId), own);
  const compose = /** @type {any} */ (app.compose);
  // Half a quote is worse than none: an "On ... wrote:" line with nothing
  // under it would end up rewritten beneath whatever was typed above it. The
  // body stays empty until the read lands, which is also the room to start
  // typing in.
  compose.update({ body: "" });
  compose.loadingQuote();
  show();
  const opened = compose.snapshot().draft;
  // Which answer this window is waiting for. A second Reply, on this message
  // or another, makes the first one's answer stale: it would land in a draft
  // that is no longer the one it was fetched for.
  const token = {};
  app.answering = token;
  /** @type {(value:any) => void} */
  let arrived = () => {};
  const read = new Promise((resolve) => {
    arrived = resolve;
  });
  cx.spawn(async (/** @type {import("gpui").AsyncContext} */ asyncCx) => {
    const answer = await read;
    if (app.answering === token && compose.snapshot().draft.mode === mode) {
      app.answering = null;
      fillAnswer(app, mode, opened, answer.detail, answer.error, own, accountId);
    }
    asyncCx.notify();
  });
  if (app.controller)
    app.controller.loadDetail(
      wanted.id,
      (/** @type {any} */ detail, /** @type {string} */ error) =>
        arrived({ detail, error }),
    );
  else arrived({ detail: null, error: "" });
  cx.notify();
}
