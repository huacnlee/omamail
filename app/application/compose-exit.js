// @ts-check

// What leaving the composer does with what is still in it.
//
// `App.saveAndLeaveCompose` is the QML this ports: Back and Escape are the same
// question there, and the answer is not "hide the form". A half-written reply
// that only exists in a process is one the process takes with it, so leaving
// writes it to the provider's Drafts and says so with the toast the window root
// already draws.

/**
 * Save the open draft on the way out.
 *
 * Three differences from the QML, each of them forced by this host rather than
 * chosen:
 *
 * - **Only where the provider can hold a draft.** `ImapClient.saveDraft`
 *   APPENDs to the Drafts folder and `HeyClient.saveDraft` posts one; this
 *   host's groupware backend refuses `compose.draft` for anything but Gmail.
 *   A save that would fail is not attempted — the form keeps the draft instead,
 *   which is where this window has always left it.
 * - **The form is not cleared.** The QML detaches the fields, closes, and keeps
 *   a recovery queue for a save that comes back failed. Here the draft stays in
 *   the form until the save lands, so a failure needs no queue to recover from:
 *   the answer is written back as `draftId`, and re-opening the composer
 *   updates the same draft rather than creating a second one.
 * - **The notice, not the status line.** By the time an answer arrives the
 *   compose page is off screen, so a status set on it would be a message nobody
 *   reads. `setNotice` is the toast at the window root, which is where
 *   `DraftSavedToast` sits.
 *
 * @param {any} app the window
 * @param {import("gpui").Context} cx
 * @returns {boolean} whether a save was started
 */
export function saveDraftOnLeave(app, cx) {
  const compose = /** @type {any} */ (app.compose);
  const snapshot = compose.snapshot();
  // A queued send owns the outbox and the form behind it is a different
  // message. Saving during the undo window would write that one to Drafts and
  // then send it anyway.
  if (snapshot.sending || snapshot.sendPending) return false;
  // One save in flight at a time. Leaving, re-opening and leaving again before
  // the first answer arrives would create a second draft on the server, because
  // the `draftId` that turns the next save into an update is what the first
  // answer carries.
  if (app.savingDraftOnLeave) return false;
  const payload = compose.unsavedDraft();
  if (!payload) return false;
  const accounts = app.controller?.snapshot().accounts ?? app.accountList;
  const account = accounts.accounts.find(
    (/** @type {any} */ entry) => entry.id === payload.accountId,
  );
  if (account?.provider !== "gmail") return false;
  app.savingDraftOnLeave = true;
  cx.spawn((/** @type {import("gpui").AsyncContext} */ asyncCx) => {
    app.executeEffect(
      {
        type: "compose.draft",
        provider: "gmail",
        accountId: account.id,
        draft: payload,
      },
      (/** @type {any} */ saved) => {
        app.savingDraftOnLeave = false;
        if (saved?.ok === false)
          compose.setNotice(`Could not save draft: ${saved.error}`);
        else {
          compose.setNotice("Draft saved");
          // The row for this draft is new, or its subject has just changed.
          app.controller?.invalidateDrafts(account.id);
          if (saved?.value?.id) compose.update({ draftId: saved.value.id });
        }
        app.startOutboxClock(asyncCx);
        asyncCx.notify();
      },
    );
  });
  return true;
}
