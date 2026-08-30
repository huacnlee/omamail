// @ts-check

// What the compose screen is given.
//
// Lifted out of `main.js` for the same reason the mail and calendar models
// were: the window's own shape is easier to read without two hundred lines of
// model in the middle of it, and the file has a size ceiling a test enforces.
//
// The countdown and its toast are deliberately absent. A queued send has left
// the composer — the form behind it is empty and the window is back on the
// list — so the toast is drawn at the window root, not from here.

import { attachFiles } from "./compose-attach.js";
import { retryAttachments } from "./compose-attachments.js";

/**
 * There is no `onSave`. `ComposeView.qml` offers no Save draft button, because
 * leaving the composer already writes the draft — `saveDraftOnLeave` is Back
 * and Escape both — and a button for what happens anyway teaches the wrong
 * thing about when a draft is safe.
 *
 * @param {any} app the window
 * @param {any} draft the compose controller's snapshot
 * @param {any} account the mailbox the draft belongs to
 */
export function composeModel(app, draft, account) {
  const compose = /** @type {any} */ (app.compose);
  return {
    ...draft,
    from: draft.draft.from || String(account?.email || account?.id || ""),
    to: app.composeTo,
    cc: app.composeCc,
    bcc: app.composeBcc,
    subject: app.composeSubject,
    body: app.composeBody,
    // Only what disables Send. The countdown and its toast are drawn
    // at the window root now, because a queued send has left this form
    // and the window has left this page.
    sendPending: Boolean(draft.pending),
    onBack: (/** @type {any} */ _event, /** @type {any} */ eventCx) =>
      app.back(eventCx),
    onSend: (/** @type {any} */ _event, /** @type {any} */ eventCx) => {
      app.sendCompose(eventCx);
    },
    onShowCc: (/** @type {any} */ _event, /** @type {any} */ eventCx) => {
      compose.showCc();
      eventCx.notify();
    },
    onShowBcc: (
      /** @type {any} */ _event,
      /** @type {any} */ eventCx,
    ) => {
      compose.showBcc();
      eventCx.notify();
    },
    onToggleFromMenu: (
      /** @type {any} */ _event,
      /** @type {any} */ eventCx,
    ) => {
      compose.toggleFromMenu();
      eventCx.notify();
    },
    onChooseFrom: (
      /** @type {any} */ identity,
      /** @type {any} */ _event,
      /** @type {any} */ eventCx,
    ) => {
      compose.chooseFrom(identity);
      // Choosing an address on another mailbox moves the draft there,
      // so the window follows it rather than leaving the two
      // disagreeing about which account is current.
      if (identity?.accountId) app.switchAccount(identity.accountId, eventCx);
      eventCx.notify();
    },
    onFocusRecipients: (
      /** @type {""|"to"|"cc"|"bcc"} */ field,
      /** @type {any} */ _event,

      /** @type {any} */ eventCx,
    ) => {
      compose.focusRecipients(field);
      eventCx.notify();
    },
    onAcceptSuggestion: (
      /** @type {any} */ contact,
      /** @type {any} */ _event,
      /** @type {any} */ eventCx,
    ) => {
      compose.acceptSuggestion(contact);
      app.syncComposeFields();
      eventCx.notify();
    },
    // No Attach on a HEY draft. The `hey compose` command carries no files, so
    // `hostRequestFor` refuses one that has any — and a button that fails after
    // the user has committed to it is worse than a button that is not there.
    ...(account?.provider === "hey"
      ? {}
      : {
          onAttach: (
            /** @type {any} */ _event,
            /** @type {any} */ eventCx,
          ) => {
            attachFiles(app, eventCx);
          },
        }),
    // The files the original carries did not arrive, and the composer says so
    // beside a Retry rather than leaving Send held with no way out —
    // `ComposeView`'s Retry, in the same place, doing the same read again.
    onRetryForward: (
      /** @type {any} */ _event,
      /** @type {any} */ eventCx,
    ) => {
      retryAttachments(app, eventCx);
    },
    onRemoveAttachment: (
      /** @type {number} */ index,
      /** @type {any} */ _event,
      /** @type {any} */ eventCx,
    ) => {
      compose.detach(index);
      eventCx.notify();
    },
    onDiscard: (/** @type {any} */ _event, /** @type {any} */ eventCx) => {
      const current = compose.snapshot().draft;
      const discardRevision = compose.snapshot().revision;
      const finish = (
        /** @type {import("gpui").Context} */ activeCx,
      ) => {
        compose.discard();
        app.syncComposeFields();
        app.state = { ...app.state, route: "mail" };
        activeCx.notify();
      };
      if (current.draftId)
        eventCx.spawn(
          (/** @type {import("gpui").AsyncContext} */ asyncCx) => {
            app.executeEffect(
              {
                type: "compose.draft.delete",
                provider: "gmail",
                accountId: current.accountId,
                draftId: current.draftId,
              },
              (/** @type {any} */ result) => {
                const latest = compose.snapshot();
                if (
                  latest.revision !== discardRevision ||
                  latest.draft.accountId !== current.accountId ||
                  latest.draft.draftId !== current.draftId ||
                  app.controller?.snapshot().accounts.activeId !==
                    current.accountId
                )
                  return;
                if (result?.ok === false)
                  compose.setStatus?.(
                    String(
                      result.error || "Draft could not be discarded",
                    ),
                  );
                else {
                  app.controller?.invalidateDrafts(current.accountId);
                  finish(asyncCx);
                }
                asyncCx.notify();
              },
            );
          },
        );
      else finish(eventCx);
    },
  };
}
