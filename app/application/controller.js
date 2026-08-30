// @ts-check

import {
  actionCapability,
  detailSummary,
  messageById,
  newArrivals,
} from "../account/Model.js";
import { createProviderAdapter } from "../adapters/index.js";
import * as Registry from "../providers/Registry.js";
import { loadAccounts, saveAccounts } from "./account-store.js";
import { createMailState, reduceMailState } from "./mail-state.js";
import { notificationRequest } from "./notifications.js";
import {
  defaultQuery as normalizedDefaultQuery,
  listSize,
  notifiesNewMail,
} from "./preferences.js";

/** @param {any} list @param {string} id */
function accountFor(list, id) {
  const accounts = Array.isArray(list.accounts) ? list.accounts : [];
  return (
    accounts.find(
      (/** @type {any} */ account) => account && account.id === id,
    ) || null
  );
}

/** @param {any} messages */
function unreadCount(messages) {
  return (Array.isArray(messages) ? messages : []).filter(
    (message) =>
      message &&
      (message.unread === true ||
        (Array.isArray(message.labelIds) &&
          message.labelIds.includes("UNREAD"))),
  ).length;
}

/** @param {{ storage: any, execute: any, cache?: any, companion?: any, now?:()=>number, preference?:(key:string)=>any, notify?:(request:{summary:string,body:string})=>void }} dependencies */
export function createApplicationController(dependencies) {
  const values = dependencies || {};
  if (!values.storage || typeof values.execute !== "function")
    throw new TypeError("storage and an effect executor are required");

  // Injectable so a test can say what "now" is; the status line's "Synced 5m
  // ago" is otherwise untestable.
  const clockNow = () =>
    typeof values.now === "function" ? Number(values.now()) : Date.now();

  // Read on every use rather than captured, because Settings writes these
  // while the window is up. `MailAccount` gets that for nothing — its four
  // settings are property bindings, so a changed value re-evaluates
  // `effectiveQuery` and `maxMessages` before the next read uses them — and a
  // controller that had copied them at construction would go on asking the old
  // question until the account was switched.
  /** @param {string} key */
  function preference(key) {
    return typeof values.preference === "function"
      ? values.preference(key)
      : undefined;
  }

  let accounts = /** @type {any} */ ({
    version: 1,
    accounts: [],
    activeId: "",
  });
  let mail = /** @type {any} */ (null);
  let detail = /** @type {any} */ (null);
  let lastOperation = /** @type {any} */ (null);
  const unreadByAccount = /** @type {Record<string, number>} */ ({});
  // What has already been on screen, per account, and whether this account has
  // ever had a list to compare a new one against — `MailAccount`'s `seenIds`
  // and `notificationsPrimed`. Per account rather than per list, because a
  // message that scrolls off page one must not be announced a second time when
  // it comes back, and because the first read of a session is a baseline
  // rather than eleven notifications for mail that was already sitting there.
  const arrivalsByAccount =
    /** @type {Map<string,{seen:Record<string,boolean>,primed:boolean}>} */ (
      new Map()
    );
  const adapters = /** @type {Map<string,any>} */ (new Map());
  const runtimeExpiresAt = new Map();
  const runtimeInFlight =
    /** @type {Map<string,{identity:any,requestedAt:number,waiters:Array<{account:any,identity:any,proceed:(adapter:any)=>void}>}>} */ (
      new Map()
    );
  const now = typeof values.now === "function" ? values.now : Date.now;

  function currentIdentity() {
    return mail ? mail.request : {};
  }

  function activeAccount() {
    return accountFor(accounts, accounts.activeId);
  }

  /** @param {any} identity */
  function isCurrentRequest(identity) {
    return Boolean(
      mail &&
      mail.request.accountId === identity.accountId &&
      mail.request.query === identity.query &&
      mail.request.revision === identity.revision,
    );
  }

  /** @param {any} left @param {any} right */
  function sameRequest(left, right) {
    return (
      left.accountId === right.accountId &&
      left.query === right.query &&
      left.revision === right.revision
    );
  }

  function publishUnread() {
    const total = Object.values(unreadByAccount).reduce(
      (sum, count) => sum + count,
      0,
    );
    if (values.companion && typeof values.companion.setUnread === "function")
      values.companion.setUnread(total);
  }

  function recordUnread() {
    if (!mail) return;
    unreadByAccount[mail.accountId] = unreadCount(mail.messages);
    publishUnread();
  }

  /**
   * Take note of a list that has just been drawn, and announce whatever is new
   * in it — `MailAccount.applySummaries`, whose two jobs these are.
   *
   * `announce` is false for the reads that produce rows without producing new
   * mail: a page appended to the list somebody is already looking at, a search
   * that turned up an old unread message the current page never held, and the
   * cache-first paint, which is a record of what was on screen last time
   * rather than an answer from a server.
   *
   * @param {string} accountId @param {Array<any>} summaries @param {boolean} announce
   */
  function recordArrivals(accountId, summaries, announce) {
    let record = arrivalsByAccount.get(accountId);
    if (!record) {
      record = { seen: {}, primed: false };
      arrivalsByAccount.set(accountId, record);
    }
    const list = Array.isArray(summaries) ? summaries : [];
    const arrivals = announce
      ? newArrivals(list, record.seen, record.primed)
      : [];
    // Marked seen after the comparison and before the notification, so a
    // failure to notify cannot announce the same message twice.
    list.forEach((/** @type {any} */ message) => {
      if (message && message.id) record.seen[message.id] = true;
    });
    record.primed = true;
    if (arrivals.length === 0) return;
    if (!notifiesNewMail(preference("notifyNewMail"))) return;
    const request = notificationRequest(arrivals);
    if (request && typeof values.notify === "function") values.notify(request);
  }

  /** @param {any} account */
  function adapterFor(account) {
    if (adapters.has(account.id)) return adapters.get(account.id);
    const adapter = createProviderAdapter(
      account.provider,
      values.execute,
      currentIdentity,
    );
    adapters.set(account.id, adapter);
    return adapter;
  }

  /** @param {any} account @param {any} identity @param {(adapter:any)=>void} proceed */
  function withRuntime(account, identity, proceed) {
    if (
      account.provider !== "imap" ||
      (runtimeExpiresAt.get(account.id) || 0) > now()
    ) {
      proceed(adapterFor(account));
      return;
    }
    const waiter = { account, identity, proceed };
    const pending = runtimeInFlight.get(account.id);
    if (pending) {
      pending.waiters.push(waiter);
      return;
    }
    const requestedAt = now();
    const entry = { identity, requestedAt, waiters: [waiter] };
    runtimeInFlight.set(account.id, entry);
    adapterFor(account).runtime(
      { identity: { ...identity, objectId: "" } },
      (/** @type {any} */ result) => {
        if (runtimeInFlight.get(account.id) !== entry) return;
        runtimeInFlight.delete(account.id);
        const current = entry.waiters.filter((item) =>
          isCurrentRequest(item.identity),
        );
        if (result.ok && isCurrentRequest(entry.identity)) {
          lastOperation = result;
          runtimeExpiresAt.set(account.id, requestedAt + 300_000);
          current.forEach((item) => item.proceed(adapterFor(item.account)));
        } else {
          current.forEach((item) => {
            if (!sameRequest(item.identity, entry.identity)) {
              withRuntime(item.account, item.identity, item.proceed);
            } else if (!result.discarded) {
              lastOperation = result;
              if (mail)
                mail = {
                  ...mail,
                  status: result.error || "IMAP folders are unavailable",
                };
            }
          });
        }
      },
    );
  }

  /** @param {string} query */
  function loadList(
    query,
    pageToken = "",
    authoritative = false,
    searchText = mail?.searchText ?? "",
    // Whether this read replaces the list or reloads it. A search replaces;
    // a refresh, a retry and a page do not.
    reset = false,
  ) {
    const account = activeAccount();
    if (!account || !mail) return;
    if (!pageToken)
      mail = reduceMailState(mail, { type: "load", query, searchText, reset });
    else mail = reduceMailState(mail, { type: "load-more" });
    const identity = mail.request;
    detail = null;
    const cached =
      !authoritative &&
      values.cache &&
      typeof values.cache.readList === "function"
        ? values.cache.readList(account.id, query)
        : null;
    if (!authoritative && !pageToken && Array.isArray(cached)) {
      mail = reduceMailState(mail, {
        type: "list-loaded",
        request: identity,
        messages: cached,
      });
      recordUnread();
      recordArrivals(account.id, cached, false);
    }
    withRuntime(account, identity, (/** @type {any} */ adapter) =>
      adapter.list(
        {
          identity,
          query,
          maxResults: listSize(preference("maxMessages")),
          pageToken,
        },
        (/** @type {any} */ result) => {
          if (!isCurrentRequest(identity)) return;
          lastOperation = result;
          if (!result.ok) {
            if (mail)
              mail = reduceMailState(mail, {
                type: "load-failed",
                request: identity,
                pageToken,
                error: result.error,
              });
            return;
          }
          const messages =
            result.value && Array.isArray(result.value.messages)
              ? result.value.messages
              : [];
          mail = reduceMailState(mail, {
            type: pageToken ? "page-loaded" : "list-loaded",
            request: identity,
            messages,
            nextPageToken: result.value?.nextPageToken,
            // The cached read above deliberately does not stamp this: a list
            // drawn from disk is not the server having answered, and saying it
            // synced when it did not is the one thing this line must not do.
            receivedAtMs: clockNow(),
          });
          recordArrivals(
            account.id,
            messages,
            !pageToken && !mail.searchText,
          );
          if (values.cache && typeof values.cache.writeList === "function") {
            values.cache.writeList(account.id, query, mail.messages);
          } else if (values.cache && typeof values.cache.put === "function") {
            values.cache.put(account.id, query, mail.messages);
          }
          recordUnread();
        },
      ),
    );
  }

  /** @param {any} account */
  function activate(account) {
    if (!account) return false;
    accounts = { ...accounts, activeId: account.id };
    accounts = saveAccounts(values.storage, accounts);
    mail = mail
      ? reduceMailState(mail, {
          type: "account-changed",
          accountId: account.id,
          providerId: account.provider,
        })
      : createMailState(account.id, account.provider);
    detail = null;
    loadList(mailboxQuery(account.provider, "inbox", ""));
    return true;
  }

  /**
   * What a mailbox amounts to for this provider right now: the typed search if
   * there is one, then the user's own default search, then the mailbox's own
   * query. `Registry.query` decides between them — including that the
   * manifest's shipped `in:inbox` is Gmail syntax and gives way to an IMAP or
   * HEY inbox rather than being sent to a server that would refuse it.
   *
   * Asked again on every read rather than remembered, which is what makes a
   * default search typed in Settings apply to the next refresh instead of
   * waiting for the account to be switched. `MailAccount.effectiveQuery` is a
   * binding for the same reason.
   *
   * @param {string} providerId @param {string} mailboxKey @param {string} searchText
   */
  function mailboxQuery(providerId, mailboxKey, searchText) {
    return Registry.query(
      providerId,
      mailboxKey,
      searchText,
      normalizedDefaultQuery(preference("defaultQuery")),
    );
  }

  return {
    start() {
      accounts = loadAccounts(values.storage);
      const first = Array.isArray(accounts.accounts)
        ? accounts.accounts.find(
            (/** @type {any} */ account) => account && account.id,
          )
        : null;
      const account = accountFor(accounts, accounts.activeId) || first || null;
      if (account) activate(account);
      return this.snapshot();
    },

    /** @param {string} accountId */
    switchAccount(accountId) {
      return activate(accountFor(accounts, accountId));
    },

    /** @param {string} mailboxKey */
    selectMailbox(mailboxKey) {
      const account = activeAccount();
      if (
        !account ||
        !mail ||
        !Registry.hasMailbox(account.provider, mailboxKey)
      )
        return false;
      const query = mailboxQuery(account.provider, mailboxKey, "");
      mail = reduceMailState(mail, {
        type: "mailbox-changed",
        mailboxKey,
        query,
      });
      detail = null;
      loadList(query, "", false, "");
      return true;
    },

    /** @param {string} text */
    search(text) {
      const account = activeAccount();
      if (!account || !mail) return false;
      const query = mailboxQuery(account.provider, mail.mailboxKey, text);
      // The rows of the mailbox being searched are not results of the search,
      // so they go before the request does.
      loadList(query, "", false, String(text || "").trim(), true);
      return true;
    },

    loadMore() {
      if (!mail?.nextPageToken || mail.loading || mail.loadingMore)
        return false;
      loadList(mail.query, mail.nextPageToken);
      return true;
    },

    retry() {
      if (!mail?.canRetry) return false;
      loadList(mail.query, mail.failedPageToken);
      return true;
    },

    /**
     * Go and ask the server again for whatever the list is currently showing.
     * Distinct from `retry`, which only resumes a page that failed: this is the
     * one somebody reaches for when they think there is new mail, so it works
     * whether or not anything went wrong, and it keeps the search term rather
     * than dropping back to the mailbox's default query.
     */
    refresh() {
      const account = activeAccount();
      if (!mail || !account || mail.loading) return false;
      // `loadList` keeps the current search text by default, which is what
      // makes this reload the results somebody is looking at rather than
      // dropping them back to the mailbox.
      //
      // The query is worked out again rather than reused, so a default search
      // saved in Settings while this list was up takes effect on the next
      // read. Reusing `mail.query` would have left the refresh clock asking
      // the question the mailbox was opened with until the account changed.
      loadList(mailboxQuery(account.provider, mail.mailboxKey, mail.searchText));
      return true;
    },

    /** @param {number} offset */
    moveCursor(offset) {
      if (mail) mail = reduceMailState(mail, { type: "move-cursor", offset });
      return this.snapshot();
    },

    /** @param {string} id */
    openMessage(id) {
      if (
        !mail ||
        !mail.messages.some((/** @type {any} */ message) => message.id === id)
      )
        return this.snapshot();
      mail = { ...mail, cursorId: id };
      detail = null;
      return this.openCursor();
    },

    /** @param {(detail:any)=>void} [done] */
    openCursor(done) {
      const account = activeAccount();
      if (!mail || !account) return this.snapshot();
      mail = reduceMailState(mail, { type: "open-cursor" });
      if (!mail.selectedId) return this.snapshot();
      detail = null;
      const identity = { ...mail.request, objectId: mail.selectedId };
      withRuntime(account, identity, (/** @type {any} */ adapter) =>
        adapter.detail(
          { identity, full: true },
          (/** @type {any} */ result) => {
            if (
              mail &&
              mail.request.revision === identity.revision &&
              mail.selectedId === identity.objectId
            ) {
              lastOperation = result;
              if (
                result.ok &&
                String(result.value?.id || "") === identity.objectId
              )
                detail = detailSummary(
                  messageById(mail.messages, [], identity.objectId),
                  result.value,
                );
              if (result.ok && detail && typeof done === "function")
                done(detail);
            }
          },
        ),
      );
      return this.snapshot();
    },

    /**
     * Leaving the reader. The open message and the list cursor are two
     * different things, so closing one must put the other down: a selection
     * left standing behind a closed reader is what made `e` archive the
     * message that had been read rather than the row the keyboard was on.
     */
    clearSelection() {
      if (mail) mail = { ...mail, selectedId: null };
      detail = null;
      return this.snapshot();
    },

    /**
     * Put the keyboard's cursor on one row without opening it. The row's own
     * menu acts through the cursor the way the keys do, so that one path
     * decides what happens to the list afterwards.
     * @param {string} id
     */
    placeCursor(id) {
      if (
        mail &&
        mail.messages.some((/** @type {any} */ message) => message.id === id)
      )
        mail = { ...mail, cursorId: id };
      return this.snapshot();
    },

    /**
     * Star, or unstar. The verb depends on the message: "star" sent twice
     * leaves it starred, and the button that sends it already says "Unstar"
     * while it is on, so a star that only ever added one could not be taken
     * off again.
     * @param {string} id
     */
    toggleStar(id) {
      const message = mail ? messageById(mail.messages, [], id) : null;
      if (!message) return this.snapshot();
      const starred =
        message.starred === true ||
        (Array.isArray(message.labelIds) &&
          message.labelIds.includes("STARRED"));
      return this.act(starred ? "unstar" : "star", [id]);
    },

    /** @param {string} message */
    refuse(message) {
      if (mail) mail = { ...mail, status: String(message) };
      return this.snapshot();
    },

    /** @param {string} accountId */
    invalidateDrafts(accountId) {
      values.cache?.clearAccount?.(accountId);
      if (mail?.accountId === accountId && mail.query === "in:drafts")
        loadList(mail.query, "", true);
      return this.snapshot();
    },

    /** @param {string} action @param {Array<string>} ids */
    act(action, ids) {
      const account = activeAccount();
      const messageIds = Array.isArray(ids) ? ids : [];
      if (!mail || !account || messageIds.length === 0) return this.snapshot();
      const capability = actionCapability(action);
      const provider = Registry.get(account.provider);
      if (capability && !Registry.can(account.provider, capability)) {
        mail = reduceMailState(mail, {
          type: "act",
          action,
          messageId: messageIds[0],
          capabilities: provider.capabilities,
          providerName: provider.name,
        });
        return this.snapshot();
      }
      const identity = { ...mail.request, objectId: messageIds[0] };
      withRuntime(account, identity, (/** @type {any} */ adapter) =>
        adapter.action(
          {
            identity,
            action,
            ids: messageIds,
            onOptimistic: () => {
              messageIds.forEach((messageId) => {
                mail = reduceMailState(mail, {
                  type: "act",
                  action,
                  messageId,
                  capabilities: provider.capabilities,
                  providerName: provider.name,
                });
              });
              recordUnread();
            },
          },
          (/** @type {any} */ result) => {
            if (!isCurrentRequest(identity)) return;
            lastOperation = result;
            if (!result.ok && isCurrentRequest(identity) && mail) {
              const error = String(
                result.error ||
                  "The action may not have completed. Refreshing…",
              );
              loadList(identity.query, "", true);
              if (mail) mail = { ...mail, status: error };
            }
          },
        ),
      );
      return this.snapshot();
    },

    snapshot() {
      return { accounts, mail, detail, lastOperation };
    },
  };
}
