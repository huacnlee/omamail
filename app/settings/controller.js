// @ts-check

import * as Accounts from "../account/Accounts.js";

const FIXED_ERROR = "Account could not be removed";
const UNCERTAIN_ERROR = "Credential state uncertain; sign in again";
const REMOTE_IMAGES_ERROR = "Remote image preference could not be saved";
const REMOTE_IMAGES_DETAIL =
  "Loading remote images can tell senders when and where you opened a message.";
const HEAVY_MESSAGES_DETAIL =
  "Render complex messages immediately; layout may briefly pause while they open.";
const UNDO_SEND_DETAIL =
  "Omamail waits before delivery. Set 0 seconds to send immediately.";

/** @param {any} account @param {string} activeId */
function summary(account, activeId) {
  const providerName =
    account.provider === "gmail"
      ? "Gmail"
      : account.provider === "hey"
        ? "HEY"
        : "IMAP";
  return {
    id: account.id,
    label: account.label || account.email || account.id,
    email: account.email || "",
    provider: account.provider,
    providerName,
    status: account.id === activeId ? "Active" : "Connected",
  };
}

/** @param {any} account */
function removalDescriptor(account) {
  if (account.provider === "gmail")
    return {
      kind: "gmail",
      accountId: account.id,
      clientId: account.clientId,
    };
  if (account.provider === "imap")
    return {
      kind: "imap",
      accountId: account.id,
      imapHost: account.imap?.imapHost,
      imapPort: account.imap?.imapPort,
      username: account.imap?.username,
    };
  // HEY owns one machine-global credential. Removing an Omamail row must not
  // silently sign every application out of it.
  return { kind: "hey", accountId: account.id };
}

/** @param {any} result */
function requireDeleted(result) {
  if (result?.outcome === "deleted" || result?.outcome === "notFound") return;
  const failure = new Error("Credential state uncertain");
  /** @type {any} */ (failure).credentialOutcome = "uncertain";
  throw failure;
}

/** @param {any} dependencies */
export function createSettingsController(dependencies) {
  if (
    !dependencies ||
    typeof dependencies.readAccounts !== "function" ||
    typeof dependencies.saveAccounts !== "function" ||
    typeof dependencies.configure !== "function"
  )
    throw new TypeError("settings dependencies are required");
  /** @type {any} */
  let pendingRemoval = null;
  let busy = false;
  let error = "";
  let remoteImagesEnabled = false;
  let heavyMessagesEnabled = false;
  let undoSendSeconds = 10;
  try {
    remoteImagesEnabled = Boolean(dependencies.readRemoteImages?.());
    heavyMessagesEnabled = Boolean(dependencies.readHeavyMessages?.());
    const storedSeconds = Number(dependencies.readUndoSendSeconds?.());
    if (Number.isFinite(storedSeconds))
      undoSendSeconds = Math.max(0, Math.min(60, Math.round(storedSeconds)));
  } catch (_) {
    error = REMOTE_IMAGES_ERROR;
  }

  function snapshot() {
    const list = Accounts.copyList(dependencies.readAccounts());
    return {
      accounts: list.accounts
        .filter((/** @type {any} */ account) => Boolean(account?.id))
        .map((/** @type {any} */ account) => summary(account, list.activeId)),
      activeAccountId: list.activeId,
      pendingRemoval: pendingRemoval ? { ...pendingRemoval } : null,
      busy,
      error,
      remoteImages: {
        enabled: remoteImagesEnabled,
        disabled: false,
        detail: REMOTE_IMAGES_DETAIL,
      },
      heavyMessages: {
        enabled: heavyMessagesEnabled,
        disabled: false,
        detail: HEAVY_MESSAGES_DETAIL,
      },
      undoSend: {
        seconds: undoSendSeconds,
        disabled: false,
        detail: UNDO_SEND_DETAIL,
      },
    };
  }

  return {
    snapshot,
    /** @param {boolean} enabled */
    async toggleRemoteImages(enabled) {
      const next = Boolean(enabled);
      if (busy) return { ok: false, enabled: remoteImagesEnabled, error };
      busy = true;
      error = "";
      try {
        if (typeof dependencies.saveRemoteImages !== "function")
          throw new Error("Remote image preference storage is unavailable");
        await dependencies.saveRemoteImages(next);
        remoteImagesEnabled = next;
        busy = false;
        return { ok: true, enabled: remoteImagesEnabled };
      } catch (_) {
        busy = false;
        error = REMOTE_IMAGES_ERROR;
        return { ok: false, enabled: remoteImagesEnabled, error };
      }
    },
    /** @param {boolean} enabled */
    async toggleHeavyMessages(enabled) {
      const next = Boolean(enabled);
      if (busy) return { ok: false, enabled: heavyMessagesEnabled, error };
      busy = true;
      error = "";
      try {
        if (typeof dependencies.saveHeavyMessages !== "function")
          throw new Error("Heavy message preference storage is unavailable");
        await dependencies.saveHeavyMessages(next);
        heavyMessagesEnabled = next;
        busy = false;
        return { ok: true, enabled: heavyMessagesEnabled };
      } catch (_) {
        busy = false;
        error = "Reading preference could not be saved";
        return { ok: false, enabled: heavyMessagesEnabled, error };
      }
    },
    /** @param {number} seconds */
    async setUndoSendSeconds(seconds) {
      const next = Math.max(0, Math.min(60, Math.round(Number(seconds) || 0)));
      if (busy) return { ok: false, seconds: undoSendSeconds, error };
      busy = true;
      error = "";
      try {
        if (typeof dependencies.saveUndoSendSeconds !== "function")
          throw new Error("Undo-send preference storage is unavailable");
        await dependencies.saveUndoSendSeconds(next);
        undoSendSeconds = next;
        busy = false;
        return { ok: true, seconds: undoSendSeconds };
      } catch (_) {
        busy = false;
        error = "Writing preference could not be saved";
        return { ok: false, seconds: undoSendSeconds, error };
      }
    },
    /** @param {string} accountId */
    switchAccount(accountId) {
      const previous = Accounts.copyList(dependencies.readAccounts());
      if (Accounts.indexOfId(previous.accounts, accountId) < 0) return false;
      const next = Accounts.setActive(previous, accountId);
      dependencies.saveAccounts(next);
      error = "";
      return true;
    },
    /** @param {string} accountId */
    requestRemoval(accountId) {
      const list = Accounts.copyList(dependencies.readAccounts());
      const index = Accounts.indexOfId(list.accounts, accountId);
      if (index < 0) return null;
      const account = list.accounts[index];
      pendingRemoval = {
        accountId: account.id,
        index,
        email: account.email,
        title: `Remove “${account.email || account.id}”?`,
        detail:
          account.provider === "hey"
            ? "This removes the account from Omamail. The machine-wide HEY CLI stays signed in."
            : "This removes its local credential, host context, and cached mail.",
      };
      return { ...pendingRemoval };
    },
    cancelRemoval() {
      pendingRemoval = null;
      return snapshot();
    },
    /** @param {any} confirmation */
    async confirmRemoval(confirmation) {
      if (
        busy ||
        !confirmation ||
        confirmation.accountId !== pendingRemoval?.accountId
      )
        return { ok: false, error: FIXED_ERROR };
      const previous = Accounts.copyList(dependencies.readAccounts());
      const index = Accounts.confirmRemoval(previous, {
        id: confirmation.accountId,
        index: confirmation.index,
      });
      if (index < 0) return { ok: false, error: FIXED_ERROR };
      const account = previous.accounts[index];
      const next = Accounts.removeAt(previous, index);
      busy = true;
      error = "";
      let credentialDispatched = false;
      try {
        dependencies.saveAccounts(next);
        await dependencies.configure(next.accounts);
        const descriptor = removalDescriptor(account);
        if (descriptor.kind === "gmail") {
          credentialDispatched = true;
          requireDeleted(
            await dependencies.revokeGmail(
              descriptor.accountId,
              descriptor.clientId,
            ),
          );
        } else if (descriptor.kind === "imap") {
          credentialDispatched = true;
          requireDeleted(
            await dependencies.forgetImap({
              accountId: descriptor.accountId,
              imapHost: descriptor.imapHost,
              imapPort: descriptor.imapPort,
              username: descriptor.username,
            }),
          );
        }
        dependencies.clearCache?.(account.id);
        pendingRemoval = null;
        busy = false;
        return {
          ok: true,
          empty: next.accounts.length === 0,
          activeAccountId: next.activeId,
        };
      } catch (caught) {
        const outcome = /** @type {any} */ (caught)?.credentialOutcome;
        if (credentialDispatched && outcome !== "beforeEffect") {
          dependencies.clearCache?.(account.id);
          pendingRemoval = null;
          busy = false;
          error = UNCERTAIN_ERROR;
          return {
            ok: false,
            removed: true,
            uncertain: true,
            empty: next.accounts.length === 0,
            activeAccountId: next.activeId,
            error: UNCERTAIN_ERROR,
          };
        }
        try {
          dependencies.saveAccounts(previous);
          await dependencies.configure(previous.accounts);
        } catch (_) {}
        busy = false;
        error = FIXED_ERROR;
        return { ok: false, error: FIXED_ERROR };
      }
    },
  };
}
