// @ts-check

import { div } from "gpui";
import { Button, h_flex, v_flex } from "gpui-base";
import { badgeText, slotNumberOf } from "../account/Model.js";
import {
  alpha,
  sectionLabel,
  separator,
  style,
  role,
} from "../lib/omarchy-ui/index.js";
import { icon, iconNames } from "./icons.js";
import { renderAccountSwitcher } from "./menu.js";
import { MAIL_RAIL_COLLAPSED_WIDTH, MAIL_RAIL_WIDTH } from "./layout.js";

// The left column: the mailboxes this account's provider has, then whatever
// labels or folders the server reported.
//
// Icon-first, and narrow enough to leave open: the longest mailbox name is
// "All mail". Collapsing it to a strip of icons is one click away — the status
// line's toggle, which lives there rather than on the rail because a button
// that can disappear with the thing it toggles is a button you cannot press to
// get it back — and the tooltips carry the names either way, so the collapsed
// rail stays usable.

/**
 * @typedef {{id:string,label:string,icon?:string,count?:number,optional?:boolean,selected:boolean}} RailMailbox
 * @typedef {{id:string,name:string,unread?:number,system?:boolean,selected?:boolean}} RailLabel
 * @typedef {{id:string,label:string,email?:string,provider:string,selected:boolean,signedIn?:boolean,busy?:boolean,error?:string}} RailAccount
 * @typedef {{kind:string,key?:string,id?:string,name?:string}} RailSlot
 * @typedef {(id:string,event:any,cx:import("gpui").Context)=>void} RailHandler
 */

/**
 * The fills every row in the rail is painted with. Each one is the window's own
 * foreground at one of the theme's alphas, never a literal gray: that is what
 * lets the same rail sit on a black desktop and a white one.
 * @param {import("gpui").Context} cx
 */
function railFills(cx) {
  const { state } = style();
  const own = cx.theme().colors.foreground;
  const shade = (/** @type {number} */ value) =>
    /** @type {`#${string}`} */ (alpha(own, value));
  return {
    // The idle row draws nothing. Written as the foreground at zero alpha
    // rather than as a keyword, because a row's "no fill" is still a colour the
    // theme owns.
    clear: shade(0),
    hover: shade(state.hoverFillAlpha),
    selected: shade(state.selectedFillAlpha),
    pressed: shade(state.pressedFillAlpha),
  };
}

/**
 * A mailbox names its own glyph, but the name comes from a provider table and
 * the set is finite: an icon nobody drew would leave the row with a blank where
 * the one thing that is always there should be.
 * @param {string | undefined} name
 */
function drawableIcon(name) {
  return iconNames.includes(String(name || "")) ? String(name) : "mail";
}

/**
 * One row: an icon that is always there, a name that appears when there is
 * room, and a count that survives the collapse as a dot.
 *
 * @param {string} id
 * @param {{icon:string,label:string,count:number,selected:boolean,slotNumber:number,numbersVisible:boolean,collapsed:boolean}} entry
 * @param {(event:import("gpui").ClickEvent,cx:import("gpui").Context)=>void} onClick
 * @param {import("gpui").Context} cx
 */
function railRow(id, entry, onClick, cx) {
  const tokens = style();
  const fills = railFills(cx);
  const foreground = cx.theme().colors.foreground;
  const dim = cx.theme().colors.muted_foreground;
  const accent = cx.theme().colors.primary;
  // The badge names the key, not the position: the tenth row is opened by
  // Alt+0, so it says 0. A row past the tenth has no key and no badge.
  const showsNumber = entry.numbersVisible && entry.slotNumber > 0;
  const numberText = entry.slotNumber === 10 ? "0" : String(entry.slotNumber);
  const count = Math.max(0, Math.floor(entry.count || 0));

  return Button.new(id)
    .selected(entry.selected)
    .accessibility_label(count > 0 ? `${entry.label}, ${count}` : entry.label)
    // The tooltip is how the rail stays usable while collapsed, and it carries
    // the count too, which the dot can only hint at.
    .tooltip(count > 0 ? `${entry.label} · ${count}` : entry.label)
    .flex()
    .relative()
    .items_center()
    .w_full()
    .flex_none()
    .h(tokens.space(28))
    // The gaps are the QML's own anchor margins rather than one flex gap: the
    // glyph starts 8 from the row's edge, the name 9 after the glyph, and the
    // count 6 before its own 8 — a uniform gap would move the count away from
    // the edge the rail's rows are read down.
    .when(entry.collapsed, (row) => row.justify_center())
    .rounded(tokens.cornerRadius)
    .bg(entry.selected ? fills.selected : fills.clear)
    .hover((appearance) => appearance.bg(fills.hover))
    .active((appearance) => appearance.bg(fills.pressed))
    .on_click(onClick)
    .when(!(showsNumber && entry.collapsed), (row) =>
      row.child(
        icon(entry.icon, cx, {
          color: entry.selected ? foreground : dim,
        }).when(!entry.collapsed, (glyph) => glyph.ml(tokens.space(8))),
      ),
    )
    .when(!entry.collapsed, (row) =>
      row.child(
        div()
          .id(`${id}-label`)
          .flex_1()
          .min_w_0()
          .truncate()
          .ml(tokens.space(9))
          // Six before whatever stands to its right, which is the count, the
          // Alt chip, or the row's own edge — the QML anchors all three the
          // same way.
          .mr(tokens.space(6))
          .text_size(tokens.font.bodySmall)
          .text_color(entry.selected ? foreground : dim)
          .when(entry.selected, (text) => text.font_bold())
          .child(entry.label),
      ),
    )
    // Held Alt names every row. Collapsed there is no room beside the glyph, so
    // it stands where the glyph was; open it takes the count's place, because a
    // 148px rail cannot hold both and the count is the one you can get back by
    // letting go.
    .when(showsNumber, (row) =>
      row.child(
        div()
          .flex()
          .flex_none()
          .items_center()
          .justify_center()
          .size(tokens.space(16))
          .rounded(tokens.cornerRadius)
          .bg(fills.selected)
          .text_size(tokens.font.caption)
          .text_color(foreground)
          .font_bold()
          .when(!entry.collapsed, (chip) => chip.mr(tokens.space(6)))
          .child(numberText),
      ),
    )
    .when(count > 0 && !entry.collapsed && !showsNumber, (row) =>
      row.child(
        div()
          .flex_none()
          .mr(tokens.space(8))
          .text_size(tokens.font.caption)
          .text_color(accent)
          .font_bold()
          .child(badgeText(count, 999)),
      ),
    )
    // Collapsed the number itself will not fit, so the row says only that
    // something is there. The tooltip still has the count.
    .when(count > 0 && entry.collapsed && !showsNumber, (row) =>
      row.child(
        div()
          .absolute()
          .top(tokens.space(4))
          .right(tokens.space(3))
          .size(tokens.space(5))
          .rounded_full()
          .bg(accent),
      ),
    );
}

/**
 * The account, at the foot of the rail. It is both the answer to "which mailbox
 * am I looking at" and the way into the rest of them — which is where a desktop
 * app puts its account controls, rather than behind an unlabelled glyph in the
 * top corner.
 *
 * The QML opens the other mailboxes as a popup off this bar. Here they stand
 * under it instead: one row per account, in the switcher's own shape, because
 * an account nobody can reach is a worse trade than a footer two rows tall.
 *
 * @param {RailAccount} account
 * @param {boolean} collapsed
 * @param {boolean} switcherOpen whether the card this bar opens is on screen
 * @param {RailHandler} onAccount
 * @param {import("gpui").Context} cx
 */
function accountRow(account, collapsed, switcherOpen, onAccount, cx) {
  const tokens = style();
  const fills = railFills(cx);
  // The address, not the name derived from it. This list exists to tell two
  // mailboxes apart, and two accounts can easily share a local part across
  // different domains.
  const address = String(account.email || account.label || account.id || "");
  // An initial rather than a picture: Gmail's own avatar is behind an API this
  // app does not ask permission for, and an address is always Latin script, so
  // one letter is safe here in a way a label name is not.
  const initial = address === "" ? "?" : address.charAt(0).toUpperCase();
  // Lit while the switcher it opens is on screen, and at no other time. Which
  // mailbox this is has already been answered by the address in the row; a
  // standing fill would be answering it twice, and a trigger that looks
  // untouched while its own card is up leaves the card unattached to anything.
  const current = switcherOpen === true;
  // Says why an account is not usable, rather than leaving it looking identical
  // to one that is — and otherwise only when the name says something the
  // address does not.
  const error = String(account.error || "");
  const detail =
    error !== ""
      ? error
      : account.signedIn === false
        ? "Signed out"
        : account.busy === true
          ? "Checking"
          : String(account.label || "") !== "" &&
              address.indexOf(String(account.label)) !== 0
            ? String(account.label)
            : "";

  return Button.new(`account-${account.id}`)
    .selected(account.selected)
    .accessibility_label(detail === "" ? address : `${address}, ${detail}`)
    .when(collapsed, (row) => row.tooltip(address || "Not connected"))
    .flex()
    .items_center()
    .w_full()
    .flex_none()
    .h(tokens.space(38))
    .gap(tokens.space(8))
    .when(collapsed, (row) => row.justify_center())
    .when(!collapsed, (row) => row.pl(tokens.space(8)).pr(tokens.space(8)))
    .rounded(tokens.cornerRadius)
    .bg(current ? fills.selected : fills.clear)
    .hover((appearance) => appearance.bg(fills.hover))
    .active((appearance) => appearance.bg(fills.pressed))
    .on_click((event, eventCx) => onAccount(account.id, event, eventCx))
    .child(
      div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(tokens.space(22))
        .rounded_full()
        .bg(fills.selected)
        .text_size(tokens.font.caption)
        .text_color(cx.theme().colors.foreground)
        .font_bold()
        .child(initial),
    )
    .when(!collapsed, (row) =>
      row.child(
        v_flex()
          .id(`account-${account.id}-lines`)
          .flex_1()
          .min_w_0()
          .gap(tokens.space(1))
          .child(
            div()
              .min_w_0()
              .truncate()
              .text_size(tokens.font.caption)
              .text_color(cx.theme().colors.muted_foreground)
              .child(address === "" ? "Not connected" : address),
          )
          .when(detail !== "", (lines) =>
            lines.child(
              div()
                .min_w_0()
                .truncate()
                .text_size(tokens.font.caption)
                .text_color(
                  error === ""
                    ? cx.theme().colors.muted_foreground
                    : cx.theme().colors.destructive,
                )
                .child(detail),
            ),
          ),
      ),
    );
}

/**
 * @param {{
 *   accounts: RailAccount[],
 *   mailboxes: RailMailbox[],
 *   labels?: RailLabel[],
 *   slots?: RailSlot[],
 *   numbersVisible?: boolean,
 *   sidebarCollapsed?: boolean,
 *   calendarSelected?: boolean,
 *   onAccount: RailHandler,
 *   onMailbox: RailHandler,
 *   onLabel?: (id:string,name:string,event:any,cx:import("gpui").Context)=>void,
 *   onCalendar?: (event:any,cx:import("gpui").Context)=>void,
 *   switcherOpen?: boolean,
 *   switcherCursor?: number,
 *   onSwitcherOpenChange?: (open:boolean,cx:import("gpui").Context)=>void,
 *   onAddAccount?: (event:any,cx:import("gpui").Context)=>void,
 *   onManageAccounts?: (event:any,cx:import("gpui").Context)=>void,
 * }} model
 * @param {import("gpui").Context} cx
 */
export function renderRail(model, cx) {
  const tokens = style();
  const collapsed = model.sidebarCollapsed === true;
  const numbersVisible = model.numbersVisible === true;
  const slots = model.slots ?? [];
  // The user's own labels only. A system label is a mailbox the provider
  // already named in the list above, and offering it twice under the server's
  // spelling for it is offering two doors into one room.
  const labels = (model.labels ?? []).filter((entry) => entry.system !== true);
  const width = tokens.space(
    collapsed ? MAIL_RAIL_COLLAPSED_WIDTH : MAIL_RAIL_WIDTH,
  );

  return (
    v_flex()
      .id("mail-rail")
      .flex_none()
      .w(width)
      .min_w(width)
      .min_h_0()
      // The rail's own edge. The list already draws one on its far side, so
      // without this the icons sit on the same surface as the messages.
      .border_r(tokens.spacing.hairline)
      .border_color(role("separator", cx.theme().colors.border))
      .child(
        v_flex()
          .id("mailbox-list")
          .flex_1()
          .min_h_0()
          .overflow_y_scroll()
          .p(tokens.space(6))
          .gap(tokens.space(1))
          .children(
            model.mailboxes.map((mailbox) =>
              railRow(
                `mailbox-${mailbox.id}`,
                {
                  // The account's own list, handed down already resolved: a
                  // provider with no All mail must not be offered one, and an
                  // IMAP account's Flagged is not Gmail's Starred.
                  icon: drawableIcon(mailbox.icon),
                  label: mailbox.label,
                  // No count on the mailboxes. An inbox that is thousands of
                  // messages deep reports "999+" forever, which is a number
                  // that never changes and therefore says nothing. The bar's
                  // dot carries whether anything is waiting; the labels below
                  // still count, because those are lists the user built and
                  // their sizes mean something.
                  count: 0,
                  selected: mailbox.selected && model.calendarSelected !== true,
                  slotNumber: slotNumberOf(slots, "mailbox", mailbox.id),
                  numbersVisible,
                  collapsed,
                },
                (event, eventCx) => model.onMailbox(mailbox.id, event, eventCx),
                cx,
              ),
            ),
          )
          .when(labels.length > 0, (column) =>
            column
              .child(
                v_flex()
                  .flex_none()
                  .h(tokens.space(12))
                  .justify_center()
                  .child(separator(cx)),
              )
              .when(!collapsed, (section) =>
                section.child(
                  sectionLabel("Labels", cx)
                    .pl(tokens.space(8))
                    .pb(tokens.space(3)),
                ),
              )
              .children(
                labels.map((entry) =>
                  railRow(
                    `label-${entry.id}`,
                    {
                      // One tag for every user label. An initial letter fails
                      // the moment a label is not written in the Latin alphabet
                      // — a Chinese label would put a single hanzi in a 16px
                      // slot, which is neither an icon nor a readable name. The
                      // tooltip carries the name instead.
                      icon: "label",
                      label: entry.name,
                      count: entry.unread ?? 0,
                      selected:
                        entry.selected === true &&
                        model.calendarSelected !== true,
                      slotNumber: slotNumberOf(slots, "label", entry.id),
                      numbersVisible,
                      collapsed,
                    },
                    (event, eventCx) =>
                      model.onLabel?.(entry.id, entry.name, event, eventCx),
                    cx,
                  ),
                ),
              ),
          ),
      )
      // The account lives at the foot of the rail, which is where a desktop app
      // keeps it.
      .child(
        v_flex()
          .id("mail-rail-footer")
          .flex_none()
          .when(typeof model.onCalendar === "function", (footer) =>
            footer
              .child(
                v_flex()
                  .px(tokens.space(6))
                  .child(
                    railRow(
                      "navigation-calendar",
                      {
                        icon: "calendar",
                        label: "Calendar",
                        count: 0,
                        selected: model.calendarSelected === true,
                        slotNumber: 0,
                        numbersVisible,
                        collapsed,
                      },
                      (event, eventCx) => model.onCalendar?.(event, eventCx),
                      cx,
                    ),
                  ),
              )
              .child(div().flex_none().h(tokens.space(6))),
          )
          .child(separator(cx))
          .child(
            v_flex()
              .id("mail-rail-accounts")
              .flex_none()
              // Only the mailbox in use. The rest are one click away in the
              // switcher this row opens; a permanent list of every account
              // would spend the foot of the sidebar on a question asked once a
              // day at most.
              .child(
                renderAccountSwitcher(
                  {
                    open: model.switcherOpen === true,
                    // Where the keyboard is standing in the card. `Alt+A` opens
                    // a list the keyboard then walks, so the card has to say
                    // which row `Enter` would take.
                    cursorIndex: model.switcherCursor,
                    accounts: model.accounts,
                    onOpenChange: model.onSwitcherOpenChange,
                    onAccount: model.onAccount,
                    onAdd: model.onAddAccount,
                    onManage: model.onManageAccounts,
                  },
                  accountRow(
                    model.accounts.find(
                      (/** @type {any} */ account) => account.selected,
                    ) ??
                      model.accounts[0] ?? {
                        id: "none",
                        label: "",
                        email: "",
                        provider: "",
                        selected: true,
                      },
                    collapsed,
                    model.switcherOpen === true,
                    () => {},
                    cx,
                  ),
                  cx,
                ),
              ),
          ),
      )
  );
}

/**
 * The mailboxes, as one row of chips — what the compact window gets in place of
 * the rail. What they are depends on the provider, so the account hands the
 * list down already resolved and this only draws it.
 *
 * @param {{
 *   mailboxes: RailMailbox[],
 *   unread?: number,
 *   width?: number,
 *   onMailbox: RailHandler,
 * }} model
 * @param {import("gpui").Context} cx
 */
export function renderMailboxTabs(model, cx) {
  const tokens = style();
  const fills = railFills(cx);
  const border = /** @type {`#${string}`} */ (
    alpha(cx.theme().colors.foreground, tokens.state.normalBorderAlpha)
  );

  // Scrolling a six-segment control in a narrow window is worse than not
  // offering two of the segments: All mail and Trash are places you go looking
  // for something, not places you work from, and search reaches both. The
  // mailbox in view is never dropped, however rarely it is used.
  //
  // Measured by character count rather than by a text engine, which is honest
  // on a monospace desktop and is the only measurement this window can make
  // before it is laid out.
  const chipWidth = (/** @type {string} */ caption) =>
    caption.length * Math.round(tokens.font.bodySmall * 0.6) +
    tokens.spacing.controlPaddingX * 2;
  const captionOf = (/** @type {RailMailbox} */ mailbox) =>
    mailbox.id === "unread" && (model.unread ?? 0) > 0
      ? `${mailbox.label} ${model.unread}`
      : mailbox.label;
  const full = model.mailboxes.reduce(
    (total, mailbox) => total + chipWidth(captionOf(mailbox)),
    0,
  );
  const available = Math.max(0, Number(model.width) || 0);
  const crowded = available > 0 && full > available;
  const shown = crowded
    ? model.mailboxes.filter(
        (mailbox) => mailbox.optional !== true || mailbox.selected,
      )
    : model.mailboxes;

  // One segmented control rather than loose chips. Separate chips left the
  // selected one's fill floating at a different left edge from the logo above
  // and the message text below; a single track has one edge, and that edge is
  // the one everything else lines up on.
  return h_flex()
    .id("mailbox-tabs")
    .role("tab_list")
    .flex_none()
    .items_center()
    .justify_center()
    .w_full()
    .min_w_0()
    .px(tokens.space(14))
    .pt(tokens.space(14))
    // The QML hangs the list column off this strip's bottom with a margin of
    // its own; stacked in a column there are no anchors to hang from, so the
    // gap belongs to the thing above it.
    .pb(tokens.space(8))
    .child(
      h_flex()
        .id("mailbox-tabs-track")
        .flex_none()
        .min_w_0()
        // Centred whenever the row has slack, and left-aligned the moment it
        // fills the width — at the sizes where it does span, its edge is the
        // one the logo above and the message text below line up on.
        .max_w_full()
        .overflow_x_scroll()
        .rounded(tokens.cornerRadius)
        .border(tokens.state.normalBorderWidth)
        .border_color(border)
        .children(
          shown.map((mailbox, index) =>
            Button.new(`mailbox-tab-${mailbox.id}`)
              .role("tab")
              .selected(mailbox.selected)
              .accessibility_label(mailbox.label)
              .flex()
              .items_center()
              .justify_center()
              .flex_none()
              .h(tokens.spacing.controlHeight)
              .px(tokens.spacing.controlPaddingX)
              .text_size(tokens.font.bodySmall)
              .text_color(cx.theme().colors.foreground)
              .bg(mailbox.selected ? fills.selected : fills.clear)
              // Segments share an edge instead of standing apart, so the row
              // reads as one control with a current position.
              .when(index > 0, (chip) =>
                chip
                  .border_l(tokens.state.normalBorderWidth)
                  .border_color(border),
              )
              .hover((appearance) => appearance.bg(fills.hover))
              .active((appearance) => appearance.bg(fills.pressed))
              .on_click((event, eventCx) =>
                model.onMailbox(mailbox.id, event, eventCx),
              )
              .child(captionOf(mailbox)),
          ),
        ),
    );
}
