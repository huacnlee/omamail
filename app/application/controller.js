// @ts-check

import {
  actionCapability,
  detailSummary,
  messageById,
} from "../account/Model.js";
import { createProviderAdapter } from "../adapters/index.js";
import * as Registry from "../providers/Registry.js";
import { loadAccounts, saveAccounts } from "./account-store.js";
import { createMailState, reduceMailState } from "./mail-state.js";

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

/** @param {{ storage: any, execute: any, cache?: any, companion?: any, now?:()=>number }} dependencies */
export function createApplicationController(dependencies) {
  const values = dependencies || {};
  if (!values.storage || typeof values.execute !== "function")
    throw new TypeError("storage and an effect executor are required");

  let accounts = /** @type {any} */ ({
    version: 1,
    accounts: [],
    activeId: "",
  });
  let mail = /** @type {any} */ (null);
  let detail = /** @type {any} */ (null);
  let lastOperation = /** @type {any} */ (null);
  const unreadByAccount = /** @type {Record<string, number>} */ ({});
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
  ) {
    const account = activeAccount();
    if (!account || !mail) return;
    if (!pageToken)
      mail = reduceMailState(mail, { type: "load", query, searchText });
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
    }
    withRuntime(account, identity, (/** @type {any} */ adapter) =>
      adapter.list(
        { identity, query, maxResults: 25, pageToken },
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
          });
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
    const inbox = Registry.mailboxFor(account.provider, "inbox");
    loadList(inbox.query);
    return true;
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
      const query = Registry.query(account.provider, mailboxKey, "", "");
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
      const query = Registry.query(account.provider, mail.mailboxKey, text, "");
      loadList(query, "", false, String(text || "").trim());
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
