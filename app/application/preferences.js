// @ts-check

// What the stored settings mean to the machinery that reads mail.
//
// This is `MailAccount.qml`'s block of `readonly property` declarations — the
// four bindings that turn whatever the settings object happens to hold into a
// page size, a query, a poll interval and a yes or no. The settings controller
// has already coerced what the user typed, but a value also arrives from
// `localStorage`, where an older build or a hand-edited store can leave
// anything at all; the QML clamps for the same reason and this is where that
// judgement lives so the list read and the refresh clock cannot disagree about
// it.

/**
 * How many messages one page of a mailbox asks the server for.
 * @param {unknown} value
 */
export function listSize(value) {
  return Math.max(5, Math.min(100, Math.floor(Number(value)) || 25));
}

/**
 * The search a mailbox opens with. Trimmed here rather than at the seam that
 * sends it, because `Registry.query` compares it against `in:inbox` to decide
 * whether it is the manifest's inherited Gmail default.
 * @param {unknown} value
 */
export function defaultQuery(value) {
  return value === undefined || value === null
    ? "in:inbox"
    : String(value).trim();
}

/**
 * How long the refresh clock sleeps between reads.
 * @param {unknown} value
 */
export function refreshSeconds(value) {
  return Math.max(30, Math.min(3600, Math.floor(Number(value)) || 120));
}

/**
 * Whether new mail earns a desktop notification. Off is the only answer that
 * turns it off: the shell writes this as one of two option strings, so
 * anything else — an unset key, a value from a build that spelled it
 * differently — leaves the notification on, which is the shipped default.
 * @param {unknown} value
 */
export function notifiesNewMail(value) {
  return value === undefined || value === null
    ? true
    : String(value) !== "Off";
}
