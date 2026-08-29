// @ts-check

import {
  actionCapability,
  actionUnavailable,
  applyLabelChange,
  cursorAfterOffset,
  cursorAfterReload,
  cursorAfterRemoval,
  removeById,
  replaceById,
  survivesAction,
} from "../account/Model.js";

/** @typedef {{ accountId: string, query: string, revision: number }} RequestIdentity */
/**
 * @typedef {{
 *   accountId: string,
 *   providerId: string,
 *   mailboxKey: string,
 *   query: string,
 *   searchText: string,
 *   request: RequestIdentity,
 *   messages: Array<any>,
 *   cursorId: string | null,
 *   selectedId: string | null,
 *   loading: boolean,
 *   loadingMore: boolean,
 *   nextPageToken: string,
 *   failedPageToken: string,
 *   counts: Record<string,number>,
 *   canRetry: boolean,
 *   status: string
 * }} MailState
 */

/** @param {string} accountId @param {string} providerId @returns {MailState} */
export function createMailState(accountId, providerId) {
  return {
    accountId,
    providerId,
    mailboxKey: "inbox",
    query: "",
    searchText: "",
    request: { accountId, query: "", revision: 0 },
    messages: [],
    cursorId: null,
    selectedId: null,
    loading: false,
    loadingMore: false,
    nextPageToken: "",
    failedPageToken: "",
    counts: {},
    canRetry: false,
    status: "",
  };
}

/** @param {RequestIdentity} left @param {RequestIdentity} right */
function sameRequest(left, right) {
  return (
    left.accountId === right.accountId &&
    left.query === right.query &&
    left.revision === right.revision
  );
}

/** @param {MailState} state @param {any} event @returns {MailState} */
export function reduceMailState(state, event) {
  if (event.type === "load") {
    const query = String(event.query ?? state.query);
    const searchText = String(event.searchText ?? state.searchText);
    return {
      ...state,
      query,
      searchText,
      loading: true,
      loadingMore: false,
      nextPageToken: "",
      failedPageToken: "",
      canRetry: false,
      status: "",
      request: {
        accountId: state.accountId,
        query,
        revision: state.request.revision + 1,
      },
    };
  }

  if (event.type === "list-loaded") {
    if (!sameRequest(state.request, event.request)) return state;
    const messages = Array.isArray(event.messages)
      ? event.messages.slice()
      : [];
    return {
      ...state,
      messages,
      cursorId: cursorAfterReload(messages, state.cursorId) || null,
      selectedId: messages.some(
        (/** @type {any} */ message) => message.id === state.selectedId,
      )
        ? state.selectedId
        : null,
      loading: false,
      loadingMore: false,
      nextPageToken: String(event.nextPageToken || ""),
      failedPageToken: "",
      counts: state.searchText
        ? state.counts
        : { ...state.counts, [state.mailboxKey]: messages.length },
      canRetry: false,
      status: "",
    };
  }

  if (event.type === "load-more") {
    if (!state.nextPageToken || state.loading || state.loadingMore)
      return state;
    return {
      ...state,
      loadingMore: true,
      failedPageToken: "",
      canRetry: false,
      status: "",
    };
  }

  if (event.type === "page-loaded") {
    if (!sameRequest(state.request, event.request)) return state;
    const seen = new Set(state.messages.map((message) => message.id));
    const additions = /** @type {Array<any>} */ ([]);
    (Array.isArray(event.messages) ? event.messages : []).forEach(
      (/** @type {any} */ message) => {
        if (!message?.id || seen.has(message.id)) return;
        seen.add(message.id);
        additions.push(message);
      },
    );
    const messages = state.messages.concat(additions);
    return {
      ...state,
      messages,
      loadingMore: false,
      nextPageToken: String(event.nextPageToken || ""),
      failedPageToken: "",
      counts: state.searchText
        ? state.counts
        : { ...state.counts, [state.mailboxKey]: messages.length },
      canRetry: false,
      status: "",
    };
  }

  if (event.type === "load-failed") {
    if (!sameRequest(state.request, event.request)) return state;
    return {
      ...state,
      loading: false,
      loadingMore: false,
      failedPageToken: String(event.pageToken || ""),
      canRetry: true,
      status: String(event.error || "Mail is unavailable"),
    };
  }

  if (event.type === "mailbox-changed") {
    const mailboxKey = String(event.mailboxKey || "inbox");
    const query = String(event.query || "");
    return {
      ...state,
      mailboxKey,
      query,
      searchText: "",
      messages: [],
      cursorId: null,
      selectedId: null,
      loading: true,
      loadingMore: false,
      nextPageToken: "",
      failedPageToken: "",
      canRetry: false,
      status: "",
      request: {
        accountId: state.accountId,
        query,
        revision: state.request.revision + 1,
      },
    };
  }

  if (event.type === "move-cursor") {
    return {
      ...state,
      cursorId:
        cursorAfterOffset(state.messages, state.cursorId, event.offset) || null,
    };
  }

  if (event.type === "open-cursor") {
    if (!state.cursorId) return state;
    return { ...state, selectedId: state.cursorId };
  }

  if (event.type === "act") {
    const capability = actionCapability(event.action);
    if (capability && event.capabilities?.[capability] !== true) {
      return {
        ...state,
        status: actionUnavailable(event.action, event.providerName),
      };
    }
    const previous = state.messages;
    const message = previous.find((entry) => entry.id === event.messageId);
    if (!message) return state;
    const nextCursor = cursorAfterRemoval(previous, state.cursorId) || null;
    const messages = survivesAction(state.mailboxKey, event.action)
      ? replaceById(previous, applyLabelChange(message, event.action))
      : removeById(previous, event.messageId);
    const removed = messages.length !== previous.length;
    return {
      ...state,
      messages,
      cursorId: removed ? nextCursor : state.cursorId,
      selectedId:
        removed && state.selectedId === event.messageId
          ? null
          : state.selectedId,
      status: "",
    };
  }

  if (event.type === "account-changed") {
    const next = createMailState(event.accountId, event.providerId);
    next.request.revision = state.request.revision + 1;
    return next;
  }

  return state;
}
