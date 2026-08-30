// @ts-check

// Where the mail screen answers its keys.
//
// One element carries the context and every `on_action` the mailbox installs,
// and it is the element the keyboard is parked on — those are the same fact in
// gpui: a key travels the path from the tree root to the *focused* node, and a
// `key_context` that is not on that path matches nothing at all. `App.qml` says
// this as a focus scope with a `keyboardHome` in it; here it is `track_focus`
// and `key_context` on one `v_flex`, and `runShortcut`'s cases as handlers.

import { v_flex } from "gpui-base";
import * as Model from "../account/Model.js";
import {
  goAccountSlot,
  goSlot,
  openAccountSwitcher,
} from "../application/mail-actions.js";
import {
  beginReaderSelection,
  copyReaderBody,
} from "../application/reader-selection.js";

/**
 * What a key means on the mail screen, by precedence — a query being typed beats
 * the list underneath it, exactly as `App.qml`'s `keyContext` has it.
 *
 * `MailSearch` binds no bare key but Escape, and that is the whole guard: gpui
 * matches a binding against every ancestor's context, so with the field inside
 * `MailList` the mailbox's own `e`, `d`, `r` and `c` were live while somebody
 * was typing — and on Linux a binding beats the character, so a query archived,
 * trashed and replied instead of arriving in the field.
 * @param {any} mail @param {boolean} hidden @param {boolean} [searching]
 */
export function mailKeyContext(mail, hidden, searching = false) {
  if (searching) return "MailSearch";
  return mail?.selectedId && !hidden ? "MailReader" : "MailList";
}

/**
 * The two keys the table declares for every context, installed on any route.
 *
 * `keys/Keymap.js` gives `refresh` and `settings` the context `ANY`, and
 * `App.qml` answers both from `runShortcut` whatever is on screen. Here each
 * route builds its own root with its own handlers, so "every context" has to be
 * something a route can ask for — otherwise F5 works on the mailbox and nowhere
 * else, which is what it did.
 *
 * @param {any} app the window
 * @param {any} element the route's own root
 * @returns {import("gpui").Element} the same element, so the chain stays typed
 */
export function globalActions(app, element) {
  return element
    .on_action("mail::refresh", (/** @type {any} */ _event, /** @type {any} */ eventCx) => {
      app.controller?.refresh();
      eventCx.notify();
    })
    .on_action("mail::settings", (/** @type {any} */ _event, /** @type {any} */ eventCx) =>
      app.openSettings(eventCx),
    );
}

/**
 * The mail screen's action host: the context, the keyboard's home, and one
 * handler per row of the keymap — `runShortcut`, taken apart.
 * @param {any} app the window @param {any} mail its mail state
 */
export function mailActionHost(app, mail) {
  const host = v_flex()
    .id("mail-action-host")
    .size_full()
    .min_w_0()
    .min_h_0()
    // The keyboard's home on this screen. Without it nothing in the window
    // is focusable, every key dispatches from the tree root where none of
    // these contexts are, and a press on anything that is not a control
    // blurs the window — see `keys/focus.js`.
    .track_focus(app.keyboardHome)
    .key_context(
      mailKeyContext(mail, app.readerHidden === true, app.searchFocused),
    )
    .on_action("mail::cursorDown", (_event, eventCx) =>
      app.moveCursor(1, eventCx),
    )
    .on_action("mail::cursorUp", (_event, eventCx) =>
      app.moveCursor(-1, eventCx),
    )
    .on_action("mail::open", (_event, eventCx) => app.openCursor(eventCx))
    .on_action("mail::backToList", (_event, eventCx) => app.back(eventCx))
    .on_action("mail::back", (_event, eventCx) => app.back(eventCx))
    .on_action("mail::settings", (_event, eventCx) =>
      app.openSettings(eventCx),
    )
    .on_action("mail::archive", (_event, eventCx) =>
      app.actCurrent("archive", eventCx),
    )
    .on_action("mail::trash", (_event, eventCx) =>
      app.actCurrent("trash", eventCx),
    )
    .on_action("mail::star", (_event, eventCx) =>
      app.actCurrent("star", eventCx),
    )
    .on_action("mail::spam", (_event, eventCx) =>
      app.actCurrent("spam", eventCx),
    )
    .on_action("mail::markRead", (_event, eventCx) =>
      app.actCurrent("markRead", eventCx),
    )
    .on_action("mail::markUnread", (_event, eventCx) =>
      app.actCurrent("markUnread", eventCx),
    )
    .on_action("mail::reply", (_event, eventCx) =>
      app.openResponse("reply", eventCx),
    )
    .on_action("mail::replyAll", (_event, eventCx) =>
      app.openResponse("replyAll", eventCx),
    )
    .on_action("mail::forward", (_event, eventCx) =>
      app.openResponse("forward", eventCx),
    )
    .on_action("mail::refresh", (_event, eventCx) => {
      app.controller?.refresh();
      eventCx.notify();
    })
    // Four keys the table binds on this screen that nothing here answered.
    //
    // `actionBindings` installs a binding for every row of `HANDLED_ACTIONS`,
    // and the shortcut sheet advertises the same list — so a row with no
    // `on_action` on the route it is bound to is a key the window promises and
    // then ignores. `c` is the most-used write key in the application and it
    // did nothing at all on the mailbox; the three view keys left the calendar
    // with no keyboard route in or out.
    .on_action("mail::compose", (_event, eventCx) => app.openCompose(eventCx))
    .on_action("mail::calendar", (_event, eventCx) => app.openCalendar(eventCx))
    .on_action("mail::calendarView", (_event, eventCx) =>
      app.openCalendar(eventCx),
    )
    .on_action("mail::mailView", (_event, eventCx) => app.openMail(eventCx))
    .on_action("mail::toggleSidebar", (_event, eventCx) =>
      app.toggleSidebar(eventCx),
    )
    // Alt+A opens a list the keyboard then walks — `j`, `k`, `Enter` or `o` —
    // which is the whole reason it is one key rather than nine.
    .on_action("mail::switchAccount", (_event, eventCx) =>
      openAccountSwitcher(app, true, eventCx),
    )
    .on_action("mail::zoomIn", (_event, eventCx) => app.zoomBy(0.1, eventCx))
    .on_action("mail::zoomOut", (_event, eventCx) =>
      app.zoomBy(-0.1, eventCx),
    )
    // The two the QML reader got from Qt's own `TextEdit`. `Ctrl+A` here only
    // opens the surface a selection can happen in — the host gives a script no
    // way to move the keyboard into a textarea, so the pointer still has to
    // land in it once, and from then on the surface's own select-all is the one
    // that fires, being deeper in the dispatch path than this element.
    .on_action("mail::copyBody", (_event, eventCx) =>
      copyReaderBody(app, eventCx),
    )
    .on_action("mail::selectAll", (_event, eventCx) =>
      beginReaderSelection(app, eventCx),
    )
    .on_action("mail::zoomReset", (_event, eventCx) => {
      app.bodyZoom = Model.clampZoom(1);
      app.storage.setItem("omamail.bodyZoom", String(app.bodyZoom));
      eventCx.notify();
    });
  // One action per key for the two numbered rows: `mail::goMailbox::2` is
  // what Ctrl+3 dispatches, because an action carries its name and nothing
  // else and ten keys on one name are ten keys nothing can tell apart.
  let numbered = host;
  for (let slot = 0; slot < 10; slot += 1) {
    const at = slot;
    numbered = numbered
      .on_action(`mail::goMailbox::${at}`, (_event, eventCx) =>
        goSlot(app, at, eventCx),
      )
      .on_action(`mail::goAccount::${at}`, (_event, eventCx) =>
        goAccountSlot(app, at, eventCx),
      );
  }
  return numbered;
}
