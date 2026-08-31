// @ts-check

import { div } from "gpui";
import { h_flex, v_flex } from "gpui-base";
import { Button, MutedText, alpha, style } from "omarchy-ui";
import { renderMessageRow } from "./message-row.js";

// The message list, ported from `components/MessageList.qml`: rows in one
// scroller, the skeleton that stands in for them while the first page loads,
// and the slot three states share — still loading, loaded and empty, or nothing
// loaded yet.

/** @typedef {import("./message-row.js").MessageSummary} MessageSummary */

/**
 * @typedef {{
 *   messages: MessageSummary[],
 *   cursorId?: string|null,
 *   selectedId?: string|null,
 *   hoveredId?: string|null,
 *   loading?: boolean,
 *   loaded?: boolean,
 *   searchQuery?: string,
 *   loadingMore?: boolean,
 *   canLoadMore?: boolean,
 *   canRetry?: boolean,
 *   signedOut?: boolean,
 *   signInLabel?: string,
 *   onLoadMore?: (event:any, cx:import("gpui").Context) => void,
 *   onRetry?: (event:any, cx:import("gpui").Context) => void,
 *   onSignIn?: (event:any, cx:import("gpui").Context) => void,
 *   capabilities?: import("./message-menu.js").MessageMenuCapabilities,
 *   menu?: import("./message-menu.js").MessageMenuModel|null,
 *   onMessage: (id:string, event:any, cx:import("gpui").Context) => void,
 *   onStar?: (id:string, event:any, cx:import("gpui").Context) => void,
 *   onArchive?: (id:string, event:any, cx:import("gpui").Context) => void,
 *   onTrash?: (id:string, event:any, cx:import("gpui").Context) => void,
 *   onMenu?: (id:string, event:any, cx:import("gpui").Context) => void,
 *   onHover?: (id:string, hovered:boolean, cx:import("gpui").Context) => void,
 * }} MessageListModel
 */

// Rows shaped like the message summaries that will replace them, at the widths
// `ListSkeleton.qml` draws. The shell pulses these; here they rest at the low
// end of that pulse, because a list that animates while it loads is the one
// thing on the desktop asking to be watched.
const SKELETON_ROWS = [0.76, 0.61, 0.84, 0.69, 0.79, 0.57];
const SKELETON_PULSE = 0.45;

/** @param {number} factor @param {number} height @param {import("gpui").Context} cx */
function skeletonBar(factor, height, cx) {
  return (
    div()
      .flex_none()
      .w(`${Math.round(Math.max(0.01, factor) * 1000) / 10}%`)
      .h(height)
      .rounded(style().cornerRadius)
      // `alpha` answers a hex string; the element API asks for the narrower
      // Color the palette roles are typed as.
      .bg(
        /** @type {import("gpui").Color} */ (
          alpha(cx.theme().colors.foreground, 0.05 + 0.05 * SKELETON_PULSE)
        ),
      )
  );
}

/** @param {import("gpui").Context} cx */
function listSkeleton(cx) {
  const tokens = style();
  return v_flex()
    .id("message-list-skeleton")
    .flex_none()
    .gap(tokens.space(2))
    .children(
      SKELETON_ROWS.map((factor, index) =>
        v_flex()
          .id(`message-list-skeleton-${index}`)
          .h(tokens.space(64))
          .justify_center()
          .px(tokens.space(14))
          .gap(tokens.space(5))
          .child(skeletonBar(factor, tokens.space(9), cx))
          .child(
            skeletonBar(Math.max(0.28, factor - 0.34), tokens.space(8), cx),
          )
          .child(
            skeletonBar(Math.min(0.72, factor + 0.08), tokens.space(7), cx),
          ),
      ),
    );
}

/**
 * Three states share this slot, and only one of them is an error: still
 * loading, loaded and empty, or nothing loaded yet.
 * @param {MessageListModel} model @param {import("gpui").Context} cx
 */
function emptySlot(model, cx) {
  const tokens = style();
  // A signed-out mailbox has not answered, so it is never "Nothing here":
  // agreeing with a failure is the thing this slot must not do.
  const caption =
    model.signedOut === true
      ? "This mailbox is signed out"
      : model.loaded
        ? model.searchQuery
          ? "Nothing matches that search"
          : "Nothing here"
        : "";
  return (
    v_flex()
      .id("message-list-empty")
      .flex_none()
      .h(tokens.space(70))
      .items_center()
      .justify_center()
      // The QML centres a caption `parent.width - Style.space(20)` wide, which
      // is ten a side rather than twenty: the sentence is short and the box is
      // there to stop it reaching the column's edges, not to indent it.
      .px(tokens.space(10))
      .child(
        new MutedText(caption)
          .build(cx)
          .text_size(tokens.font.bodySmall)
          .text_center(),
      )
  );
}

/**
 * Pagination is the only thing this footer needs to say, and it says it in one
 * control: `MessageList.qml` keeps the button standing while the next page is
 * on its way and relabels it, rather than swapping in a second line that
 * reports the same fact from a different place.
 *
 * It is inside the scroller because it is the end of the list, not a bar beside
 * it — a pinned footer would sit over the rows at every scroll position but the
 * last, which is the only one where it means anything.
 * @param {MessageListModel} model @param {import("gpui").Context} cx
 */
function listFooter(model, cx) {
  const tokens = style();
  const loading = model.loadingMore === true;
  return (
    h_flex()
      .id("message-list-footer")
      .flex_none()
      .w_full()
      .h(tokens.space(40))
      .items_center()
      .justify_end()
      .gap(tokens.space(4))
      .pr(tokens.space(8))
      // A mailbox with no credential left is the one failure with a way out of
      // it, and this is where the way out goes: the QML answers a signed-out
      // account with a setup card offering `Model.setupActionLabel`, and the
      // standalone window has no card, so the label stands here instead. It
      // replaces Retry rather than joining it — nothing this window can send
      // will be answered until somebody signs in.
      .when(model.signedOut === true, (row) =>
        row.child(
          new Button("mail-sign-in")
            .label(model.signInLabel || "Sign in...")
            .size("xsmall")
            .onClick(model.onSignIn ?? (() => {}))
            .build(cx),
        ),
      )
      // A first page that never arrived is not a page that ran out, and the two
      // are the only reasons this row is here at all. The QML window has no
      // retry of its own; this one does, because a failed read leaves the list
      // empty and there would otherwise be nothing to press.
      .when(model.canRetry === true, (row) =>
        row.child(
          new Button("mail-retry")
            .label("Retry")
            .size("xsmall")
            .onClick(model.onRetry ?? (() => {}))
            .build(cx),
        ),
      )
      .when(model.canLoadMore === true || loading, (row) =>
        row.child(
          new Button("mail-load-more")
            .label(loading ? "Loading" : "Load more")
            .disabled(loading)
            .size("xsmall")
            .onClick(model.onLoadMore ?? (() => {}))
            .build(cx),
        ),
      )
  );
}

/**
 * @param {MessageListModel} model
 * @param {import("gpui").Context} cx
 */
export function renderMessageList(model, cx) {
  const tokens = style();
  const messages = model.messages ?? [];
  // The shell's `Model.showInitialListSkeleton`: bars stand in for a first page
  // that has nothing to show yet, never for a refresh of rows already on screen.
  const skeleton = Boolean(model.loading) && messages.length === 0;

  const footer =
    model.canLoadMore === true ||
    model.canRetry === true ||
    model.signedOut === true ||
    model.loadingMore === true;

  return (
    v_flex()
      .id("message-list")
      .flex_1()
      .min_w_0()
      .min_h_0()
      .overflow_y_scroll()
      // `MessageList.qml` sits at `y: Style.space(8)` inside a Flickable whose
      // content is `implicitHeight + Style.space(16)`: eight above the first row
      // and eight below the last. It is padding on the content rather than a
      // margin on the viewport, so the scrollbar still runs the column's full
      // height instead of being pushed in with it.
      .py(tokens.space(8))
      .gap(tokens.space(2))
      .children(
        messages.map((message) =>
          renderMessageRow(
            message,
            {
              selected: message.id === model.selectedId,
              cursor: message.id === model.cursorId,
              hovered: message.id === model.hoveredId,
              canArchive: model.capabilities?.archive !== false,
              // The open menu belongs to one row, and that row anchors it.
              menu:
                model.menu && model.menu.messageId === message.id
                  ? {
                      ...model.menu,
                      message: model.menu.message ?? message,
                      capabilities:
                        model.menu.capabilities ?? model.capabilities,
                    }
                  : null,
              onOpen: model.onMessage,
              onStar: model.onStar,
              onArchive: model.onArchive,
              onTrash: model.onTrash,
              onMenu: model.onMenu,
              onHover: model.onHover,
            },
            cx,
          ),
        ),
      )
      .when(skeleton, (list) => list.child(listSkeleton(cx)))
      .when(messages.length === 0 && !skeleton, (list) =>
        list.child(emptySlot(model, cx)),
      )
      .when(footer, (list) => list.child(listFooter(model, cx)))
  );
}
