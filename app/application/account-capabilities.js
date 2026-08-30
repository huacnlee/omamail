// @ts-check

// What the mailbox on screen can be asked to do, which is not always what its
// provider can do.
//
// `Registry.capabilities` answers per provider — HEY has no star, IMAP has no
// junk verb — and that is the right shape for everything that differs between
// services. Sending differs between *accounts*: an IMAP mailbox with no SMTP
// server is a supported setup, offered by the setup form in as many words, and
// `ImapProtocol.smtpUrl` answers "" for one. So the provider's `send` is a
// ceiling here, the way its `archive` is a ceiling the server's folder list
// narrows, and this file is where the account narrows it.
//
// It narrows the same `capabilities` object every view already reads, so the
// answer arrives everywhere the provider's own answer does. That is the point:
// a control the mailbox cannot honour is worse than a missing one, because it
// fails after the user has committed to it — with a message typed.

import * as Registry from "../providers/Registry.js";
import { smtpUrl } from "../providers/ImapProtocol.js";

/**
 * The account a controller snapshot is looking at. Here rather than at each
 * call site because every one of them wants the same three lines, and two
 * descriptions of "the mailbox on screen" is one of them being wrong.
 * @param {any} snapshot @returns {any}
 */
export function accountIn(snapshot) {
  return (
    snapshot?.accounts?.accounts?.find(
      (/** @type {any} */ entry) => entry.id === snapshot.accounts.activeId,
    ) ?? null
  );
}

/**
 * Whether this mailbox has anywhere to hand a message to.
 *
 * Asked of `ImapProtocol.smtpUrl` rather than of the field, because the
 * protocol is what decides what an SMTP server is — and an unusable host is as
 * good as an absent one to everything downstream of it.
 * @param {any} account
 */
export function accountCanSend(account) {
  if (account?.provider !== "imap") return true;
  try {
    return smtpUrl(account.imap ?? {}) !== "";
  } catch (_) {
    return false;
  }
}

/**
 * The provider record for an account, with `send` cleared where the mailbox
 * itself cannot. Everything that used to call `Registry.get(account.provider)`
 * to reach `capabilities` calls this instead.
 * @param {any} account @returns {any}
 */
export function providerFor(account) {
  const provider = Registry.get(account?.provider ?? "gmail");
  if (!provider.capabilities.send || accountCanSend(account)) return provider;
  return {
    ...provider,
    capabilities: { ...provider.capabilities, send: false },
  };
}

// A key is not a button: `c`, `r`, `a` and `f` are bound in every mail context
// whatever mailbox is open, so the status row's hints have to be told what this
// one cannot honour as well. `Model.unavailableActions` answers the provider's
// half of that list — archive and star — and this answers the account's.
const WRITING = Object.freeze(["compose", "reply", "replyAll", "forward"]);

/** @param {any} capabilities @returns {Array<string>} */
export function unavailableWriting(capabilities) {
  return capabilities?.send === true ? [] : WRITING.slice();
}

/**
 * What to say when one of those keys is pressed anyway. The same sentence the
 * QML's `ImapClient.sendMessage` answers a send with, because it is the same
 * refusal arriving one step earlier.
 * @param {any} account
 */
export function sendRefusal(account) {
  return accountCanSend(account)
    ? ""
    : "This mailbox has no SMTP server set, so it cannot send";
}

/**
 * The stored mailboxes as `compose/Senders.js` expects to read them.
 *
 * `Senders.identities` skips any row whose `ready` is not exactly `true`, and
 * it is right to: in the QML, `MailAccount.ready` is `setupState === "ready" &&
 * !!api`, so an account that is signed out or has no client behind it must not
 * be offered as a From address. But `ready` is a *live* property of that object
 * and no such field exists on a stored account record — the window was handing
 * `useIdentities` the rows straight off disk, every one of them was skipped,
 * and the From picker was empty for every mailbox in the client.
 *
 * Readiness here is the standalone window's own equivalent: the host accepted
 * this account's context. An account the host refused cannot fetch and cannot
 * send, which is exactly what `!!api` stood for. `canSend` comes from the same
 * rule the rest of this module answers, so a mailbox with no SMTP server never
 * becomes a From address.
 *
 * @param {Array<any>} accounts the stored account records
 * @param {Record<string, string>} [accountErrors] the host's refusals by id
 */
export function senderRows(accounts, accountErrors = {}) {
  return (Array.isArray(accounts) ? accounts : []).map((account) => ({
    ...account,
    ready: Boolean(account?.id) && !accountErrors[String(account.id)],
    canSend: accountCanSend(account),
  }));
}
