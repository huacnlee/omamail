// @ts-check

// The window's end of the single-instance door.
//
// `App.qml` has an `open(payloadJson)` the Omarchy shell calls when something
// summons the plugin: a mailbox to select, a message to open, a `mailto:` URL
// to write. The standalone client is not hosted by a shell, so the same job
// arrives down a Unix socket instead — `src/command_router.rs` — and this is
// `open()`'s half of it.
//
// Three verbs, the same three `bar/Status.js` builds an argument vector for.
// The vocabulary is closed on both sides: what crosses is a verb and, on
// exactly one of them, a `mailto:` URL. Nothing here can be asked to run a
// program, read a file, or reach an account it was not already showing.

import { parse as parseMailto } from "../message/Mailto.js";

/**
 * Do what another launch of Omamail asked this window to do.
 *
 * Separated from the socket so it can be tested without one, and so the
 * dispatch reads as the three cases it is.
 *
 * @param {any} app the window
 * @param {{verb?: string, payload?: string}} command
 * @param {any} cx
 * @returns {boolean} whether the command was one this window knows
 */
export function applyCommand(app, command, cx) {
  switch (command?.verb) {
    // Nothing to draw: the window is the application, so being asked to open
    // it means bringing it forward, which the caller has already done.
    case "open":
      return true;
    case "refresh":
      // Refused while a read is already in the air, which is what makes a bar
      // that is clicked twice ask once.
      app.controller?.refresh();
      cx.notify();
      return true;
    case "compose-mailto": {
      const draft = parseMailto(String(command.payload || ""));
      // `Mailto.parse` answers null for anything that is not a mailto: URL.
      // The router refuses those already; this is the second reader agreeing
      // rather than assuming.
      if (!draft) return false;
      openMailto(app, draft, cx);
      return true;
    }
    default:
      return false;
  }
}

/**
 * `App.openDraft`, for a draft that came from outside the window.
 *
 * The account is whichever mailbox is current. A link carries no mailbox, and
 * the QML has the same answer: `compose.beginDraft` writes from the account the
 * window is already showing.
 *
 * @param {any} app @param {any} draft @param {any} cx
 */
function openMailto(app, draft, cx) {
  app.primeCompose(cx);
  const accounts = app.controller?.snapshot().accounts ?? app.accountList;
  /** @type {any} */ (app.compose).mailto({
    accountId: accounts.activeId,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    body: draft.body,
  });
  app.syncComposeFields();
  app.state = { ...app.state, route: "compose" };
  cx.notify();
}

/**
 * Wait on the door for as long as the window is up.
 *
 * `next()` parks until something arrives rather than answering "nothing yet",
 * so this is one suspended task and not a poll — the window goes idle between
 * links the way it does between messages.
 *
 * The command the process was started with is already in the queue before this
 * runs, which is what makes `omamail mailto:…` on a cold start fill the
 * composer on the first paint instead of after a round trip.
 *
 * A host without the module is a host that cannot be reached from outside: the
 * window still works, so the failure is silent and the loop simply never
 * starts. That is also what makes this safe under the test harness.
 *
 * @param {any} app the window
 * @param {import("gpui").Context} cx
 */
export function startCommandListener(app, cx) {
  if (app.commandListenerRunning) return;
  app.commandListenerRunning = true;
  void cx.spawn(async (/** @type {any} */ asyncCx) => {
    /** @type {any} */
    let host;
    try {
      host = await import("omamail-command");
    } catch (_) {
      app.commandListenerRunning = false;
      return;
    }
    for (;;) {
      /** @type {any} */
      let command;
      try {
        command = JSON.parse(await host.next());
      } catch (_) {
        // The promise only rejects if the door itself is gone. Looping on that
        // would spin, so the window stops listening and goes on being a
        // mailbox.
        app.commandListenerRunning = false;
        return;
      }
      // Every command means somebody outside asked for this window, so it comes
      // forward whether or not the verb draws anything. Wayland may decline
      // without an activation token; there is nothing useful to do about that
      // here, and the draft is filled in either way.
      try {
        host.activate();
      } catch (_) {}
      applyCommand(app, command, asyncCx);
    }
  });
}
