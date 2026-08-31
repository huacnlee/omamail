// @ts-check

import { div } from "gpui";
import { h_flex, v_flex } from "gpui-base";
import { Label, MutedText, alpha, style } from "omarchy-ui";
import { renderMessageMenu } from "./message-menu.js";
import { actionIcon } from "./controls.js";

// One message in the list, ported from `components/MessageRow.qml`. Unread is
// carried by weight and by the dot on the left, never by colour alone — the
// accent is a theme value that some themes put close to the foreground.

/**
 * @typedef {{
 *   id: string,
 *   sender: string,
 *   subject: string,
 *   snippet: string,
 *   time: string,
 *   unread: boolean,
 *   starred?: boolean,
 * }} MessageSummary
 */

/**
 * @typedef {{
 *   selected?: boolean,
 *   cursor?: boolean,
 *   hovered?: boolean,
 *   canArchive?: boolean,
 *   menu?: import("./message-menu.js").MessageMenuModel|null,
 *   onOpen?: (id:string, event:any, cx:import("gpui").Context) => void,
 *   onStar?: (id:string, event:any, cx:import("gpui").Context) => void,
 *   onArchive?: (id:string, event:any, cx:import("gpui").Context) => void,
 *   onTrash?: (id:string, event:any, cx:import("gpui").Context) => void,
 *   onMenu?: (id:string, event:any, cx:import("gpui").Context) => void,
 *   onHover?: (id:string, hovered:boolean, cx:import("gpui").Context) => void,
 * }} MessageRowState
 */

/**
 * The row id the keyboard, the tests and the click handler all address.
 * @param {MessageSummary} message @param {MessageRowState} state
 */
export function messageRowId(message, state) {
  const suffix = state.selected ? "selected" : state.cursor ? "cursor" : "idle";
  return `message-${message.id}-${suffix}`;
}

/**
 * A press on a row action must not also open the message underneath it.
 * @param {((id:string, event:any, cx:import("gpui").Context) => void) | undefined} handler
 * @param {string} id
 */
function rowAction(handler, id) {
  return (/** @type {any} */ event, /** @type {any} */ cx) => {
    cx.stop_propagation?.();
    handler?.(id, event, cx);
  };
}

/**
 * @param {MessageSummary} message
 * @param {MessageRowState} state
 * @param {import("gpui").Context} cx
 */
export function renderMessageRow(message, state, cx) {
  const tokens = style();
  const colors = cx.theme().colors;
  // Hover and the keyboard cursor say the same thing — this is the row an
  // action would land on — so they look the same. Selection is the row the
  // reader is showing, which is a different claim and outranks both.
  //
  // Hover arrives as state rather than as a style because revealing a *child*
  // on hover is not something a hover style can declare; the row reports its
  // own hover and is told what to draw.
  const hot = Boolean(state.hovered || state.cursor);
  const starred = message.starred === true;
  // A starred message keeps its star whether or not the row is hot, so the
  // action row is what decides where the text stops.
  const showsActions = hot || starred;
  const canArchive = state.canArchive !== false;
  // A row draws its own context menu, because the row is what the menu is
  // anchored to and what it is about.
  const menu = state.menu ? renderMessageMenu(state.menu, cx) : null;

  const dot = div()
    .id(`message-unread-${message.id}`)
    .flex_none()
    .size(tokens.space(5))
    .rounded_full()
    .bg(colors.primary);

  // The dot's own column. It keeps its width whether or not a dot is in it, so
  // the text of every row starts on the same vertical line — the 14 the reader's
  // content and the header's logo also start at.
  const gutter = v_flex()
    .flex_none()
    .w(tokens.space(10))
    // The QML anchors the dot 12 below the row's top; the row's own 7 of
    // padding plus 5 here is that same line.
    .pt(tokens.space(5))
    .when(message.unread, (column) => column.child(dot));

  // The subject leads. It is what the message is, and it is what you scan a
  // list for; the sender had the top line and the weight, which put the
  // emphasis on who wrote rather than on what about.
  const body = v_flex()
    .id(`message-row-${message.id}`)
    .flex_1()
    .min_w_0()
    .gap(tokens.space(2))
    .child(
      h_flex()
        .w_full()
        .min_w_0()
        // The time sits on the subject's baseline rather than in its middle:
        // the two are different sizes and a centred pair reads as misaligned.
        .items_baseline()
        .gap(tokens.space(8))
        .child(
          new Label(message.subject)
            .build(cx)
            .id(`message-row-${message.id}-subject`)
            .flex_1()
            .min_w_0()
            .truncate()
            .when(message.unread, (text) => text.font_bold()),
        )
        .child(
          new MutedText(message.time)
            .build(cx)
            .flex_none()
            .text_size(tokens.font.caption),
        ),
    )
    .child(
      new MutedText(message.sender)
        .build(cx)
        .id(`message-row-${message.id}-sender`)
        .min_w_0()
        .truncate()
        .text_size(tokens.font.bodySmall),
    )
    .when(message.snippet !== "", (column) =>
      column.child(
        new Label(message.snippet)
          .build(cx)
          .id(`message-row-${message.id}-snippet`)
          .min_w_0()
          .truncate()
          .text_size(tokens.font.caption)
          // `alpha` answers a hex string; the element API asks for the
          // narrower Color the palette roles are typed as.
          .text_color(
            /** @type {import("gpui").Color} */ (
              alpha(colors.foreground, 0.42)
            ),
          ),
      ),
    );

  // Row actions appear on hover or under the keyboard cursor. A starred
  // message keeps its star visible either way, because that is state rather
  // than an affordance.
  //
  // `IconButton { iconSize: Style.font.iconSmall; size: Style.space(24) }` in
  // the QML, which is a smaller glyph than the kit's default: these sit inside
  // a text row rather than in a toolbar, and at the icon size they would stand
  // taller than the subject beside them. That is the kit's small step exactly
  // — `space(24)` at the small icon size — so the row asks for the step rather
  // than for the two measurements.
  const actions = h_flex()
    .flex_none()
    .items_center()
    .self_center()
    .ml(tokens.space(8))
    .gap(tokens.space(1))
    .child(
      // The star is the one row action whose lit state is a colour, so the
      // accent is its tone rather than its hover: set, it stays lit; unset, it
      // is quiet and arrives at that same accent under the pointer. The QML
      // gives it `hoverColor: accentColor` where its neighbours take the
      // foreground.
      actionIcon(
        `message-star-${message.id}`,
        starred ? "star-filled" : "star",
        `${starred ? "Unstar" : "Star"} · s`,
      )
        .tone(colors.primary)
        .quiet(!starred)
        .size("small")
        .onClick(rowAction(state.onStar, message.id))
        .build(cx),
    )
    // No archive button where the account has nowhere to archive to. On IMAP
    // that is a move to a folder, and a server without one would have this
    // quietly do nothing.
    .when(hot && canArchive, (row) =>
      row.child(
        actionIcon(`message-archive-${message.id}`, "archive", "Archive · e")
          .quiet()
          .size("small")
          .onClick(rowAction(state.onArchive, message.id))
          .build(cx),
      ),
    )
    .when(hot, (row) =>
      row.child(
        actionIcon(`message-trash-${message.id}`, "trash", "Move to trash · d")
          .quiet()
          .size("small")
          .onClick(rowAction(state.onTrash, message.id))
          .build(cx),
      ),
    );

  return (
    h_flex()
      .id(messageRowId(message, state))
      .role("button")
      .accessibility_label(
        [
          message.unread ? "Unread" : "",
          starred ? "Starred" : "",
          message.subject,
          message.sender,
          message.time,
        ]
          .filter(Boolean)
          .join(", "),
      )
      .w_full()
      .min_w_0()
      .items_start()
      // The row is the positioning parent its own context menu anchors into.
      .relative()
      // The QML row is its body plus 14, split evenly above and below. The 4 on
      // the left is where the dot's column starts. On the right the QML anchors
      // the text to the action row when there is one and to the row's own edge
      // when there is not, at two different margins — 6 for the actions, 8 for
      // the text — so the inset moves with what is actually standing there.
      .py(tokens.space(7))
      .pl(tokens.space(4))
      .pr(tokens.space(showsActions ? 6 : 8))
      .rounded(tokens.cornerRadius)
      // `accent` and `muted` are the semantic theme's names for the shell's
      // `selectedFillFor` and `hoverFillFor`: the same alphas over the same
      // roles. An idle row is painted by nothing at all, so the list reads as one
      // surface rather than as a stack of tiles.
      .when(state.selected, (row) => row.bg(colors.accent))
      .when(!state.selected && hot, (row) => row.bg(colors.muted))
      .when(!state.selected, (row) =>
        row.hover((appearance) => appearance.bg(colors.muted)),
      )
      .child(gutter)
      .child(body)
      .when(showsActions, (row) => row.child(actions))
      .children(menu ? [menu] : [])
      .on_click((event, eventCx) => state.onOpen?.(message.id, event, eventCx))
      // Middle-click archives: the one triage action worth having without moving
      // the pointer to a button.
      .when(canArchive && Boolean(state.onArchive), (row) =>
        row.on_mouse_down("middle", (event, eventCx) =>
          state.onArchive?.(message.id, event, eventCx),
        ),
      )
      .when(Boolean(state.onMenu), (row) =>
        row.on_mouse_down("right", (event, eventCx) =>
          state.onMenu?.(message.id, event, eventCx),
        ),
      )
      // Hovering a row must not move the keyboard's cursor: letting hover write
      // `cursorId` put the mouse and the keyboard in a fight the mouse won, since
      // j scrolls the list and a row moving under a still pointer re-reports
      // hover. This reports hover and nothing else.
      .when(Boolean(state.onHover), (row) =>
        row.on_hover((hovered, eventCx) =>
          state.onHover?.(message.id, hovered, eventCx),
        ),
      )
  );
}
