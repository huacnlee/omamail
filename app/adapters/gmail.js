// @ts-check

import * as Api from "../providers/GmailApi.js";
import * as Calendar from "../message/Calendar.js";
import * as Message from "../message/Message.js";
import * as Unsubscribe from "../message/Unsubscribe.js";
import { redactError } from "./effect-port.js";

/** @param {any} operation */
function identityOf(operation) {
  return operation && operation.identity ? operation.identity : {};
}

/** @param {string} action */
function labelsFor(action) {
  if (action === "markRead")
    return { addLabelIds: [], removeLabelIds: ["UNREAD"] };
  if (action === "markUnread")
    return { addLabelIds: ["UNREAD"], removeLabelIds: [] };
  if (action === "star")
    return { addLabelIds: ["STARRED"], removeLabelIds: [] };
  if (action === "unstar")
    return { addLabelIds: [], removeLabelIds: ["STARRED"] };
  if (action === "archive")
    return { addLabelIds: [], removeLabelIds: ["INBOX"] };
  if (action === "unarchive")
    return { addLabelIds: ["INBOX"], removeLabelIds: [] };
  if (action === "spam") return { addLabelIds: ["SPAM"], removeLabelIds: [] };
  return null;
}

/** @param {any} reply */
function errorFor(reply) {
  return redactError(
    Api.responseError(reply.status, reply.payload, redactError(reply.error)),
  );
}

/** @param {any} result @param {boolean} detail */
function normalizeMessageResult(result, detail) {
  if (!result || !result.ok) return result;
  const value = result.value;
  const resources = detail ? [value] : value?.messages;
  if (
    !Array.isArray(resources) ||
    resources.some((message) => !message?.id || !message?.payload)
  )
    return {
      ok: false,
      value: null,
      error: "Mail host returned invalid message data",
      identity: result.identity,
    };
  const messages = resources.map((message) => Message.summarize(message));
  if (!detail)
    return {
      ...result,
      value: {
        messages,
        nextPageToken:
          typeof value?.nextPageToken === "string" ? value.nextPageToken : "",
      },
    };
  const message = resources[0];
  const body = Message.extractBody(message.payload);
  return {
    ...result,
    value: {
      ...messages[0],
      body: body.text,
      html: Message.extractHtml(message.payload),
      attachments: Message.attachments(message.payload).map((attachment) => ({
        ...attachment,
        partId: attachment.attachmentId,
      })),
      // Read out of the same fetch as the body, the way `MailAccount`'s detail
      // read does, and never out of a list row: both are answers about a whole
      // message, and both are what the reader draws its invitation card and
      // its unsubscribe notice from.
      invite: Calendar.fromPayload(message.payload),
      unsubscribe: Unsubscribe.fromMessage(message),
    },
  };
}

// The invitation Google described rather than sent.
//
// Gmail withholds the octets of every part the sender named, and Google
// Calendar names both of the two it sends — so on Gmail a Google invitation
// always arrives as an id and one more request. `MailAccount.loadInvite` makes
// that request after the body is on screen; here it is made before the detail
// is handed on, because an adapter answers a detail read once and a second
// answer would re-open the reader over a message somebody is already reading.
//
// A part id the host would refuse, a fetch that fails, or a file that is not a
// calendar all leave the message exactly as it was: the invitation is the one
// thing on this card that can be absent without anything else being wrong.
const ATTACHMENT_ID = /^[A-Za-z0-9:._-]{1,2048}$/;

/**
 * @param {any} normalized the detail the message read became
 * @param {any} payload the MIME tree it came from
 * @returns {any} the part to ask for, or null
 */
function pendingInvitePart(normalized, payload) {
  if (!normalized?.ok || normalized.value?.invite || !payload) return null;
  const part = /** @type {any} */ (Calendar.pendingPart(payload));
  const id = String(part?.body?.attachmentId || "");
  return part && ATTACHMENT_ID.test(id) ? part : null;
}

/**
 * The fetched file, read back through the part that named it so the charset
 * the sender declared still decides how it is read. Refused before it is
 * decoded when it is larger than a calendar file may be — this runs on the
 * thread that draws the window, and a part that would be refused for its size
 * should not become half a megabyte of string first.
 * @param {any} normalized @param {any} part @param {any} attachment
 */
function withFetchedInvite(normalized, part, attachment) {
  const data = attachment?.ok === true ? String(attachment.value?.data || "") : "";
  if (data === "" || data.length > Calendar.MAX_ICS_BYTES * 2) return normalized;
  const invite = Calendar.fromAttachment(part, data);
  return invite ? { ...normalized, value: { ...normalized.value, invite } } : normalized;
}

/** @param {any} port @param {Array<any>} effects @param {any} callback */
function dispatchAll(port, effects, callback) {
  let remaining = effects.length;
  let firstFailure = /** @type {any} */ (null);
  const handles = effects.map((effect) =>
    port.dispatch(
      effect,
      (/** @type {any} */ result) => {
        if (!result.ok && !firstFailure) firstFailure = result;
        remaining -= 1;
        if (remaining === 0 && typeof callback === "function")
          callback(
            firstFailure || {
              ok: true,
              value: null,
              error: "",
              identity: effect.identity,
            },
          );
      },
      errorFor,
    ),
  );
  return {
    cancel() {
      handles.forEach((handle) => {
        if (handle && typeof handle.cancel === "function") handle.cancel();
      });
    },
  };
}

/** @param {any} port */
export function createGmailAdapter(port) {
  if (!port || typeof port.dispatch !== "function")
    throw new TypeError("an effect port is required");

  return {
    /** @param {any} operation @param {(result: any) => void} [callback] */
    list(operation = {}, callback) {
      const identity = identityOf(operation);
      return port.dispatch(
        {
          kind: "gmail.http",
          scope: "list",
          accountId: identity.accountId,
          identity,
          hostOperation: {
            type: "list",
            query: String(operation.query || ""),
            maxResults: Number(operation.maxResults) || 25,
            pageToken: String(operation.pageToken || ""),
          },
          method: "GET",
          path: Api.messagesPath(),
          query: Api.listQuery(
            operation.query,
            operation.maxResults,
            operation.pageToken,
          ),
          body: null,
        },
        (/** @type {any} */ result) =>
          callback?.(normalizeMessageResult(result, false)),
        errorFor,
      );
    },

    /** @param {any} operation @param {(result: any) => void} [callback] */
    detail(operation = {}, callback) {
      const identity = identityOf(operation);
      /** @type {any} */
      let invitation = null;
      const handle = port.dispatch(
        {
          kind: "gmail.http",
          scope: "object",
          accountId: identity.accountId,
          identity,
          hostOperation: {
            type: "detail",
            messageId: identity.objectId,
            full: operation.full === true,
          },
          method: "GET",
          path: Api.messagePath(identity.objectId),
          query:
            operation.full === true ? Api.fullQuery() : Api.metadataQuery(),
          body: null,
        },
        (/** @type {any} */ result) => {
          const normalized = normalizeMessageResult(result, true);
          const part = pendingInvitePart(normalized, result?.value?.payload);
          if (!part) return callback?.(normalized);
          invitation = port.dispatch(
            {
              kind: "gmail.attachment",
              scope: "object",
              accountId: identity.accountId,
              identity,
              messageId: identity.objectId,
              partId: String(part.body.attachmentId),
            },
            (/** @type {any} */ attachment) =>
              callback?.(withFetchedInvite(normalized, part, attachment)),
            errorFor,
          );
        },
        errorFor,
      );
      return {
        cancel() {
          handle?.cancel?.();
          invitation?.cancel?.();
        },
      };
    },

    /** @param {any} operation @param {(result: any) => void} [callback] */
    action(operation = {}, callback) {
      const identity = identityOf(operation);
      const action = String(operation.action || "");
      const ids = Array.isArray(operation.ids) ? operation.ids : [];
      if (ids.length === 0) return { cancel() {} };
      const single = ids.length === 1;
      if (action === "trash" || action === "untrash") {
        if (typeof operation.onOptimistic === "function")
          operation.onOptimistic();
        const effects = ids.map((/** @type {any} */ id) => ({
          kind: "gmail.http",
          scope: "object",
          accountId: identity.accountId,
          identity,
          hostOperation: { type: "action", action, messageIds: [String(id)] },
          method: "POST",
          path: action === "trash" ? Api.trashPath(id) : Api.untrashPath(id),
          query: null,
          body: null,
        }));
        if (single) return port.dispatch(effects[0], callback, errorFor);
        return dispatchAll(port, effects, callback);
      }
      const labels = labelsFor(action);
      if (!labels) return { cancel() {} };
      if (typeof operation.onOptimistic === "function")
        operation.onOptimistic();
      return port.dispatch(
        {
          kind: "gmail.http",
          scope: "object",
          accountId: identity.accountId,
          identity,
          hostOperation: {
            type: "action",
            action,
            messageIds: ids.map(String),
          },
          method: "POST",
          path: single ? Api.modifyPath(ids[0]) : Api.batchModifyPath(),
          query: null,
          body: single ? labels : { ids, ...labels },
        },
        callback,
        errorFor,
      );
    },
  };
}
