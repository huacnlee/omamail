// @ts-check

import {
  actionCapability,
  detailSummary,
  mailboxAfterAccountSwitch,
  messageById,
  newArrivals,
} from "../account/Model.js";
import { createProviderAdapter } from "../adapters/index.js";
import * as Registry from "../providers/Registry.js";
import { loadAccounts, saveAccounts } from "./account-store.js";
import {
  actionLabel,
  createMailState,
  reduceMailState,
} from "./mail-state.js";
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

/**
 * Whether the list is drawing this row bold.
 *
 * Two spellings because two things write a summary: `Message.summarize` sets
 * the flag, and a row that came straight off a provider carries Gmail's label.
 * Asked in one place so the badge, the mark-on-open and the count agree.
 *
 * @param {any} message
 */
function isUnread(message) {
  return Boolean(
    message &&
      (message.unread === true ||
        (Array.isArray(message.labelIds) &&
          message.labelIds.includes("UNREAD"))),
  );
}

/** @param {any} messages */
function unreadCount(messages) {
  return (Array.isArray(messages) ? messages : []).filter(isUnread).length;
}

/**
 * Whether the list already knows this message is a draft.
 *
 * A body never changes once it has been fetched — which is what makes a cache
 * hit always correct, and what lets a hit skip the read entirely. A draft is
 * the one message that is not a fetched body at all: it is what somebody was
 * typing, and it changes every time they type. `BodyCache.qml` caches drafts
 * along with everything else and gets away with it because the QML *always*
 * fetches and lets the live copy win the race; a cache that answers instead of
 * fetching would hand the composer yesterday's text to save over.
 *
 * @param {any} message
 */
function isDraft(message) {
  return Boolean(
    message &&
      (message.draftId ||
        (Array.isArray(message.labelIds) && message.labelIds.includes("DRAFT"))),
  );
}

/** @param {{ storage: any, execute: any, cache?: any, bodies?: any, companion?: any, now?:()=>number, preference?:(key:string)=>any, notify?:(request:{summary:string,body:string})=>void, onNotice?:()=>void }} dependencies */
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

  /**
   * What is on screen, written back to the query cache —
   * `MailAccount.rememberList`.
   *
   * An action changed `messages` and changed nothing else, so the copy on disk
   * still said what the mailbox looked like before it. Anything that paints
   * from that copy — the next cache-first read, a mailbox switched away from
   * and back, the window reopened — put the old state back on screen: a
   * message read a moment ago, bold again. The live load corrected it a moment
   * later, which is what made it look intermittent rather than broken.
   *
   * @param {string} accountId @param {string} query @param {Array<any>} [rows]
   */
  function rememberList(accountId, query, rows) {
    const messages = rows ?? (mail ? mail.messages : []);
    if (values.cache && typeof values.cache.writeList === "function")
      values.cache.writeList(accountId, query, messages);
    else if (values.cache && typeof values.cache.put === "function")
      values.cache.put(accountId, query, messages);
  }

  /**
   * Whatever the window is told when a confirmation goes up.
   *
   * The clock that retires it may have stopped — it runs while something is
   * still moving and stops the moment nothing is — so the notice starts it,
   * exactly the way `compose/controller.js`'s `note` does. One clock retires
   * both.
   */
  function raiseNotice() {
    if (mail && mail.notice !== "" && typeof values.onNotice === "function")
      values.onNotice();
  }

  // The read in the air, so an action can stop it before editing the rows it
  // would rebuild. `MailAccount.listHandle`, and `abortRequest` is `cancel`.
  let listHandle = /** @type {any} */ (null);

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
    // Only a read that replaces the list puts the open message down. A refresh
    // and a revalidation ask the same question again about the same mailbox,
    // and blanking the reader on the poll's answer closed a message somebody
    // was still reading. What the reload no longer lists is closed below,
    // where the list itself says so.
    if (reset) detail = null;
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
    withRuntime(account, identity, (/** @type {any} */ adapter) => {
      const handle = adapter.list(
        {
          identity,
          query,
          maxResults: listSize(preference("maxMessages")),
          pageToken,
        },
        (/** @type {any} */ result) => {
          if (listHandle === handle) listHandle = null;
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
          rememberList(account.id, query);
          recordUnread();
          // A message the reload no longer lists is not open any more. The
          // reducer has already put the selection down; the body it was
          // showing goes with it.
          if (!mail.selectedId) detail = null;
        },
      );
      if (isCurrentRequest(identity)) listHandle = handle;
      return handle;
    });
  }

  /**
   * Make one mailbox the one on screen.
   *
   * The mailbox being read comes with it wherever the account switched to has
   * one — `App.switchAccount`, through `Model.mailboxAfterAccountSwitch`.
   * Switching from Starred to an account that has no Starred lands in the
   * inbox, which is what the empty answer means; switching to one that does
   * keeps you where you were reading, because the account changed and the
   * question did not.
   *
   * @param {any} account @param {string} [keepMailboxKey]
   */
  function activate(account, keepMailboxKey) {
    if (!account) return false;
    accounts = { ...accounts, activeId: account.id };
    accounts = saveAccounts(values.storage, accounts);
    const mailboxKey =
      mailboxAfterAccountSwitch(
        String(keepMailboxKey || ""),
        Registry.mailboxes(account.provider),
      ) || "inbox";
    mail = mail
      ? reduceMailState(mail, {
          type: "account-changed",
          accountId: account.id,
          providerId: account.provider,
          mailboxKey,
        })
      : createMailState(account.id, account.provider);
    detail = null;
    loadList(mailboxQuery(account.provider, mailboxKey, ""));
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

  /**
   * A message that has been opened before, put back together out of the row
   * the list is already showing and the body kept on disk beside it.
   *
   * The two halves are split the way `MailAccount` splits them: the row is the
   * live one — its flags and its labels change, and a starred message must not
   * come back unstarred — and the record is the half that never changes. So
   * only the body's own fields come out of the cache, and the summary is
   * whatever the list holds now. Merged through `detailSummary` for the same
   * reason the live read is, so both paths produce one shape.
   *
   * @param {string} accountId @param {string} id
   */
  function cachedDetail(accountId, id) {
    const bodies = values.bodies;
    if (!bodies || typeof bodies.read !== "function") return null;
    const row = mail ? messageById(mail.messages, [], id) : null;
    // Without the row there is a body and nothing to say who sent it, which is
    // less than the reader needs; the fetch answers both.
    if (!row || isDraft(row)) return null;
    const record = bodies.read(accountId, id);
    if (!record) return null;
    bodies.touch?.(accountId, id);
    return detailSummary(row, {
      ...row,
      id,
      // `body` rather than `text`: that is what every adapter's detail calls
      // the plain reading, and the reader falls back to it.
      body: record.text,
      html: record.html,
      attachments: record.attachments,
      invite: record.invite,
      unsubscribe: record.unsubscribe,
    });
  }

  /** @param {string} accountId @param {string} id @param {any} value */
  function rememberBody(accountId, id, value) {
    const bodies = values.bodies;
    if (!bodies || typeof bodies.put !== "function") return;
    if (isDraft(value)) return;
    bodies.put(accountId, id, {
      text: value.body,
      // Which of the two readings the text is. The reader works it out from
      // the markup either way; the field is in the record because
      // `Cache.serializeBody` defines the record and both clients share it.
      source: value.html ? "html" : "plain",
      html: value.html,
      attachments: value.attachments,
      invite: value.invite,
      unsubscribe: value.unsubscribe,
    });
  }

  /**
   * Ask the server for one message and hand back the row it becomes.
   *
   * The two callers below want the same request and the same staleness guard —
   * an answer about a list that has since been replaced is an answer about
   * nothing — and differ only in what they do with it. Written once here so
   * that "what a detail read is" is said once; who may see the result stays
   * with whoever asked, because the reader's guard is not the composer's.
   *
   * `deliver` is given the merged row, or null where the read failed or
   * answered about another message, and the raw result beside it.
   *
   * @param {any} account @param {any} identity
   * @param {(detail:any, result:any)=>void} deliver
   */
  function readDetail(account, identity, deliver) {
    withRuntime(account, identity, (/** @type {any} */ adapter) =>
      adapter.detail({ identity, full: true }, (/** @type {any} */ result) => {
        if (!mail || mail.request.revision !== identity.revision) return;
        const loaded =
          result.ok && String(result.value?.id || "") === identity.objectId
            ? detailSummary(
                messageById(mail.messages, [], identity.objectId),
                result.value,
              )
            : null;
        deliver(loaded, result);
      }),
    );
  }

  /**
   * Every action moves the list immediately and reconciles afterwards.
   *
   * Waiting for the server before the row moves makes the window feel broken
   * on a slow connection, so `MailAccount.act`'s three consequences all live
   * here: the optimistic edit is written back to the copy on disk, the list
   * read that would rebuild the pre-action rows over it is stopped first, and
   * a refusal puts the row back where it was rather than sending the whole
   * list round the network again.
   *
   * `quiet` is for an action nobody asked for — marking read on open. It says
   * nothing on the status line, and it keeps the row where it is even in the
   * mailbox the action disqualifies it from, because closing the reader the
   * click had just opened is not something a click should do.
   *
   * @param {string} action @param {Array<string>} ids
   * @param {{quiet?: boolean}} [options]
   */
  function performAct(action, ids, options) {
    const account = activeAccount();
    const messageIds = Array.isArray(ids) ? ids : [];
    if (!mail || !account || messageIds.length === 0) return;
    const quiet = options?.quiet === true;
    const capability = actionCapability(action);
    const provider = Registry.get(account.provider);
    if (capability && !Registry.can(account.provider, capability)) {
      mail = reduceMailState(mail, {
        type: "act",
        action,
        messageId: messageIds[0],
        capabilities: provider.capabilities,
        providerName: provider.name,
        at: clockNow(),
      });
      raiseNotice();
      return;
    }
    // A live list owns snapshots taken from before this action. Letting it
    // finish would rebuild and persist those stale rows over the optimistic
    // edit — a trashed search hit visibly came back when the slowest metadata
    // request answered. Stop that read, then revalidate this same query once
    // the mutation has landed.
    //
    // The read in the air is `listHandle`, and the loading flags are not it: a
    // list painted from the cache clears `loading` while its network read is
    // still running, which is precisely the moment somebody opens the first
    // unread message. Marking it read hid the dot, and the answer that landed a
    // second later put the row's bold back. The flags stay in the question for
    // a read that has been asked for and not yet been handed a handle.
    const interrupted = listHandle !== null || mail.loading || mail.loadingMore;
    if (interrupted) {
      listHandle?.cancel?.();
      listHandle = null;
      mail = reduceMailState(mail, { type: "interrupt-list" });
    }
    const identity = { ...mail.request, objectId: messageIds[0] };
    const query = mail.query;
    // Where each row was and what it said, so a refusal can put it back.
    const rows = messageIds
      .map((messageId) => ({
        index: mail.messages.findIndex(
          (/** @type {any} */ entry) => entry.id === messageId,
        ),
        message: messageById(mail.messages, [], messageId),
      }))
      .filter((row) => row.index >= 0 && row.message);
    const beforeMessages = mail.messages;
    const beforeToken = mail.nextPageToken;
    let optimisticMessages = /** @type {Array<any>|null} */ (null);
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
                quiet,
                capabilities: provider.capabilities,
                providerName: provider.name,
              });
            });
            optimisticMessages = mail.messages;
            recordUnread();
            // The edit written back to the query cache, so the next
            // cache-first paint of this same question draws what the user did
            // rather than what was there before it. Not while a read was
            // interrupted: what is on screen then is a half-built list, and it
            // is written on success instead.
            if (!interrupted) rememberList(account.id, query);
          },
        },
        (/** @type {any} */ result) => {
          if (!isCurrentRequest(identity)) {
            // Navigation replaced the visible list while the request was in
            // flight. Repair the query it belonged to on disk without putting
            // its row into the mailbox that is now on screen.
            const settled = result.ok ? optimisticMessages : beforeMessages;
            if (settled) rememberList(account.id, query, settled);
            return;
          }
          lastOperation = result;
          if (!mail) return;
          if (!result.ok) {
            mail = reduceMailState(mail, {
              type: "act-restore",
              rows,
              nextPageToken: beforeToken,
              error: result.error,
            });
            recordUnread();
            if (interrupted) loadList(query, "", true);
            else rememberList(account.id, query);
            return;
          }
          if (!quiet) {
            mail = reduceMailState(mail, {
              type: "acted",
              notice: actionLabel(action, messageIds.length),
              at: clockNow(),
            });
            raiseNotice();
          }
          if (interrupted) {
            // Save the optimistic success for the next visit, then keep this
            // list on screen while a live read revalidates it.
            rememberList(account.id, query);
            loadList(query, "", true);
          }
        },
      ),
    );
  }

  /**
   * Opening an unread message marks it read.
   *
   * The one place Gmail's own clients act without being asked, and a reader
   * that leaves the message bold is confusing — every other unread signal in
   * the window is then wrong about it. Quiet, because it is a consequence of
   * the click rather than a second thing that happened, and because the row
   * has to stay where it is: this is exactly the action that disqualifies it
   * from the Unread mailbox.
   *
   * Asked of the row rather than of the fetch, because a body already on disk
   * short-circuits the fetch entirely and a mark that lived on that path would
   * fire only for messages nobody had opened before.
   *
   * @param {string} messageId
   */
  function markOpenedRead(messageId) {
    const row = mail ? messageById(mail.messages, [], messageId) : null;
    if (!isUnread(row)) return;
    performAct("markRead", [messageId], { quiet: true });
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
      return activate(accountFor(accounts, accountId), mail?.mailboxKey);
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
      // A message opened before opens off the disk and stops there. The QML
      // asks anyway and lets whichever answer arrives first paint, because its
      // read is asynchronous and cannot be waited on; this one is answered
      // before the decision is made, so a hit is the whole of the open.
      const cached = cachedDetail(account.id, identity.objectId);
      if (cached) {
        detail = cached;
        markOpenedRead(identity.objectId);
        if (typeof done === "function") done(detail);
        return this.snapshot();
      }
      readDetail(account, identity, (loaded, result) => {
        // Still the message the reader has open. A second open that overtook
        // this one owns the reader now, and an answer about the message before
        // it would paint over what the user is looking at.
        if (mail.selectedId !== identity.objectId) return;
        lastOperation = result;
        if (!loaded) return;
        detail = loaded;
        // The fetch's own answer rather than the merge, because the fields the
        // merge adds are the list's and the list keeps them.
        rememberBody(account.id, identity.objectId, result.value);
        markOpenedRead(identity.objectId);
        if (typeof done === "function") done(detail);
      });
      return this.snapshot();
    },

    /**
     * One message's body, with the reader left where it is.
     *
     * `openCursor` reads a message *and* shows it, which is one act for
     * somebody opening mail and two for somebody answering it: a reply needs
     * the body to quote and the Message-ID to thread against, and needs the
     * reader not at all. Those two were the same call, which is why Reply on a
     * row's menu put the message on screen on the way to the composer.
     *
     * The answer goes to `done` rather than into the snapshot, because
     * `detail` belongs to the message the reader has open and this one is not
     * open. A hit in the body cache answers immediately, in the same breath as
     * the call, so a message that has been read before answers with no fetch
     * at all.
     *
     * @param {string} id
     * @param {(detail:any, error:string)=>void} [done]
     */
    loadDetail(id, done) {
      const account = activeAccount();
      const objectId = String(id || "");
      if (!mail || !account || !objectId) return this.snapshot();
      const identity = { ...mail.request, objectId };
      const cached = cachedDetail(account.id, objectId);
      if (cached) {
        if (typeof done === "function") done(cached, "");
        return this.snapshot();
      }
      readDetail(account, identity, (loaded, result) => {
        lastOperation = result;
        if (loaded) rememberBody(account.id, objectId, result.value);
        if (typeof done === "function")
          done(
            loaded,
            loaded ? "" : String(result.error || "The message could not be read"),
          );
      });
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

    /**
     * @param {string} action @param {Array<string>} ids
     * @param {{quiet?: boolean}} [options]
     */
    act(action, ids, options) {
      performAct(action, ids, options);
      return this.snapshot();
    },

    /**
     * One beat of the clock the confirmation is drawn against.
     *
     * The four seconds are worked out from the time, so something has to make
     * the time move. This is the same beat `compose/controller.js` takes, from
     * the same loop in the window — a second timer for the same job is two
     * clocks to keep in step.
     * @param {number} [at]
     */
    tick(at) {
      if (mail)
        mail = reduceMailState(mail, {
          type: "retire-notice",
          at: at === undefined ? clockNow() : at,
        });
      return this.snapshot();
    },

    /** Whether anything here still needs the clock to beat. */
    needsTick() {
      return Boolean(mail && mail.notice !== "");
    },

    snapshot() {
      return { accounts, mail, detail, lastOperation };
    },
  };
}
