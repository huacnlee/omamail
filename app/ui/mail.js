// @ts-check

import { div } from "gpui";
import { h_flex, v_flex } from "gpui-base";
import {
  AppShell,
  KeyHints,
  MutedText,
  StatusBar,
  StatusItem,
  TextField,
  TitleBar,
  alpha,
  role,
  style,
} from "omarchy-ui";
import { actionIcon } from "./controls.js";
import { brandLockup } from "./brand.js";
import { MAIL_SPLITTER_WIDTH, mailLayout, viewportSize } from "./layout.js";
import { renderMessageList } from "./message-list.js";
import { renderMailboxTabs, renderRail } from "./rail.js";
import { renderAppMenu, renderAccountSwitcherCard } from "./menu.js";
import { renderReader } from "./reader.js";

// The search field is capped well short of the space it is given: a field as
// wide as the window looks like the window's main event, and it is not. Below
// the floor there is no slot worth typing in, and the shortcut still reopens it
// as the window grows.
const SEARCH_MAX_WIDTH = 340;
const SEARCH_MIN_SLOT = 120;
// A divider's weight, not a control's. `SearchBar.qml` writes the rest border
// as the foreground at 0.12 — the tint `PanelSeparator` draws a rule with —
// rather than at the kit's control-border alpha: the outlined box the kit
// gives a field was the loudest thing in a header of dim icons, and nothing in
// that header is used less often than search. Focus still gets the real
// border, because then it is saying something.
const SEARCH_REST_BORDER_ALPHA = 0.12;
// `PanelActionButton`'s own default, which is what the QML clear button is.
const SEARCH_CLEAR_SIZE = 22;

/**
 * The search field, ported from `components/SearchBar.qml`.
 *
 * The provider's own operator syntax goes straight through — `from:`,
 * `has:attachment`, `older_than:7d` — which is why the placeholder spends its
 * width on two examples: nowhere else says so at the moment somebody would use
 * it.
 * @param {any} search @param {import("gpui").Context} cx
 */
function searchField(search, cx) {
  const tokens = style();
  const foreground = cx.theme().colors.foreground;
  const rest = /** @type {import("gpui").Color} */ (
    alpha(foreground, SEARCH_REST_BORDER_ALPHA)
  );
  // The × appears with something to clear and not before: an always-present
  // clear button is a control that does nothing on most of the visits this
  // field gets.
  const clearable =
    String(search?.text ?? "") !== "" && typeof search?.onClear === "function";
  return (
    h_flex()
      .id("mail-search")
      // The field fills the slot and the × sits inside its right edge, so the
      // button has to be positioned against this row rather than laid out beside
      // the input — which would put it outside the border it belongs in.
      .relative()
      .flex_1()
      .min_w_0()
      .items_center()
      .child(
        new TextField()
          .state(search.state)
          .build(cx)
          .accessibility_label("Search mail")
          // A query is list text, not a form value: it is read beside the rows
          // it filters and takes their size.
          .text_size(tokens.font.bodySmall)
          .border_color(rest)
          // The rest border survives the pointer: only focus commits to the
          // control border, which is the state the outline is actually about.
          // The fill is re-declared alongside it rather than left to the kit's
          // own hover, because a second refinement that named only the border
          // would depend on the two being merged rather than replaced.
          .hover((appearance) =>
            appearance
              .bg(
                /** @type {import("gpui").Color} */ (
                  alpha(foreground, tokens.state.hoverFillAlpha)
                ),
              )
              .border_color(rest),
          )
          // Room for the × rather than text running under it.
          .when(clearable, (input) =>
            input.pr(
              tokens.spacing.controlPaddingX + tokens.space(SEARCH_CLEAR_SIZE),
            ),
          ),
      )
      .when(clearable, (row) =>
        row.child(
          actionIcon("mail-search-clear", "close", "Clear search · Esc")
            // Waiting in the muted foreground and coming forward when pointed
            // at: a × that is as loud as the query beside it reads as part of
            // the query.
            .quiet()
            .size("small")
            .onClick((/** @type {any} */ event, /** @type {any} */ eventCx) =>
              search.onClear(event, eventCx),
            )
            .build(cx)
            // Narrower than the small step, because it sits *inside* the field
            // rather than beside it — and centred by arithmetic rather than by
            // the row: an absolutely placed child is out of the flex flow, so
            // `items_center` above has nothing to say about it.
            .size(tokens.space(SEARCH_CLEAR_SIZE))
            .absolute()
            .right(tokens.space(4))
            .top(
              Math.round(
                (tokens.spacing.controlHeight -
                  tokens.space(SEARCH_CLEAR_SIZE)) /
                  2,
              ),
            ),
        ),
      )
  );
}

/**
 * The window's own strip: what this is on the left, what you are looking for in
 * the middle, and what you do to the mailbox as a whole on the right. The menu
 * stays with the mark because it is the window's menu rather than an action on
 * the mailbox.
 * @param {any} model @param {boolean} compact @param {import("gpui").Context} cx
 */
function header(model, compact, cx) {
  const tokens = style();
  const dim = cx.theme().colors.muted_foreground;
  const searchVisible = !compact;
  return new TitleBar()
    .brand(
      h_flex()
        .id("mail-header-left")
        .flex_none()
        .items_center()
        .gap(tokens.space(8))
        .child(brandLockup(cx, { compact }))
        .child(renderAppMenu(model.menu ?? {}, cx)),
    )
    .center(
      h_flex()
        .id("mail-topbar")
        .flex_1()
        .min_w_0()
        .items_center()
        .justify_center()
        .when(searchVisible, (slot) =>
          slot.child(
            h_flex()
              .w_full()
              .max_w(tokens.space(SEARCH_MAX_WIDTH))
              .min_w(tokens.space(SEARCH_MIN_SLOT))
              .child(searchField(model.search, cx)),
          ),
        ),
    )
    .actions(
      h_flex()
        .id("mail-header-right")
        .flex_none()
        .items_center()
        // Tighter than the left cluster: these are a set of icons doing the
        // same kind of thing, not three separate ideas.
        .gap(tokens.space(4))
        .child(
          actionIcon(
            "mail-refresh",
            "refresh",
            model.status.state === "loading"
              ? "Checking for mail"
              : "Check mail · F5",
          )
            .disabled(model.status.state === "loading")
            .quiet()
            .onClick(model.header.onRefresh ?? (() => {}))
            .build(cx),
        )
        // No Compose where the mailbox has nowhere to hand a message to. An
        // IMAP account with no SMTP server is a supported setup — the form
        // offers it — and a button that opened a form the send would refuse
        // fails after the user has written the message.
        .when(model.capabilities?.send !== false, (header) =>
          header.child(
            actionIcon("compose", "send", "Compose · c")
              .quiet()
              .onClick(model.header.onCompose)
              .build(cx),
          ),
        ),
    )
    .build(cx);
}

/**
 * The status line. The left says how current the list is — the account has a
 * home in the sidebar's user bar already, so repeating it there would say
 * nothing new. The right carries one of two things: what the window most needs
 * to say, or, when it has nothing to report, what the keyboard can do from
 * where you are standing.
 * @param {any} model @param {boolean} compact @param {import("gpui").Context} cx
 */
function statusBar(model, compact, cx) {
  const tokens = style();
  const dim = cx.theme().colors.muted_foreground;
  const notice = String(model.status.notice ?? "");
  // How current the list is. The sentence about what went wrong is `notice`,
  // on the other side of the bar, so this side is often empty — and a state
  // colours the words it is given, which means there is nothing here for it to
  // land on when there are none.
  const report = String(model.status.label ?? "");
  return new StatusBar()
    .leadsWithIcon(!compact && typeof model.onToggleSidebar === "function")
    .status(
      h_flex()
        .id("mail-status")
        .flex_1()
        .min_w_0()
        .items_center()
        .gap(tokens.space(8))
        .when(!compact && typeof model.onToggleSidebar === "function", (line) =>
          line.child(
            // No fill for the open state. The sidebar standing there is the
            // state, said better than a lit square on the status line could,
            // and this control has no business drawing attention to itself.
            //
            // The small step is `space(24)` at the small icon size, which is
            // what a 28-tall status line has room for: the kit's own size
            // would leave the glyph taller than the line it sits on.
            actionIcon(
              "sidebar-toggle",
              "sidebar",
              model.sidebarCollapsed ? "Show the sidebar" : "Hide the sidebar",
            )
              .quiet()
              .size("small")
              .onClick(model.onToggleSidebar)
              .build(cx),
          ),
        )
        .child(
          (report
            ? new StatusItem()
                .label(report)
                .loadingLabel(report)
                .state(model.status.state)
            : new StatusItem()
          )
            .build(cx)
            .id("mail-status-label")
            .min_w_0()
            .truncate()
            .text_size(tokens.font.caption),
        ),
    )
    .hints(
      notice
        ? new MutedText(notice)
            .build(cx)
            .id("mail-status-notice")
            .flex_none()
            .max_w("50%")
            .truncate()
            .text_size(tokens.font.caption)
        : new KeyHints("key-hints").hints(model.status.hints ?? []).build(cx),
    )
    .build(cx);
}

/** @param {any} model @param {import("gpui").Context} cx */
export function renderMail(model, cx) {
  const viewportWidth = viewportSize(model.width).width;
  const layout = mailLayout(viewportWidth, Boolean(model.selectedId), {
    sidebarCollapsed: model.sidebarCollapsed === true,
    listWidth: model.listWidth ?? 0,
  });
  const tokens = style();

  const list = v_flex()
    .id("mail-list-pane")
    // Pinned to the width the layout resolved whenever the reader stands
    // beside it; only the single-column window lets the list have the lot.
    .when(layout.mode !== "single", (pane) =>
      pane.flex_none().w(layout.listWidth).min_w(layout.listWidth),
    )
    .when(layout.mode === "single", (pane) => pane.flex_1().w_full().min_w_0())
    .min_h_0()
    .border_r(tokens.spacing.hairline)
    .border_color(role("separator", cx.theme().colors.border))
    // No header strip above the list. The mailbox's name is already on the
    // sidebar row that is lit, and again on the reader's blank slate; a third
    // copy would cost a row of messages to say nothing new.
    .child(
      renderMessageList(
        {
          messages: model.messages,
          cursorId: model.cursorId,
          selectedId: model.selectedId,
          hoveredId: model.hoveredId,
          loading: model.loading,
          loaded: model.loaded,
          searchQuery: model.searchQuery,
          capabilities: model.capabilities,
          menu: model.messageMenu,
          // Pagination is the end of the list rather than a bar beside it, so
          // it scrolls with the rows the way `MessageList.qml`'s own footer
          // does.
          loadingMore: model.loadingMore,
          canLoadMore: model.canLoadMore,
          canRetry: model.canRetry,
          signedOut: model.signedOut,
          signInLabel: model.signInLabel,
          onLoadMore: model.onLoadMore,
          onRetry: model.onRetry,
          onSignIn: model.onSignIn,
          onMessage: model.onMessage,
          onHover: model.onHover,
          onStar: model.onStar,
          onArchive: model.onArchive,
          onTrash: model.onTrash,
          onMenu: model.onMessageMenu,
        },
        cx,
      ),
    );

  // The divider between the list and the message, and the handle that moves it.
  // A hairline is the right thing to look at and the wrong thing to aim at, so
  // the grab area is wider than the rule it draws — the visible rule meets the
  // list's edge and the rest of the width stays to its right as a target.
  const splitter = div()
    .id("mail-splitter")
    .flex_none()
    .w(tokens.space(MAIL_SPLITTER_WIDTH))
    .h_full()
    // No rule of its own: the list pane's right border is the rule, and this is
    // the width beside it that the pointer can actually hit.
    .cursor_col_resize()
    .on_mouse_down("left", (event, eventCx) =>
      model.onSplitterPress?.(event, eventCx),
    );

  const shell = new AppShell()
    .top(header(model, layout.compact, cx))
    .content(
      h_flex()
        .id(`mail-layout-${layout.mode}`)
        // A five-pixel strip loses the pointer the moment a drag moves faster
        // than the frame, so the row the panes sit in is what reports the
        // movement. It only listens while a drag is live.
        .when(model.dragging === true, (row) =>
          row
            .on_mouse_move((event, eventCx) =>
              model.onSplitterDrag?.(event, eventCx),
            )
            .on_mouse_up("left", (event, eventCx) =>
              model.onSplitterRelease?.(event, eventCx),
            ),
        )
        // `h_flex` centres its children on the cross axis, which for a row of
        // full-height columns means each one shrinks to its content and floats
        // in the middle of the window. The three panes are columns, not items
        // in a row: they stretch.
        .items_stretch()
        .size_full()
        .min_w_0()
        .min_h_0()
        .children([
          ...(layout.showRail
            ? [
                renderRail(
                  // The effective collapse, not the stored preference: between
                  // the breakpoints the window collapses the rail whatever the
                  // preference says, and the rail must draw itself to the slot
                  // it was actually given.
                  { ...model, sidebarCollapsed: layout.sidebarCollapsed },
                  cx,
                ),
              ]
            : []),
          ...(layout.showList
            ? [
                layout.showTabs
                  ? v_flex()
                      .id("mail-list-column")
                      .flex_1()
                      .min_w_0()
                      .min_h_0()
                      .child(
                        renderMailboxTabs(
                          {
                            mailboxes: model.mailboxes,
                            unread: model.unread,
                            width: viewportWidth,
                            onMailbox: model.onMailbox,
                          },
                          cx,
                        ),
                      )
                      .child(list)
                  : list,
              ]
            : []),
          // Only where both columns are on screen: there is nothing to divide
          // in a single-column window.
          ...(layout.showSplitter && layout.showList && layout.showReader
            ? [splitter]
            : []),
          ...(layout.showReader
            ? [
                v_flex()
                  .id("mail-reader-pane")
                  .flex_1()
                  .min_w_0()
                  .min_h_0()
                  .child(renderReader(model.reader, cx)),
              ]
            : []),
        ]),
    )
    .bottom(statusBar(model, layout.compact, cx))
    .build(cx);

  // The switcher lives on the rail, and a narrow window has no rail — which is
  // exactly the case the app menu's "Switch account..." row exists for, and it
  // opened onto nothing. Centred, because opened from a menu there is no pointer
  // position to hang the card off and anywhere else would be pretending it
  // belongs to something on screen. `AccountSwitcher.qml`'s `openCentered()`.
  if (layout.showRail || model.switcherOpen !== true) return shell;
  return div()
    .id("mail-with-switcher")
    .relative()
    .size_full()
    .min_w_0()
    .min_h_0()
    .child(shell)
    .child(
      div()
        .id("account-switcher-centered")
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        // A press anywhere off the card puts it away, which is what the popup's
        // own CloseOnPressOutside does on the rail.
        .on_click((_event, eventCx) =>
          model.onSwitcherOpenChange?.(false, eventCx),
        )
        .child(
          renderAccountSwitcherCard(
            {
              open: true,
              cursorIndex: model.switcherCursor,
              accounts: model.accounts,
              onOpenChange: model.onSwitcherOpenChange,
              onAccount: model.onAccount,
              onAdd: model.onAddAccount,
              onManage: model.onManageAccounts,
            },
            cx,
          ),
        ),
    );
}
