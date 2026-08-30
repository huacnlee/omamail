// @ts-check

// Who the recipient completion is allowed to offer.
//
// Two address books, kept apart because they answer different questions.
// `Service.refreshRecipientContacts` reads the desktop's — Thunderbird's and
// Betterbird's own SQLite files, through `scripts/contact-suggestions.py` — and
// that is the one this client had none of. Its own is the people the open
// mailbox has been corresponding with, which is the better answer for a reply
// and no answer at all for a first message to somebody new.

/**
 * The senders on the open mailbox, newest first and one row per address.
 * @param {any} app the window
 * @returns {Array<{name:string,email:string}>}
 */
export function mailboxContacts(app) {
  const snapshot = app.controller?.snapshot();
  /** @type {Map<string, {name:string,email:string}>} */
  const seen = new Map();
  for (const message of snapshot?.mail?.messages ?? []) {
    const address = message.sender ?? message.from;
    const email = String(address?.email ?? "").trim();
    if (!email || seen.has(email.toLowerCase())) continue;
    seen.set(email.toLowerCase(), {
      name: String(address?.name ?? "").trim(),
      email,
    });
  }
  return [...seen.values()];
}

/**
 * Both books, with the mailbox's own in front.
 *
 * `Recipients.suggest` ranks and de-duplicates, so the order here only decides
 * which of two records for one address keeps its display name — and the one
 * off a message this mailbox actually received is the one that agrees with what
 * the list is showing.
 * @param {any} app the window
 */
export function composeContacts(app) {
  return [...mailboxContacts(app), ...(app.addressBook ?? [])];
}

/**
 * Read the desktop's address book once per run and hand it to the controller.
 *
 * Once, not per composition: it is a file on disk that a mail client is not
 * writing to, and `Service.qml` reads it on start and on opening the composer
 * for the same reason — the cost is a subprocess and a SQLite open.
 *
 * Everything about it is best-effort. No Thunderbird, no Python, no host module
 * — all the same outcome, which is the completion falling back to the senders
 * it already had. There is nothing here worth a message to the user.
 *
 * @param {any} app the window
 * @param {import("gpui").Context} cx
 */
export function loadAddressBook(app, cx) {
  if (app.addressBookRead) return;
  app.addressBookRead = true;
  const read =
    app.contactsHost ??
    (() => import("omamail-contacts").then((host) => host.read()));
  cx.spawn(async (/** @type {import("gpui").AsyncContext} */ asyncCx) => {
    /** @type {any} */
    let answer = null;
    try {
      answer = JSON.parse(String(await read()));
    } catch (_) {
      return;
    }
    if (!answer || !Array.isArray(answer.contacts) || answer.contacts.length === 0)
      return;
    app.addressBook = answer.contacts.map((/** @type {any} */ contact) => ({
      name: String(contact.name || ""),
      email: String(contact.email || ""),
    }));
    /** @type {any} */ (app.compose).useContacts(composeContacts(app));
    asyncCx.notify();
  });
}
