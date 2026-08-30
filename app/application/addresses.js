// @ts-check

// How an address reads on screen.
//
// Its own module rather than a helper on the window: the mail model needs it,
// and a view model importing the window it describes would be a cycle.

/** @param {unknown} value */
export function displayAddress(value) {
  if (!value || typeof value !== "object") return String(value ?? "");
  const address = /** @type {Record<string, unknown>} */ (value);
  const name = String(address.name ?? address.display ?? "").trim();
  const email = String(address.email ?? address.email_address ?? "").trim();
  return name && email ? `${name} <${email}>` : name || email;
}

/**
 * The one a list row shows. `MessageRow.qml` draws `summary.from.display`,
 * which `Message.parseAddress` builds as the name or, where the sender wrote
 * none, the address.
 *
 * The address beside the name belongs to the reader, which has a full line for
 * it and a reason to show it — checking who actually sent this. In a list it is
 * a second copy of the same sender that pushes the name it repeats off the end
 * of a column already sharing its width with a subject.
 * @param {unknown} value
 */
export function displayName(value) {
  if (!value || typeof value !== "object") return String(value ?? "");
  const address = /** @type {Record<string, unknown>} */ (value);
  const name = String(address.name ?? address.display ?? "").trim();
  const email = String(address.email ?? address.email_address ?? "").trim();
  return name || email;
}
