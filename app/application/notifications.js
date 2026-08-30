// @ts-check

import {
  notificationBody,
  notificationTitle,
  pluralize,
} from "../account/Model.js";

/**
 * What a desktop notification for newly arrived mail says.
 *
 * `MailAccount.notify`, minus the process: one message is announced by its
 * sender and its subject, and a batch is announced once. One notification per
 * message turns a sync that fetched eleven of them into a wall of popups, and
 * the popups outlive the window that raised them.
 *
 * The text is a stranger's, so it comes through `Model.notificationText` —
 * escaped, because a notification daemon reads markup out of a body, and with
 * a leading dash stripped, because these values become arguments.
 *
 * @param {Array<any>} arrivals
 * @returns {{summary: string, body: string} | null}
 */
export function notificationRequest(arrivals) {
  const list = Array.isArray(arrivals) ? arrivals : [];
  if (list.length === 0) return null;
  if (list.length === 1)
    return {
      summary: notificationTitle(list[0]),
      body: notificationBody(list[0]),
    };
  return {
    summary: pluralize(list.length, "new message"),
    body: list
      .slice(0, 3)
      .map((/** @type {any} */ summary) => notificationTitle(summary))
      .join(", "),
  };
}
