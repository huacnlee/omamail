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
 *   loaded: boolean,
 *   loadingMore: boolean,
 *   nextPageToken: string,
 *   failedPageToken: string,
 *   counts: Record<string,number>,
 *   canRetry: boolean,
 *   signedOut: boolean,
 *   status: string,
 *   syncedAtMs: number
 * }} MailState
 */

/**
 * What the host answers with when the mailbox has no stored credential left —
 * `ProviderFailure::SignedOut`'s own words, which `tests/test_source.sh` pins
 * to this constant. It is the one failure the person at the window can act on,
 * so the list offers the way back in instead of a Retry that cannot work.
 */
export const SIGNED_OUT = "provider requires sign-in";

/** @param {unknown} error */
export function isSignedOut(error) {
  return String(error ?? "").includes(SIGNED_OUT);
}

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
    // Whether a list has ever answered for this mailbox. Distinct from "not
    // loading": a first read that failed is not an empty mailbox, and the list
    // printing "Nothing here" over the error was the window agreeing with the
    // failure instead of reporting it.
    loaded: false,
    loadingMore: false,
    nextPageToken: "",
    failedPageToken: "",
    counts: {},
    canRetry: false,
    // Set by a read the host refused for want of a credential. Distinct from
    // any other failure: nothing this window can retry will fix it.
    signedOut: false,
    status: "",
    // When the server last answered. The status line says how current the list
    // is rather than how long it is: a count of what is loaded is a number the
    // user can already see, and "Synced 5m ago" is the thing they cannot.
    syncedAtMs: 0,
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
    // A search replaces the list; a refresh asks the same question again. The
    // rows of the mailbox that was open are not results, and leaving them up
    // while the query runs labels somebody else's mail as the answer to it —
    // so the caller that is replacing the list says so, and the one that is
    // reloading it keeps what is on screen.
    const replaces = event.reset === true;
    return {
      ...state,
      query,
      searchText,
      messages: replaces ? [] : state.messages,
      cursorId: replaces ? null : state.cursorId,
      selectedId: replaces ? null : state.selectedId,
      loaded: replaces ? false : state.loaded,
      loading: true,
      loadingMore: false,
      nextPageToken: "",
      failedPageToken: "",
      canRetry: false,
      signedOut: false,
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
      loaded: true,
      loadingMore: false,
      syncedAtMs: Number(event.receivedAtMs) || state.syncedAtMs,
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
      signedOut: false,
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
      loaded: true,
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
      // A signed-out mailbox answers every read the same way, so a Retry
      // button here is a control that promises to do something and cannot.
      canRetry: !isSignedOut(event.error),
      signedOut: isSignedOut(event.error),
      status: isSignedOut(event.error)
        ? "This mailbox is signed out"
        : String(event.error || "Mail is unavailable"),
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
      loaded: false,
      loadingMore: false,
      nextPageToken: "",
      failedPageToken: "",
      canRetry: false,
      signedOut: false,
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
    // Worked out before the action, while the departing row still has
    // neighbours. Anchored on the row that is leaving rather than on the
    // cursor: a row's own button and the context menu both act on a row the
    // keyboard is not standing on, and pulling the cursor off a message that
    // is still listed is a step nobody asked for.
    const nextCursor = cursorAfterRemoval(previous, event.messageId) || null;
    const messages = survivesAction(state.mailboxKey, event.action)
      ? replaceById(previous, applyLabelChange(message, event.action))
      : removeById(previous, event.messageId);
    const removed = messages.length !== previous.length;
    return {
      ...state,
      messages,
      cursorId:
        removed && state.cursorId === event.messageId
          ? nextCursor
          : state.cursorId,
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
