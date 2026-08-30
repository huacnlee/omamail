// @ts-check

// The three menus, the numbered rail keys, and the two standing reading
// answers.
//
// Lifted out of `main.js` for the reason `mail-model.js` was: the window's own
// shape was unreadable past them, and the file had grown past the repository's
// size ceiling, which is the same complaint said by a test. Each of these takes
// the window as its first argument, the way the model builder does — the state
// is still the window's, and this is only where the rules about it are written.

import * as Registry from "../providers/Registry.js";
import * as Model from "../account/Model.js";
import { messageMenuRows } from "../ui/message-menu.js";
import { appMenuGroups } from "../ui/menu.js";
import {
  beginReaderSelection,
  canTakeReaderBody,
  copyReaderBody,
} from "./reader-selection.js";
import { firstSelectable, nextSelectable } from "../components/Menu.js";
import { AUTHOR_URL, PROJECT_URL } from "./links.js";
import { openShortcuts } from "../keys/overlay.js";
import { accountIn, providerFor } from "./account-capabilities.js";

/** @param {any} app */
function activeAccount(app) {
  return accountIn(app.controller?.snapshot());
}

/** @param {any} app */
function activeProvider(app) {
  // Narrowed by the mailbox, not only by the service: an IMAP account with no
  // SMTP server declares no `send`, so the menu rows that write a message go
  // with the buttons rather than staying behind to fail.
  return providerFor(activeAccount(app));
}

/**
 * What the row menu may offer for one message. Read by the view that draws the
 * menu and by the keyboard that walks it, because a row the mouse can see and
 * the cursor cannot count is a cursor whose Enter lands somewhere else.
 * @param {any} app @param {string} messageId
 */
export function menuCapabilitiesFor(app, messageId) {
  const provider = activeProvider(app);
  return {
    archive: provider.capabilities.archive,
    spam: provider.capabilities.spam,
    star: provider.capabilities.star,
    // The three answering rows. False for a mailbox with no SMTP server, which
    // is a question about the account rather than about the service — an IMAP
    // one declares `send` and a particular one of them still has nowhere to
    // hand a message to.
    send: provider.capabilities.send,
    // `web` is the capability's own name. Asking about a key no provider
    // declares is asking a question that always answers yes, which is how an
    // IMAP mailbox came to be offered a web address nothing here could know.
    web: Boolean(Registry.webMessageUrl(provider.id, messageId)),
    // The two body rows act on the parse, which exists for the message the
    // reader has open and for no other. A menu raised on a different row is a
    // menu about a summary, and a summary has no body to take.
    bodyText:
      app.controller?.snapshot().mail?.selectedId === messageId &&
      canTakeReaderBody(app),
  };
}

/**
 * The menu's rows as the keyboard counts them: every action row in order, the
 * hidden ones included, so an index means the same thing here as it does to
 * the view drawing them.
 * @param {any} app @param {string} messageId
 */
export function menuRowsFor(app, messageId) {
  const message = (app.controller?.snapshot().mail?.messages ?? []).find(
    (/** @type {any} */ entry) => String(entry.id) === messageId,
  );
  return messageMenuRows(message ?? null, menuCapabilitiesFor(app, messageId));
}

/**
 * Open the row's own menu, under the pointer that asked for it.
 *
 * `local_position` is the press's offset inside the row, which is the only
 * geometry the list has without measuring the window — and it is where a menu
 * asked for by that pointer belongs.
 * @param {any} app @param {string} id @param {any} event
 * @param {import("gpui").Context} cx
 */
export function openMessageMenu(app, id, event, cx) {
  const messageId = String(id || "");
  if (!messageId) return;
  app.messageMenu = {
    messageId,
    x: Number(event?.local_position?.x) || 0,
    y: Number(event?.local_position?.y) || 0,
    // The first row that is actually there. A cursor parked on a row the
    // provider hid is a menu whose Enter does nothing and says nothing about
    // why.
    cursorIndex: firstSelectable(menuRowsFor(app, messageId)),
  };
  cx.notify();
}

/** @param {any} app @param {import("gpui").Context} cx */
export function closeMessageMenu(app, cx) {
  app.messageMenu = null;
  cx.notify();
}

/** @param {any} app @param {number} offset @param {import("gpui").Context} cx */
export function moveMessageMenu(app, offset, cx) {
  const menu = app.messageMenu;
  if (!menu) return;
  app.messageMenu = {
    ...menu,
    cursorIndex: nextSelectable(
      menuRowsFor(app, menu.messageId),
      menu.cursorIndex,
      offset,
    ),
  };
  cx.notify();
}

/** @param {any} app @param {import("gpui").Context} cx */
export function runMessageMenuCursor(app, cx) {
  const menu = app.messageMenu;
  const row = menu
    ? menuRowsFor(app, menu.messageId)[Number(menu.cursorIndex)]
    : null;
  if (!menu || !row || row.visible !== true) {
    cx.notify();
    return;
  }
  runMessageMenu(app, String(row.action), menu.messageId, cx);
}

/**
 * What one of the menu's rows does.
 *
 * Answering opens the message first, because a reply needs the message it is
 * answering and a list row is only a summary. Everything else goes through the
 * cursor, so one path decides what the list does after a row leaves it rather
 * than two that would have to agree.
 * @param {any} app @param {string} action @param {string} id
 * @param {import("gpui").Context} cx
 */
export function runMessageMenu(app, action, id, cx) {
  app.messageMenu = null;
  if (action === "reply" || action === "replyAll" || action === "forward") {
    app.readerHidden = false;
    app.controller?.openMessage(id);
    app.openResponse(action, cx);
    return;
  }
  // Neither of these touches the mailbox, so neither goes through the cursor:
  // there is no row to move afterwards and nothing for the list to decide.
  if (action === "copyBody") {
    copyReaderBody(app, cx);
    return;
  }
  if (action === "selectBody") {
    beginReaderSelection(app, cx);
    return;
  }
  if (action === "openWeb") {
    const url = Registry.webMessageUrl(activeProvider(app).id, id);
    if (url) cx.open_url(url);
    cx.notify();
    return;
  }
  app.controller?.placeCursor(id);
  app.actCurrent(action, cx);
}

/**
 * The window's own menu: what it holds, and what each row does.
 *
 * It lives here rather than in the view model because the keyboard needs the
 * same list the mouse gets. `AppMenu.qml` runs a cursor from a `Keys` handler on
 * the popup's content; this host's popups take no keys, so the window runs the
 * cursor — and a second description of the rows, written for it, is exactly the
 * drift `keys/keymap.js` exists to stop.
 * @param {any} app
 */
export function appMenuModel(app) {
  const snapshot = app.controller?.snapshot();
  const mail = snapshot?.mail;
  const provider = activeProvider(app);
  return {
    open: app.appMenuOpen === true,
    cursorIndex: Number(app.appMenuCursor) || 0,
    signedIn: Boolean(activeAccount(app)),
    // A row that cannot apply is absent rather than disabled: an IMAP mailbox
    // has no web inbox, and offering to open somebody else's is worse than not
    // offering.
    canOpenWebInbox: Boolean(Registry.webBoxUrl(provider.id, mail?.query ?? "")),
    accountCount: snapshot?.accounts.accounts.length ?? 0,
    onOpenChange: (/** @type {boolean} */ next, /** @type {any} */ cx) =>
      openAppMenu(app, next, cx),
    onMarkRead: (/** @type {any} */ _event, /** @type {any} */ cx) => {
      // Only the ones that are unread. "Mark these read" acts on the messages
      // that are loaded, and sending the verb for a message that is already
      // read is a round trip that changes nothing and a row redrawn for no
      // reason.
      app.controller?.act(
        "markRead",
        (mail?.messages ?? [])
          .filter(
            (/** @type {any} */ message) =>
              message.unread === true || message.labelIds?.includes("UNREAD"),
          )
          .map((/** @type {any} */ message) => String(message.id)),
      );
      cx.notify();
    },
    onOpenWeb: (/** @type {any} */ _event, /** @type {any} */ cx) => {
      const url = Registry.webBoxUrl(provider.id, mail?.query ?? "");
      if (url) cx.open_url(url);
    },
    // The rail carries the switcher, and the rail is gone at a narrow window —
    // so at that size this menu is the only way left to reach it.
    onSwitchAccount: (/** @type {any} */ _event, /** @type {any} */ cx) =>
      openAccountSwitcher(app, true, cx),
    onSettings: (/** @type {any} */ _event, /** @type {any} */ cx) =>
      app.openSettings(cx),
    onShortcuts: (/** @type {any} */ _event, /** @type {any} */ cx) =>
      openShortcuts(app, cx),
    onProject: (/** @type {any} */ _event, /** @type {any} */ cx) =>
      cx.open_url(PROJECT_URL),
    onAuthor: (/** @type {any} */ _event, /** @type {any} */ cx) =>
      cx.open_url(AUTHOR_URL),
  };
}

/**
 * The menu's rows as the keyboard counts them: the groups flattened, in the
 * order they are drawn, so an index means the same thing here as it does on
 * screen.
 * @param {any} app
 */
export function appMenuRows(app) {
  return appMenuGroups(appMenuModel(app)).flat();
}

/**
 * Opening puts the keyboard on the first row that is actually there. A cursor
 * parked on a row the provider hid is a menu whose Enter does nothing and says
 * nothing about why.
 * @param {any} app @param {boolean} open @param {import("gpui").Context} cx
 */
export function openAppMenu(app, open, cx) {
  app.appMenuOpen = open === true;
  if (app.appMenuOpen) app.appMenuCursor = firstSelectable(appMenuRows(app));
  cx.notify();
}

/** @param {any} app @param {number} offset @param {import("gpui").Context} cx */
export function moveAppMenu(app, offset, cx) {
  app.appMenuCursor = nextSelectable(appMenuRows(app), app.appMenuCursor, offset);
  cx.notify();
}

/** @param {any} app @param {import("gpui").Context} cx */
export function runAppMenuCursor(app, cx) {
  const row = appMenuRows(app)[Number(app.appMenuCursor)];
  if (!row || row.disabled === true) {
    cx.notify();
    return;
  }
  app.appMenuOpen = false;
  row.onActivate?.({}, cx);
  cx.notify();
}

/**
 * Every mailbox this window is signed in to, in the switcher's own order — the
 * order `goAccount`'s numbers count in, so the row a number opens and the row
 * the cursor lands on are one list.
 * @param {any} app
 */
export function accountSwitcherAccounts(app) {
  return (
    app.controller?.snapshot().accounts.accounts ??
    app.accountList?.accounts ??
    []
  );
}

/**
 * Opening puts the keyboard on the mailbox you are already in, so the first `j`
 * is one step away from it rather than back at the top of the list.
 * @param {any} app @param {boolean} open @param {import("gpui").Context} cx
 */
export function openAccountSwitcher(app, open, cx) {
  app.accountSwitcherOpen = open === true;
  if (app.accountSwitcherOpen) {
    const activeId =
      app.controller?.snapshot().accounts.activeId ?? app.accountList?.activeId;
    const at = accountSwitcherAccounts(app).findIndex(
      (/** @type {any} */ account) => account.id === activeId,
    );
    app.accountSwitcherCursor = at < 0 ? 0 : at;
    // The window's menu and the switcher are one question asked twice, so the
    // menu goes away rather than standing behind the card it opened.
    app.appMenuOpen = false;
  }
  cx.notify();
}

/**
 * The cursor wraps here, where the message list clamps. A menu is a ring of a
 * handful of rows and the ends are not a place anybody means to stop.
 * @param {any} app @param {number} offset @param {import("gpui").Context} cx
 */
export function moveAccountSwitcher(app, offset, cx) {
  app.accountSwitcherCursor = Model.wrappedIndex(
    app.accountSwitcherCursor,
    offset,
    accountSwitcherAccounts(app).length,
  );
  cx.notify();
}

/** @param {any} app @param {import("gpui").Context} cx */
export function runAccountSwitcherCursor(app, cx) {
  const account = accountSwitcherAccounts(app)[
    Number(app.accountSwitcherCursor)
  ];
  app.accountSwitcherOpen = false;
  if (account?.id) app.switchAccount(account.id, cx);
  else cx.notify();
}

/**
 * The rail as the keys see it: one numbered list, the same one the badges are
 * drawn from, so the number beside a row and the row a number opens are one
 * fact rather than two.
 * @param {any} app @param {number} index @param {import("gpui").Context} cx
 */
export function goSlot(app, index, cx) {
  const provider = activeProvider(app);
  const slot = Model.sidebarSlots(Registry.mailboxes(provider.id), [], 10)[
    index
  ];
  if (slot?.kind === "mailbox") {
    app.controller?.selectMailbox(String(slot.key));
    app.search.set_value("");
    app.readerHidden = false;
  }
  cx.notify();
}

/**
 * The account at that place in the switcher's own order, so the number a key
 * names and the row it opens cannot disagree.
 * @param {any} app @param {number} index @param {import("gpui").Context} cx
 */
export function goAccountSlot(app, index, cx) {
  const accounts =
    app.controller?.snapshot().accounts.accounts ?? app.accountList.accounts;
  const account = accounts[index];
  if (account?.id) app.switchAccount(account.id, cx);
  else cx.notify();
}

/**
 * The two reading answers are standing ones. Settings is where they are given
 * and the one place that takes them back, so the reader is told at start and
 * again whenever one changes — rather than only when a per-message notice
 * happens to be pressed, which left both stored answers doing nothing on either
 * side.
 * @param {any} app @returns {number[]} the image sources still to fetch
 */
export function applyReadingPreferences(app) {
  const settings = app.settings;
  const reader = app.readerController;
  if (!settings || !reader) return [];
  reader.setAlwaysRenderHeavyMessages(
    settings.preference("heavyMessageRendering") === true,
  );
  return reader.showRemoteImages(settings.preference("remoteImages") === true);
}

/**
 * The notice's own button, which is the switch: what it turns on is every
 * message, and it says "Always show" because that is what it does. Settings is
 * the one place that turns it back off.
 * @param {any} app @param {import("gpui").Context} cx
 */
export function allowRemoteImages(app, cx) {
  cx.spawn(async (/** @type {import("gpui").AsyncContext} */ asyncCx) => {
    await app.settings.toggleRemoteImages(true);
    // Fetched one at a time and through the host's own curl, which follows no
    // redirect and takes a size ceiling. Qt's loader took neither, and the
    // reader is what decides that a picture may be asked for at all.
    for (const index of applyReadingPreferences(app)) {
      try {
        await app.readerController.loadImage(index);
      } catch (_) {
        // A picture that did not arrive is a picture that is not there. The
        // message is still readable, and one failed host is not a notice.
      }
      asyncCx.notify();
    }
    asyncCx.notify();
  });
  cx.notify();
}
