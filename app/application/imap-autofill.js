// @ts-check

// The address filling in the servers, and stopping the moment it shouldn't.
//
// `ImapSetupPage.qml:57-83` is the whole of this: the address drives the four
// server fields until somebody edits one by hand, and from then on a later
// keystroke in the address must not overwrite what they typed. The GPUI client
// had `suggestedSettings` wired to the *note* only, so the four fields stayed
// on their placeholders and every IMAP mailbox had to be typed out in full.
//
// The window owns the field states, so this takes them rather than reading
// them off a view — the same split the QML page keeps between `applySuggestion`
// and the fields it writes to.

import { imapSuggestion } from "../setup/controller.js";

/**
 * Fill the servers from the address, unless they have been taken over.
 *
 * The suggestion is derived from the field's value here rather than from a
 * value captured earlier: a `change` event arrives before the last keystroke
 * is guaranteed to have been observed elsewhere, and reading it late is what
 * stops typing the final "m" of ".com" from leaving the guess on ".co" — the
 * QML comment on `applySuggestion` records the same trap.
 *
 * @param {any} app the window
 */
export function applyImapSuggestion(app) {
  if (app.setupServersTouched) return false;
  // `any`, because the fallback branch of `imapSuggestion` answers with the
  // four fields it can promise and none of the ports, and the caller wants the
  // whole shape or nothing from it.
  const suggestion = /** @type {any} */ (
    imapSuggestion(app.setupEmail?.value?.() ?? "")
  );
  if (!suggestion?.imapHost) return false;
  app.setupImapHost?.set_value?.(String(suggestion.imapHost));
  app.setupImapPort?.set_value?.(String(suggestion.imapPort ?? ""));
  app.setupSmtpHost?.set_value?.(String(suggestion.smtpHost ?? ""));
  app.setupSmtpPort?.set_value?.(String(suggestion.smtpPort ?? ""));
  // The username field follows the address too, but only while it is empty:
  // a mailbox whose login is not its address is common enough that overwriting
  // a typed one would be worse than leaving it blank.
  if (!String(app.setupUsername?.value?.() ?? "").trim())
    app.setupUsername?.set_value?.(String(suggestion.username ?? ""));
  return true;
}

/**
 * Bind the address to the servers, and each server to the latch that stops it.
 *
 * Called once, from `init`. Editing any of the four fields sets the latch for
 * good, which is `serversTouched` — settings that came off disk set it too, in
 * `adoptStoredImapSettings`, because those are the user's own.
 *
 * @param {any} app the window
 * @param {import("gpui").Context} cx
 */
export function bindImapAutofill(app, cx) {
  app.setupServersTouched = false;
  app.setupEmail?.on?.("change", (/** @type {any} */ _event, /** @type {any} */ eventCx) => {
    if (applyImapSuggestion(app)) (eventCx ?? cx).notify();
  });
  for (const field of [
    app.setupImapHost,
    app.setupImapPort,
    app.setupSmtpHost,
    app.setupSmtpPort,
  ])
    field?.on?.("change", () => {
      app.setupServersTouched = true;
    });
}

/**
 * Settings read back from the store are the user's own, so the address must
 * not overwrite them — `syncFromStore` in the QML page latches for the same
 * reason.
 *
 * @param {any} app the window
 * @param {any} settings
 */
export function adoptStoredImapSettings(app, settings) {
  if (!settings || !String(settings.imapHost || "")) return false;
  app.setupImapHost?.set_value?.(String(settings.imapHost));
  app.setupImapPort?.set_value?.(String(settings.imapPort ?? ""));
  app.setupSmtpHost?.set_value?.(String(settings.smtpHost ?? ""));
  app.setupSmtpPort?.set_value?.(String(settings.smtpPort ?? ""));
  if (String(settings.username || ""))
    app.setupUsername?.set_value?.(String(settings.username));
  app.setupServersTouched = true;
  return true;
}
