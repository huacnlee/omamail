// @ts-check

// What the mail screen is given.
//
// Lifted out of `main.js` because it is the largest of the five view models
// and the window's own shape was unreadable past it — and because the file had
// grown past the repository's size ceiling, which is the same complaint said
// by a test. The window still owns the state; this only assembles the
// description the view draws from.

import * as Registry from "../providers/Registry.js";
import * as Model from "../account/Model.js";
import { readerModel } from "./reader-model.js";
import * as Mail from "../message/Message.js";
import { hintsFor } from "../keys/keymap.js";
import {
  appMenuModel,
  closeMessageMenu,
  menuCapabilitiesFor,
  openAccountSwitcher,
  openMessageMenu,
  runMessageMenu,
} from "./mail-actions.js";
import { displayName } from "./addresses.js";
import { unavailableWriting } from "./account-capabilities.js";

/**
 * When a row was sent.
 *
 * Three shapes reach here: a raw provider message, which `Message.messageDate`
 * reads; a summary straight from `Message.summarize`, whose `date` is a `Date`;
 * and the same summary back out of the list cache, whose `date` is the ISO
 * string `JSON.stringify` left behind. A value that parses to nothing is no
 * date at all rather than an Invalid one — the whole point of the fallback is
 * to end up with something `relativeTime` can refuse cleanly.
 * @param {any} message
 */
function rowDate(message) {
  const parsed = Mail.messageDate(message);
  if (parsed) return parsed;
  const value = message?.date;
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * What a mailbox the host has no credential for says, in the provider's own
 * words. `MailAccount.qml` builds the same pair out of `Model.setupHeadline`
 * and `Model.setupActionLabel` whenever `setupState` is "signed_out"; this
 * window has no setup card to put them on, so they go to the list.
 *
 * @param {any} mail the account's mail state
 * @param {any} provider the provider record behind it
 */
export function signedOutCard(mail, provider) {
  if (mail?.signedOut !== true)
    return { signedOut: false, notice: "", actionLabel: "" };
  const badge = Registry.badge(provider?.id);
  const authKind = Registry.authKind(provider?.id);
  return {
    signedOut: true,
    notice: Model.setupHeadline("signed_out", badge, authKind),
    actionLabel: Model.setupActionLabel("signed_out", badge, authKind),
  };
}

/**
 * @param {any} app the window
 * @param {any} snapshot the application controller's snapshot
 * @param {any} mail its mail state
 * @param {any} provider the active account's provider record
 * @param {any} account the active account
 * @param {string} lastError
 * @param {number} now
 */
export function mailModel(app, snapshot, mail, provider, account, lastError, now) {
  const card = signedOutCard(mail, provider);
  const signedOut = card.signedOut;
  return {
        width: app.width,
        accounts: snapshot.accounts.accounts.map(
          (/** @type {any} */ entry) => ({
            id: entry.id,
            label: entry.label ?? entry.email ?? entry.id,
            email: entry.email ?? "",
            provider: entry.provider,
            selected: entry.id === snapshot.accounts.activeId,
          }),
        ),
        mailboxes: Registry.mailboxes(provider.id).map((box) => ({
          id: box.key,
          label: box.label,
          // The provider names its own glyph. Passing it through is
          // what keeps an IMAP account's Flagged from borrowing
          // Gmail's Starred icon.
          icon: box.icon,
          count: mail?.counts?.[box.key] ?? 0,
          selected: box.key === (mail?.mailboxKey ?? "inbox"),
        })),
        // The numbered list the sidebar badges and the keys that open
        // those rows come from one place, so a badge and its key
        // cannot disagree.
        slots: Model.sidebarSlots(
          Registry.mailboxes(provider.id),
          [],
          10,
        ),
        unread: mail?.counts?.inbox ?? 0,
        search: {
          state: app.search,
          // What the field's clear button needs to know it has anything to
          // clear. Read off the live input rather than mirrored into state:
          // the field is what holds the query being typed, and a second copy
          // would be one keystroke behind it.
          text:
            typeof app.search?.value === "function" ? app.search.value() : "",
          // The same two steps Escape takes, because it is the same act:
          // emptying the field and telling the list the query is gone.
          onClear: (
            /** @type {any} */ _event,
            /** @type {any} */ eventCx,
          ) => {
            app.search.set_value("");
            app.controller?.search("");
            eventCx.notify();
          },
          onChange() {},
        },
        header: {
          title: Registry.mailboxFor(
            provider.id,
            mail?.mailboxKey ?? "inbox",
          ).label,
          onCompose: (
            /** @type {any} */ _event,
            /** @type {any} */ eventCx,
          ) => app.openCompose(eventCx),
          onSettings: (
            /** @type {any} */ _event,
            /** @type {any} */ eventCx,
          ) => app.openSettings(eventCx),
          onRefresh: (
            /** @type {any} */ _event,
            /** @type {any} */ eventCx,
          ) => {
            app.controller?.refresh();
            eventCx.notify();
          },
        },
        sidebarCollapsed: app.sidebarCollapsed,
        // Whatever the divider was last dragged to, or 0 for the proportional
        // default. The window holds it because the window outlives the layout.
        listWidth: app.listWidth,
        // Only while a drag is live: a row that listened to every mouse move
        // would be doing the work of a drag on every pass of the pointer.
        dragging: app.listDrag !== null,
        onSplitterPress: (
          /** @type {any} */ event,
          /** @type {any} */ eventCx,
        ) => app.beginListDrag(event, eventCx),
        onSplitterDrag: (
          /** @type {any} */ event,
          /** @type {any} */ eventCx,
        ) => app.dragList(event, eventCx),
        onSplitterRelease: (
          /** @type {any} */ _event,
          /** @type {any} */ eventCx,
        ) => app.endListDrag(eventCx),
        switcherOpen: app.accountSwitcherOpen,
        switcherCursor: app.accountSwitcherCursor,
        onSwitcherOpenChange: (
          /** @type {boolean} */ next,
          /** @type {any} */ eventCx,
        ) => openAccountSwitcher(app, next, eventCx),
        onAddAccount: (
          /** @type {any} */ _event,
          /** @type {any} */ eventCx,
        ) => {
          app.state = {
            ...app.state,
            route: "setup",
            setupProviderId: null,
          };
          eventCx.notify();
        },
        onManageAccounts: (
          /** @type {any} */ _event,
          /** @type {any} */ eventCx,
        ) => app.openSettings(eventCx),
        onToggleSidebar: (
          /** @type {any} */ _event,
          /** @type {any} */ eventCx,
        ) => app.toggleSidebar(eventCx),
        messages: (mail?.messages ?? []).map(
          (/** @type {any} */ message) => ({
            id: String(message.id),
            sender: displayName(message.sender ?? message.from),
            // What `Message.summarize` calls a message with no Subject
            // header. A blank line in the list is a row that looks
            // broken; "(no subject)" is a row that says what happened.
            subject: String(message.subject ?? "") || "(no subject)",
            snippet: String(message.snippet ?? ""),
            // The QML's own relative form: "now", "23m", "9:41",
            // "Fri", "Aug 12". A raw timestamp in a 60px column is
            // both unreadable and the same for every row.
            // `date` and never `time`: a row that has been through
            // `Message.summarize` already carries `time` as the *rendered*
            // string — "23m", "Fri" — and feeding that back to `new Date`
            // makes an Invalid Date, which `relativeTime` then formats as
            // "undefined NaN, NaN" on every row in the list. `date` is the
            // timestamp, and it survives the list cache as an ISO string.
            time: Mail.relativeTime(rowDate(message), now),
            unread:
              message.unread === true ||
              message.labelIds?.includes("UNREAD"),
            starred:
              message.starred === true ||
              message.labelIds?.includes("STARRED"),
          }),
        ),
        cursorId: mail?.cursorId ?? null,
        // Revealing a row's actions on hover is not a style GPUI can
        // declare, so the window holds which row the pointer is on.
        hoveredId: app.hoveredMessageId || null,
        loading: mail?.loading === true,
        // Whether a list has ever answered, not whether an account is open. A
        // first read that failed used to print "Nothing here" over its own
        // error message, which is the window agreeing with the failure.
        loaded: mail?.loaded === true,
        searchQuery: mail?.searchText ?? "",
        capabilities: provider.capabilities,
        // The row's own menu, assembled here because it is the only place that
        // has the provider beside the window's open-menu state. Reply, Reply
        // all, Forward, Report spam, Mark read, Mark unread and Open in
        // browser have no other route in this window.
        messageMenu: app.messageMenu
          ? {
              ...app.messageMenu,
              // The same answer the keyboard's cursor counts rows against. Two
              // descriptions of what a menu offers is a cursor whose Enter
              // lands on a different row from the one it is drawn over — and
              // `web` is the capability's name, because a row asked about a key
              // no provider declares is a row that is always drawn, which is
              // how IMAP came to offer a web mailbox it has no address for.
              capabilities: menuCapabilitiesFor(app, app.messageMenu.messageId),
              onAction: (
                /** @type {string} */ action,
                /** @type {string} */ id,
                /** @type {any} */ _event,
                /** @type {any} */ eventCx,
              ) => runMessageMenu(app, action, id, eventCx),
              onDismiss: (
                /** @type {any} */ _event,
                /** @type {any} */ eventCx,
              ) => closeMessageMenu(app, eventCx),
            }
          : null,
        onHover: (
          /** @type {string} */ id,
          /** @type {boolean} */ hovered,
          /** @type {any} */ eventCx,
        ) => {
          const next = hovered ? id : "";
          if (app.hoveredMessageId === next) return;
          app.hoveredMessageId = next;
          eventCx.notify();
        },
        // The button is a toggle and says so — "Unstar" while the star is on —
        // so the verb it sends has to depend on the message.
        onStar: (
          /** @type {string} */ id,
          /** @type {any} */ _event,
          /** @type {any} */ eventCx,
        ) => app.toggleStar(id, eventCx),
        onArchive: (
          /** @type {string} */ id,
          /** @type {any} */ _event,
          /** @type {any} */ eventCx,
        ) => app.actOn("archive", id, eventCx),
        onTrash: (
          /** @type {string} */ id,
          /** @type {any} */ _event,
          /** @type {any} */ eventCx,
        ) => app.actOn("trash", id, eventCx),
        onMessageMenu: (
          /** @type {string} */ id,
          /** @type {any} */ event,
          /** @type {any} */ eventCx,
        ) => openMessageMenu(app, id, event, eventCx),
        // The window's own menu, rows and answers both, from the one place
        // the keyboard reads it too: this host's popups take no keys, so the
        // window runs the menu's cursor, and a second list written for it is
        // the drift the keymap exists to stop.
        menu: appMenuModel(app),
        selectedId: app.readerHidden
          ? null
          : (mail?.selectedId ?? null),
        reader: readerModel(app, snapshot, mail, provider),
        status: {
          // How current the list is, not how long it is: a count of
          // what is loaded is a number already on screen, and "Synced
          // 5m ago" is the thing that is not.
          label: Model.syncedLabel(
            mail?.loading === true,
            mail?.syncedAtMs
              ? Mail.relativeTime(new Date(mail.syncedAtMs), now)
              : "",
          ),
          state: lastError || signedOut
            ? "error"
            : mail?.loading
              ? "loading"
              : "ready",
          // What the window most needs to say. It takes the right of
          // the status line from the hints while it has something.
          //
          // The signed-out sentence wins over the raw failure: the host's
          // reply travels as far as here, and "provider requires sign-in" is
          // a protocol word, not something to read off a mailbox.
          notice: card.notice || lastError,
          // Rendered from the keymap and nothing else. Three
          // hand-written copies of this list used to exist and had
          // already drifted apart.
          // Filtered by what this provider cannot honour. `e` and `s` are bound
          // in every mail context whatever mailbox is open, so a row that
          // offered them unconditionally promised HEY an archive and a star it
          // does not have — the same promise the missing button exists to stop.
          // `c`, `r`, `a` and `f` are bound the same way, so a mailbox with no
          // SMTP server drops them from the row as well as from the toolbar.
          hints: hintsFor(
            mail?.selectedId && !app.readerHidden ? "reader" : "list",
            Model.unavailableActions(provider.capabilities).concat(
              unavailableWriting(provider.capabilities),
            ),
          ),
        },
        loadingMore: mail?.loadingMore === true,
        canLoadMore: Boolean(mail?.nextPageToken) && !mail?.loadingMore,
        canRetry: mail?.canRetry === true,
        signedOut,
        signInLabel: card.actionLabel,
        onSignIn: (
          /** @type {any} */ _event,
          /** @type {any} */ eventCx,
        ) => {
          app.state = {
            ...app.state,
            route: "setup",
            setupProviderId: provider.id,
          };
          eventCx.notify();
        },
        onLoadMore: (
          /** @type {any} */ _event,
          /** @type {any} */ eventCx,
        ) => {
          app.controller?.loadMore();
          eventCx.notify();
        },
        onRetry: (
          /** @type {any} */ _event,
          /** @type {any} */ eventCx,
        ) => {
          app.controller?.retry();
          eventCx.notify();
        },
        onAccount: (
          /** @type {string} */ id,
          /** @type {any} */ _event,
          /** @type {any} */ eventCx,
        ) => app.switchAccount(id, eventCx),
        onMailbox: (
          /** @type {string} */ key,
          /** @type {any} */ _event,
          /** @type {any} */ eventCx,
        ) => {
          app.controller?.selectMailbox(key);
          app.search.set_value("");
          eventCx.notify();
        },
        onMessage: (
          /** @type {string} */ id,
          /** @type {any} */ _event,
          /** @type {any} */ eventCx,
        ) => {
          app.readerHidden = false;
          app.controller?.openMessage(id);
          eventCx.notify();
        },
        onCalendar: (
          /** @type {any} */ _event,
          /** @type {any} */ eventCx,
        ) => app.openCalendar(eventCx),
        calendarSelected: false,
      };
}
