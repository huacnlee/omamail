// @ts-check

import * as Api from "../providers/GmailApi.js";
import * as Message from "../message/Message.js";
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
    },
  };
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
      return port.dispatch(
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
        (/** @type {any} */ result) =>
          callback?.(normalizeMessageResult(result, true)),
        errorFor,
      );
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
