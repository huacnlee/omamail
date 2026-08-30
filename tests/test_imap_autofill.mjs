import assert from "node:assert/strict";

import {
  adoptStoredImapSettings,
  applyImapSuggestion,
  bindImapAutofill,
} from "../app/application/imap-autofill.js";

// `ImapSetupPage.qml:57-83`: the address drives the servers until somebody
// edits one, and from then on it must not overwrite what they typed.
//
// The GPUI client had `suggestedSettings` wired to the note only, so the four
// server fields sat on their placeholders and every IMAP mailbox had to be
// typed out by hand.

/** A field state with just the surface this reads and writes. */
function field(value = "") {
  const handlers = [];
  return {
    _value: value,
    value() {
      return this._value;
    },
    set_value(next) {
      this._value = String(next);
    },
    on(event, handler) {
      if (event === "change") handlers.push(handler);
      return true;
    },
    emit(cx) {
      for (const handler of handlers) handler({}, cx);
    },
  };
}

function window() {
  return {
    setupEmail: field(),
    setupUsername: field(),
    setupImapHost: field(),
    setupImapPort: field(),
    setupSmtpHost: field(),
    setupSmtpPort: field(),
  };
}

let notified = 0;
const cx = { notify: () => (notified += 1) };

// ------------------------------------------------- the address fills them in

const app = window();
bindImapAutofill(app, cx);
app.setupEmail.set_value("someone@gmail.com");
app.setupEmail.emit(cx);
assert.equal(app.setupImapHost.value(), "imap.gmail.com");
assert.equal(app.setupSmtpHost.value(), "smtp.gmail.com");
assert.ok(Number(app.setupImapPort.value()) > 0, "a port comes with the host");
assert.ok(Number(app.setupSmtpPort.value()) > 0);
assert.equal(app.setupUsername.value(), "someone@gmail.com");
assert.ok(notified > 0, "the form repaints when the servers change under it");

// A domain nobody has heard of still gets a guess: `imap.<domain>` is right far
// more often than an empty field is useful, and a wrong guess is editable.
const guessed = window();
bindImapAutofill(guessed, cx);
guessed.setupEmail.set_value("someone@nobody-has-heard-of.test");
guessed.setupEmail.emit(cx);
assert.equal(guessed.setupImapHost.value(), "imap.nobody-has-heard-of.test");

// ------------------------------------------------------- and then stops dead

// Editing any of the four latches it, and a later address must not undo that.
const typed = window();
bindImapAutofill(typed, cx);
typed.setupEmail.set_value("someone@gmail.com");
typed.setupEmail.emit(cx);
typed.setupImapHost.set_value("mail.corp.internal");
typed.setupImapHost.emit(cx);
assert.equal(typed.setupServersTouched, true);
typed.setupEmail.set_value("someone@fastmail.com");
typed.setupEmail.emit(cx);
assert.equal(
  typed.setupImapHost.value(),
  "mail.corp.internal",
  "a hand-typed server survives a later change of address",
);
assert.equal(applyImapSuggestion(typed), false);

// A username already typed is not overwritten either — a mailbox whose login is
// not its address is common enough that losing it would be worse than a blank.
const named = window();
bindImapAutofill(named, cx);
named.setupUsername.set_value("jrandom");
named.setupEmail.set_value("someone@gmail.com");
named.setupEmail.emit(cx);
assert.equal(named.setupUsername.value(), "jrandom");

// ------------------------------------------------------ settings off the disk

// `syncFromStore` latches for the same reason: those servers are the user's own.
const stored = window();
bindImapAutofill(stored, cx);
assert.equal(
  adoptStoredImapSettings(stored, { imapHost: "" }),
  false,
  "nothing stored is nothing to adopt",
);
assert.equal(
  adoptStoredImapSettings(stored, {
    imapHost: "mail.example.test",
    imapPort: 993,
    smtpHost: "smtp.example.test",
    smtpPort: 465,
    username: "stored-user",
  }),
  true,
);
assert.equal(stored.setupServersTouched, true);
stored.setupEmail.set_value("someone@gmail.com");
stored.setupEmail.emit(cx);
assert.equal(stored.setupImapHost.value(), "mail.example.test");
assert.equal(stored.setupUsername.value(), "stored-user");

console.log("imap autofill tests passed");
