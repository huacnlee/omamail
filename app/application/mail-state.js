// @ts-check

import {
  actionCapability,
  actionUnavailable,
  applyLabelChange,
  cursorAfterOffset,
  cursorAfterReload,
  cursorAfterRemoval,
  pluralize,
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
 *   notice: string,
 *   noticeAt: number,
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

/**
 * How long a confirmation stays on the status line — `MailAccount`'s
 * `noticeTimer`, at the same four seconds.
 *
 * Counted from the moment it went up rather than started on a timer of its
 * own, so one beat of the clock the window already runs takes it down again.
 * `compose/controller.js` retires its toast exactly this way, and a second
 * mechanism for the same thing is two clocks to keep in step.
 */
export const NOTICE_MS = 4000;

/**
 * What the status line says once an action has landed —
 * `MailAccount.actionLabel`, in its words.
 *
 * Said after the server agreed rather than beside the optimistic edit: the row
 * moves the instant the key is pressed, and a sentence claiming the archive
 * happened would be a claim about a request that had not left yet. The plural
 * is for the one action that takes a whole page at once, which is
 * `markAllRead` — "3 messages marked read" rather than "Marked read", because
 * the row that moved is not the only thing that changed.
 *
 * @param {string} action @param {number} [count]
 */
export function actionLabel(action, count = 1) {
  const many = Math.max(1, Math.floor(Number(count) || 1));
  if (action === "markRead" && many > 1)
    return `${pluralize(many, "message")} marked read`;
  if (action === "archive") return "Archived";
  if (action === "unarchive") return "Moved to inbox";
  if (action === "trash") return "Moved to trash";
  if (action === "untrash") return "Restored";
  if (action === "star") return "Starred";
  if (action === "unstar") return "Unstarred";
  if (action === "markRead") return "Marked read";
  if (action === "markUnread") return "Marked unread";
  if (action === "spam") return "Reported as spam";
  return "Done";
}

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
    // A confirmation, kept apart from `status` the way `MailAccount` keeps
    // `actionStatus` apart from `lastError`. They are read in that order and
    // drawn in different colours: "Archived" printed in the urgent colour, or
    // under a failure from before it, reads as the archive having failed.
    notice: "",
    // When it went up, so a beat of the window's clock can take it down.
    noticeAt: 0,
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
      // A refusal is something said, not something that went wrong — the same
      // `note()` the confirmations go through in `MailAccount.act`, and it
      // retires on the same four seconds. Drawn as a failure it would blame
      // the mailbox for a request that was never made.
      return {
        ...state,
        notice: actionUnavailable(event.action, event.providerName),
        noticeAt: Number(event.at) || state.noticeAt,
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
    // An action the user did not ask for must never move them —
    // `MailAccount.act`'s `keepOpen`. Opening an unread message marks it read,
    // and being read is the very thing that disqualifies it from the Unread
    // mailbox, so evicting it there would close the reader the click had just
    // opened. The row stays until the list is next loaded, which is what
    // Gmail's own clients do.
    const keepOpen =
      event.quiet === true && state.selectedId === event.messageId;
    const messages =
      survivesAction(state.mailboxKey, event.action) || keepOpen
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

  // What the server agreed to, in the status line's words. Nothing is said for
  // an action nobody asked for: marking read on open is a consequence of the
  // click rather than a second thing that happened, and `MailAccount` passes
  // `quiet` for exactly that reason.
  if (event.type === "acted") {
    return {
      ...state,
      notice: String(event.notice || ""),
      noticeAt: Number(event.at) || 0,
      status: "",
    };
  }

  // The row put back where it was, because the server refused.
  //
  // `MailAccount.act`'s `restore`: the row is reinserted at the index it left
  // from rather than the whole list being fetched again. A reload leaves the
  // list wrong until a round trip completes and wrong for good if that read
  // fails too, which is the one situation in which the list is already known
  // to be talking to a server that is not answering.
  if (event.type === "act-restore") {
    let messages = state.messages;
    (Array.isArray(event.rows) ? event.rows : []).forEach(
      (/** @type {any} */ row) => {
        if (!row || !row.message) return;
        const id = row.message.id;
        messages = messages.some((/** @type {any} */ entry) => entry.id === id)
          ? replaceById(messages, row.message)
          : messages
              .slice(0, Math.min(Number(row.index) || 0, messages.length))
              .concat(
                [row.message],
                messages.slice(
                  Math.min(Number(row.index) || 0, messages.length),
                ),
              );
      },
    );
    return {
      ...state,
      messages,
      // A page offset taken before the row moved is the offset that belongs
      // with the list being put back.
      nextPageToken: String(event.nextPageToken ?? state.nextPageToken),
      notice: "",
      noticeAt: 0,
      status: String(event.error || "The action could not be completed"),
    };
  }

  // A confirmation that has had its four seconds. One beat of the window's
  // clock, the way `compose/controller.js` retires its own toast.
  if (event.type === "retire-notice") {
    if (state.notice === "") return state;
    if (Number(event.at) - state.noticeAt < NOTICE_MS) return state;
    return { ...state, notice: "", noticeAt: 0 };
  }

  // A list read given up on because an action is about to edit the rows it
  // would rebuild.
  //
  // `MailAccount.act` aborts the request and bumps `listSerial`; here the
  // revision is the serial, and every completion is already guarded by it. A
  // trashed search hit visibly came back when the slowest metadata request
  // answered, because the read that owned those snapshots was allowed to
  // finish and persist them over the edit.
  if (event.type === "interrupt-list") {
    if (!state.loading && !state.loadingMore) return state;
    return {
      ...state,
      loading: false,
      loadingMore: false,
      // A provisional streamed offset can cross ids the interrupted read never
      // settled. No Load more is safer than one that skips them.
      nextPageToken: "",
      request: {
        ...state.request,
        revision: state.request.revision + 1,
      },
    };
  }

  if (event.type === "account-changed") {
    const next = createMailState(event.accountId, event.providerId);
    next.request.revision = state.request.revision + 1;
    // The mailbox the switch is landing in, which is the one being left
    // wherever the account being switched to has it — `Model.mailboxAfterAccountSwitch`
    // decides, and the caller has already asked. Defaulted rather than
    // required so a fresh state is still an inbox.
    if (event.mailboxKey) next.mailboxKey = String(event.mailboxKey);
    return next;
  }

  return state;
}
