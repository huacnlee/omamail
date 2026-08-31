// @ts-check

import { div } from "gpui";
import { Popup } from "gpui-base";
import { MenuItem, MenuSeparator, PopupSurface, style } from "omarchy-ui";

// The list's right-click menu, ported from `components/MessageMenu.qml`.
//
// The card is painted in a layer of its own rather than as a child of the row
// it belongs to: a row lives inside a clipping scroller, which would cut the
// menu off at the column edge and scroll it away under the pointer that opened
// it. The QML measured its own placement for the same reason; base's popup
// measures the trigger and keeps itself clear of the window edges, so that
// arithmetic is no longer ours.

/**
 * @typedef {{
 *   kind: "action" | "separator",
 *   id?: string,
 *   caption?: string,
 *   action?: string,
 *   danger?: boolean,
 *   dim?: boolean,
 *   visible: boolean,
 * }} MessageMenuEntry
 */

/**
 * @typedef {{
 *   archive?: boolean,
 *   spam?: boolean,
 *   star?: boolean,
 *   web?: boolean,
 *   bodyText?: boolean,
 *   send?: boolean,
 * }} MessageMenuCapabilities
 */

// `Popup { width: Style.space(200) }` in the QML: a fixed card rather than one
// measured from its longest label, so the menu is the same shape every time.
const MENU_WIDTH = 200;

/**
 * Every row the menu can draw, in order and including the hidden ones, so a
 * cursor index means the same thing to the keyboard as it does here.
 *
 * A verb the provider does not have is hidden rather than disabled. IMAP
 * archives by moving to a folder that may not exist, and has no junk verb the
 * server learns anything from — a "Report spam" that quietly meant "move to a
 * folder" would be a promise this cannot keep.
 * @param {import("./message-row.js").MessageSummary | null} message
 * @param {MessageMenuCapabilities} [capabilities]
 * @returns {MessageMenuEntry[]}
 */
export function messageMenuEntries(message, capabilities = {}) {
  const unread = message?.unread === true;
  const starred = message?.starred === true;
  return [
    // A mailbox with no SMTP server cannot send, so it is not offered three
    // rows that refuse. `ImapSetupPage.qml` calls that state out in the field's
    // own placeholder — "SMTP server — leave empty to read only" — and the
    // separator goes with them, or it leads the menu once they are gone.
    {
      kind: "action",
      id: "reply",
      caption: "Reply",
      action: "reply",
      visible: capabilities.send !== false,
    },
    {
      kind: "action",
      id: "replyAll",
      caption: "Reply all",
      action: "replyAll",
      visible: capabilities.send !== false,
    },
    {
      kind: "action",
      id: "forward",
      caption: "Forward",
      action: "forward",
      visible: capabilities.send !== false,
    },
    { kind: "separator", visible: capabilities.send !== false },
    {
      kind: "action",
      id: "archive",
      caption: "Archive",
      action: "archive",
      visible: capabilities.archive !== false,
    },
    {
      kind: "action",
      id: "trash",
      caption: "Move to trash",
      action: "trash",
      danger: true,
      visible: true,
    },
    {
      kind: "action",
      id: "spam",
      caption: "Report spam",
      action: "spam",
      danger: true,
      visible: capabilities.spam !== false,
    },
    { kind: "separator", visible: true },
    {
      kind: "action",
      id: "read",
      caption: unread ? "Mark as read" : "Mark as unread",
      action: unread ? "markRead" : "markUnread",
      visible: true,
    },
    {
      kind: "action",
      id: "star",
      caption: starred ? "Unstar" : "Star",
      action: starred ? "unstar" : "star",
      visible: capabilities.star !== false,
    },
    { kind: "separator", visible: true },
    // The two ways of taking the message's words with you, and the reader's own
    // menu rows: this is the one message menu the application has, and the QML
    // would have put them here for that reason. They are the only rows whose
    // capability defaults to *absent* rather than present, because what they act
    // on is the parsed body — which exists for the message the reader has open
    // and for no other. A list row is a summary, and a "copy the text" that
    // copied a snippet would be a promise this cannot keep.
    //
    // Both are in the QML reader already, as a `TextEdit` that selects by mouse.
    // Neither is reachable here without them.
    {
      kind: "action",
      id: "selectBody",
      caption: "Select all text",
      action: "selectBody",
      visible: capabilities.bodyText === true,
    },
    {
      kind: "action",
      id: "copyBody",
      caption: "Copy message text",
      action: "copyBody",
      visible: capabilities.bodyText === true,
    },
    { kind: "separator", visible: capabilities.bodyText === true },
    // Only where there is a web mailbox to open. An IMAP account has no
    // address this client could know. `web` is the capability's own name —
    // asking about a key no provider declares is asking a question that always
    // answers yes, which is how IMAP came to be offered this row.
    {
      kind: "action",
      id: "browser",
      caption: "Open in browser...",
      action: "openWeb",
      // `tone: root.dimColor` in the QML. It still belongs on the menu, but it
      // is the row that leaves the application rather than one of the verbs the
      // menu is mostly for.
      dim: true,
      visible: capabilities.web !== false,
    },
  ];
}

/**
 * The action rows alone, which is what a cursor index counts.
 * @param {import("./message-row.js").MessageSummary | null} message
 * @param {MessageMenuCapabilities} [capabilities]
 */
export function messageMenuRows(message, capabilities) {
  return messageMenuEntries(message, capabilities).filter(
    (entry) => entry.kind === "action",
  );
}

/**
 * `x` and `y` are the press's position inside the row it opened on, which is
 * what `on_mouse_down` reports as `local_position`. A menu belongs under the
 * pointer that asked for it, and that offset is the only geometry the list has
 * without measuring the window.
 * @typedef {{
 *   messageId: string,
 *   message?: import("./message-row.js").MessageSummary | null,
 *   x?: number,
 *   y?: number,
 *   cursorIndex?: number,
 *   capabilities?: MessageMenuCapabilities,
 *   onAction?: (action:string, id:string, event:any, cx:import("gpui").Context) => void,
 *   onDismiss?: (event:any, cx:import("gpui").Context) => void,
 * }} MessageMenuModel
 */

/**
 * @param {MessageMenuModel} menu
 * @param {import("gpui").Context} cx
 */
export function renderMessageMenu(menu, cx) {
  const tokens = style();
  const entries = messageMenuEntries(menu.message ?? null, menu.capabilities);
  const width = tokens.space(MENU_WIDTH);
  const cursorIndex = Number.isFinite(menu.cursorIndex)
    ? Number(menu.cursorIndex)
    : -1;

  /** @type {import("gpui").Element[]} */
  const children = [];
  let row = -1;
  for (const entry of entries) {
    if (entry.kind === "action") row += 1;
    if (!entry.visible) continue;
    if (entry.kind === "separator") {
      // `MenuSeparatorLine.qml`: a rule with `Style.space(7)` of its own around
      // it, so a group boundary costs the same whichever rows it falls between.
      children.push(new MenuSeparator().build(cx));
      continue;
    }
    const action = String(entry.action);
    children.push(
      new MenuItem(`message-menu-${entry.id}`)
        .label(String(entry.caption))
        .danger(entry.danger === true)
        // A row that leaves the application still belongs on the menu, but it
        // is not one of the verbs the menu is mostly for. No token names that,
        // so it is the caller's tone.
        .tone(
          entry.dim === true ? cx.theme().colors.muted_foreground : undefined,
        )
        // Where the keyboard is standing. A menu row has one such state:
        // nothing here is chosen, so the kit draws it at the pointer's own
        // fill, the way `MenuActionRow.qml` does.
        .selected(row === cursorIndex)
        .onClick((event, eventCx) =>
          menu.onAction?.(action, menu.messageId, event, eventCx),
        )
        .build(cx),
    );
  }

  // Its ground and its edge are their own theme roles rather than the window's:
  // `[popups]` in `shell.toml` typically points the border at the compositor's
  // own active-window colour, so a menu's edge matches the frame Hyprland draws
  // around the window it belongs to.
  const card = new PopupSurface("message-menu-card")
    .build(cx)
    .role("menu")
    .w(width)
    .on_mouse_down_out((event, eventCx) => menu.onDismiss?.(event, eventCx))
    .children(children);

  // The popup measures its trigger, so the trigger is a mark of no size sitting
  // at the pointer's offset inside the row — which is where a menu asked for by
  // that pointer belongs.
  //
  // One menu is open at a time, so one identity serves: reopening it on another
  // row is the same surface moving, not a second one appearing.
  return Popup.new("message-menu", div().w(0).h(0))
    .absolute()
    .left(Number(menu.x) || 0)
    .top(Number(menu.y) || 0)
    .anchor("top_left")
    .content(card);
}
