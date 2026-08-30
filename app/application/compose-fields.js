// @ts-check

// The composer's text fields, and what the window does when one of them
// changes or takes the keyboard.
//
// Lifted out of `main.js` the way the models were: five identical `change`
// registrations in the middle of the window's constructor say nothing the sixth
// does not, and the file has a size ceiling a test enforces.

/**
 * Wire the compose form's fields to the draft behind them.
 *
 * The three address rows also report the keyboard, and that is the half the
 * port was missing. `ComposeView.updateRecipientSuggestions` reads
 * `toField.activeFocus` — the completion menu belongs to the field being typed
 * into and to no other — and the controller has answered that question since it
 * was written. Nothing ever asked it, so `focusedField` stayed "" for the life
 * of the window and the popup was drawn exactly never.
 *
 * @param {any} app the window
 */
export function bindComposeFields(app) {
  const compose = /** @type {any} */ (app.compose);
  /** @type {Array<["to"|"cc"|"bcc", any]>} */
  const recipients = [
    ["to", app.composeTo],
    ["cc", app.composeCc],
    ["bcc", app.composeBcc],
  ];
  for (const [field, state] of recipients) {
    state.on("change", (/** @type {any} */ _event, /** @type {any} */ cx) => {
      compose.update({ [field]: state.value() });
      cx.notify();
    });
    state.on("focus", (/** @type {any} */ _event, /** @type {any} */ cx) => {
      compose.focusRecipients(field);
      cx.notify();
    });
    // Leaving a row closes its menu rather than leaving one attached to a
    // field nobody is typing into, which is what the QML's `activeFocus`
    // binding does on the way out.
    state.on("blur", (/** @type {any} */ _event, /** @type {any} */ cx) => {
      if (compose.snapshot().suggestions.field === field)
        compose.focusRecipients("");
      cx.notify();
    });
  }
  app.composeSubject.on(
    "change",
    (/** @type {any} */ _event, /** @type {any} */ cx) => {
      compose.update({ subject: app.composeSubject.value() });
      cx.notify();
    },
  );
  app.composeBody.on(
    "change",
    (/** @type {any} */ _event, /** @type {any} */ cx) => {
      compose.update({ body: app.composeBody.value() });
      cx.notify();
    },
  );
}
