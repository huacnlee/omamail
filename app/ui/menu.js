// @ts-check

import { div } from "gpui";
import { Button, Popover, v_flex } from "gpui-base";
import {
  actionButton,
  alpha,
  menuItem,
  menuSeparator,
  popupSurface,
  role,
  style,
} from "../lib/omarchy-ui/index.js";

/**
 * Nothing painted. gpui's colour vocabulary is a theme token or a hex literal
 * and has no "transparent" keyword — passing one refuses the whole view.
 */
const NO_FILL = /** @type {import("gpui").Color} */ ("#00000000");

// The width the QML menu pins itself to. A menu that sized itself to its
// longest row would change width as rows come and go — the account switcher
// row is only there with more than one account — and a control that moves
// under the pointer between openings is worse than one that wastes a few
// pixels on its shortest label.
const MENU_WIDTH = 210;

/**
 * The rows, in groups. Links out, plus the handful of actions with no natural
 * home on screen: what this window can do to the mailbox as a whole, where
 * else to go, and where this came from.
 *
 * A row that cannot apply is absent rather than disabled — a Gmail account has
 * a web inbox and an IMAP one does not, and offering to open something else's
 * inbox is worse than not offering.
 * @param {any} model
 */
export function appMenuGroups(model) {
  /** @type {Array<Array<{id:string,caption:string,disabled?:boolean,dim?:boolean,onActivate?:any}>>} */
  const groups = [
    [
      {
        id: "mark-read",
        // "These" and not "all": it marks the messages that are loaded, which
        // is what you are looking at, not every message the mailbox holds.
        caption: "Mark these read",
        disabled: !model.signedIn,
        onActivate: model.onMarkRead,
      },
      ...(model.canOpenWebInbox
        ? [
            {
              id: "web-inbox",
              caption: "Open web inbox...",
              disabled: !model.signedIn,
              onActivate: model.onOpenWeb,
            },
          ]
        : []),
    ],
    [
      ...(model.accountCount > 1
        ? [
            {
              id: "switch-account",
              caption: "Switch account...",
              onActivate: model.onSwitchAccount,
            },
          ]
        : []),
      { id: "settings", caption: "Settings...", onActivate: model.onSettings },
    ],
    // The last group leaves the app, and its rows are drawn like every other:
    // `AppMenu.qml` gives them the plain foreground. A dimmer tone would read
    // as three rows that cannot be used, which is what dim means everywhere
    // else on this menu.
    [
      { id: "keyboard", caption: "Keyboard...", onActivate: model.onShortcuts },
      { id: "project", caption: "GitHub...", onActivate: model.onProject },
      { id: "author", caption: "Twitter...", onActivate: model.onAuthor },
    ],
  ];
  return groups.filter((group) => group.length > 0);
}

/**
 * The window's own menu, hung off the mark rather than off the mailbox
 * controls on the right: it is a menu about this window, not an action on the
 * messages.
 *
 * The trigger holds a selected style for as long as the menu is up. A trigger
 * that looks untouched while its own menu is on screen leaves the menu looking
 * unattached to anything, and leaves the reader without an answer to "which of
 * these opened it".
 * @param {any} model @param {import("gpui").Context} cx
 */
export function renderAppMenu(model, cx) {
  const tokens = style();
  const open = model.open === true;
  return Popover.new("app-menu")
    .open(open)
    .on_open_change(
      (/** @type {boolean} */ next, /** @type {any} */ eventCx) =>
        model.onOpenChange?.(next, eventCx),
    )
    .trigger(
      actionButton("app-menu-trigger", "menu", "Menu", () => {}, cx, {
        selected: open,
        color: cx.theme().colors.muted_foreground,
      }),
    )
    .content(
      popupSurface("app-menu-surface", cx)
        .w(tokens.space(MENU_WIDTH))
        .children(
          // The rows, and where the keyboard is standing among them. `at` counts
          // the action rows only — the separators are not rows anybody can land
          // on — so it is the same index `keys/actions.js` moves and runs.
          (() => {
            let at = -1;
            return appMenuGroups(model).flatMap((group, index) => [
              ...(index > 0 ? [menuSeparator(cx)] : []),
              ...group.map((row) => {
                at += 1;
                return menuItem(
                  `app-menu-${row.id}`,
                  row.caption,
                  (/** @type {any} */ event, /** @type {any} */ eventCx) => {
                    model.onOpenChange?.(false, eventCx);
                    row.onActivate?.(event, eventCx);
                  },
                  cx,
                  {
                    disabled: row.disabled === true,
                    dim: row.dim === true,
                    cursor: open && at === Number(model.cursorIndex),
                  },
                ).w_full();
              }),
            ]);
          })(),
        ),
    );
}

/**
 * Every mailbox this window is signed in to, opened from the user bar at the
 * foot of the rail.
 *
 * The rail itself shows only the mailbox in use. A permanent list of every
 * account would spend the bottom of the sidebar on a question that is asked
 * once a day at most, and the address on that one row is what says which
 * mailbox the messages beside it belong to.
 *
 * @param {any} model
 * @param {any} trigger the user-bar row this hangs off
 * @param {import("gpui").Context} cx
 */
export function renderAccountSwitcher(model, trigger, cx) {
  return Popover.new("account-switcher")
    .open(model.open === true)
    // Pinned by its own bottom edge: the user bar sits at the foot of the
    // window, so the card has to grow upward or it grows off the screen.
    .anchor("bottom_left")
    .on_open_change(
      (/** @type {boolean} */ next, /** @type {any} */ eventCx) =>
        model.onOpenChange?.(next, eventCx),
    )
    .trigger(trigger)
    .content(renderAccountSwitcherCard(model, cx));
}

/**
 * One mailbox in the switcher.
 *
 * Not a menu row: `AccountSwitcher.qml` draws an initial in a disc beside two
 * stacked lines at `Style.space(40)`, which is what tells two mailboxes apart
 * at a glance and what a single-line menu item cannot say. The address rather
 * than the name derived from it, for the same reason — two accounts can easily
 * share a local part across different domains.
 *
 * The mailbox you are in owns the selected fill and a heavier address; the
 * keyboard's cursor is a border over whichever fill is already there, because
 * a third fill would have to compete with the one saying where you are.
 *
 * @param {any} account @param {boolean} hasCursor
 * @param {(event:any,cx:any)=>void} onClick @param {import("gpui").Context} cx
 */
function switcherRow(account, hasCursor, onClick, cx) {
  const tokens = style();
  const address = String(account.email || "");
  const active = account.selected === true;
  const foreground = cx.theme().colors.foreground;
  const hoverFill = alpha(foreground, tokens.state.hoverFillAlpha);
  const selectedFill = alpha(foreground, tokens.state.selectedFillAlpha);
  // Says why an account is not usable rather than leaving it looking identical
  // to one that is — and otherwise only where the name says something the
  // address does not.
  const error = String(account.error || "");
  const name = String(account.label || "");
  const detail =
    error !== ""
      ? error
      : account.signedIn === false
        ? "Signed out"
        : account.busy === true
          ? "Checking"
          : name !== "" && address.indexOf(name) !== 0
            ? name
            : "";
  return Button.new(`account-switcher-${account.id}`)
    .role("menu_item")
    .selected(active)
    .accessibility_label(detail === "" ? address : `${address}, ${detail}`)
    .flex()
    .items_center()
    .w_full()
    .flex_none()
    .h(tokens.space(40))
    .pl(tokens.space(8))
    .pr(tokens.space(10))
    .gap(tokens.space(9))
    .rounded(tokens.cornerRadius)
    .bg(active ? selectedFill : hasCursor ? hoverFill : NO_FILL)
    // The border is reserved in both states and only recoloured, so landing on
    // a row does not gain it a pixel a side and shove the card's rows along.
    .border(tokens.state.normalBorderWidth)
    .border_color(
      hasCursor ? alpha(foreground, tokens.state.hoverBorderAlpha) : NO_FILL,
    )
    .hover((appearance) => appearance.bg(active ? selectedFill : hoverFill))
    .on_click(onClick)
    .child(
      // An initial rather than a picture: Gmail's own avatar is behind an API
      // this app does not ask permission for, and an address is always Latin
      // script, so one letter is safe here in a way a label name is not.
      div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(tokens.space(22))
        .rounded_full()
        .bg(selectedFill)
        .text_size(tokens.font.caption)
        .text_color(foreground)
        .font_bold()
        .child(address === "" ? "+" : address.charAt(0).toUpperCase()),
    )
    .child(
      v_flex()
        .flex_1()
        .min_w_0()
        .gap(tokens.space(1))
        .child(
          div()
            .w_full()
            .text_ellipsis_middle()
            .text_size(tokens.font.bodySmall)
            .text_color(foreground)
            .when(active, (line) => line.font_bold())
            .child(address === "" ? "New account" : address),
        )
        .when(detail !== "", (lines) =>
          lines.child(
            div()
              .w_full()
              .truncate()
              .text_size(tokens.font.caption)
              .text_color(
                error !== ""
                  ? role("urgent", cx.theme().colors.destructive)
                  : cx.theme().colors.muted_foreground,
              )
              .child(detail),
          ),
        ),
    );
}

/**
 * The card itself, drawn once for both the places it appears.
 *
 * The rail carries it, and a narrow window has no rail — which is exactly what
 * the app menu's "Switch account..." row is for. `AccountSwitcher.qml` answers
 * that with `openCentered()`: opened from a menu rather than from a click on the
 * rail there is no pointer position to hang it off, and centring is the honest
 * answer, because anywhere else would be pretending it belongs to something on
 * screen.
 * @param {any} model @param {import("gpui").Context} cx
 */
export function renderAccountSwitcherCard(model, cx) {
  const tokens = style();
  const accounts = Array.isArray(model.accounts) ? model.accounts : [];
  const cursorIndex = Number(model.cursorIndex);
  const tail = [
    ...(typeof model.onAdd === "function"
      ? [{ id: "add", caption: "Add a mailbox...", onActivate: model.onAdd }]
      : []),
    ...(typeof model.onManage === "function"
      ? [
          {
            id: "manage",
            caption: "Manage accounts...",
            onActivate: model.onManage,
          },
        ]
      : []),
  ];
  return popupSurface("account-switcher-surface", cx)
    .w(tokens.space(250))
    .children(
      accounts.map((/** @type {any} */ account, /** @type {number} */ index) =>
        switcherRow(
          account,
          // Where the keyboard is standing, which is not the mailbox you are
          // in: the row you are already on owns the selected fill, and `j` has
          // to be visible walking across it.
          model.open === true && index === cursorIndex,
          (/** @type {any} */ event, /** @type {any} */ eventCx) => {
            model.onOpenChange?.(false, eventCx);
            model.onAccount?.(account.id, event, eventCx);
          },
          cx,
        ),
      ),
    )
    .when(tail.length > 0 && accounts.length > 0, (surface) =>
      surface.child(menuSeparator(cx)),
    )
    .children(
      tail.map((row) =>
        menuItem(
          `account-switcher-${row.id}`,
          row.caption,
          (/** @type {any} */ event, /** @type {any} */ eventCx) => {
            model.onOpenChange?.(false, eventCx);
            row.onActivate?.(event, eventCx);
          },
          cx,
        ).w_full(),
      ),
    );
}
