// @ts-check

import { div, image } from "gpui";
import { Popup, Textarea, h_flex, v_flex } from "gpui-base";
import {
  ActionBar,
  Button,
  Label,
  MutedText,
  TextField,
  alpha,
  mix,
  resolveSurfaceColor,
  style,
} from "omarchy-ui";
import { actionIcon, iconTextButton } from "./controls.js";
import { formatCount, formatSize } from "../message/Message.js";
import { icon } from "./icons.js";

// Composing takes over the whole content area of the one window rather than
// opening a second one: Omarchy's panel mechanism would give an extra window
// its own region, which is not what a reply is.
//
// Compose, reply, reply-all and forward are the same form with different
// starting values, so the controller fills the fields and everything here is
// one code path. Nothing on this page decides anything — every state below is
// read off the compose snapshot the model carries.

/**
 * @typedef {object} ComposeIdentity
 * @property {string} accountId
 * @property {string} email
 * @property {string} subtitle
 */

/**
 * @typedef {object} ComposeContact
 * @property {string} name
 * @property {string} email
 */

/**
 * @typedef {object} ComposeAttachment
 * @property {string} filename
 * @property {number} size
 * @property {string} [mimeType]
 * @property {string} [path] where the chooser left it, for a picture's preview
 */

/**
 * @typedef {object} ComposeModel
 * @property {string} [title] what the band names this draft, with `onBack`
 * @property {string} from the address the draft is sent as
 * @property {Array<ComposeIdentity>} [identities]
 * @property {boolean} [canChooseFrom]
 * @property {boolean} [fromMenuOpen]
 * @property {import("gpui-base").InputState} to
 * @property {import("gpui-base").InputState} [cc]
 * @property {import("gpui-base").InputState} [bcc]
 * @property {import("gpui-base").InputState} subject
 * @property {import("gpui-base").TextareaState} body
 * @property {boolean} [ccVisible]
 * @property {boolean} [bccVisible]
 * @property {{field:string,contacts:Array<ComposeContact>,highlighted:number}} [suggestions]
 * @property {{originals:Array<ComposeAttachment>,files:Array<ComposeAttachment>,loading:boolean,error:string,kind?:"forward"|"draft"}} [forward] what the message this draft came from carries, and whose files those are
 * @property {{loading:boolean,error:string}} [quoting] the message being answered, while it is still being read
 * @property {Array<ComposeAttachment>} [attachments]
 * @property {boolean} [attaching]
 * @property {boolean} [sending]
 * @property {boolean} [sendPending] a send is queued, so this one waits its turn
 * @property {(event:any,cx:any)=>void} onSend
 * @property {(event:any,cx:any)=>void} onDiscard
 * @property {(event:any,cx:any)=>void} [onBack] draws the title band when given
 * @property {(event:any,cx:any)=>void} [onAttach]
 * @property {(index:number,event:any,cx:any)=>void} [onRemoveAttachment]
 * @property {(event:any,cx:any)=>void} [onShowCc]
 * @property {(event:any,cx:any)=>void} [onShowBcc]
 * @property {(event:any,cx:any)=>void} [onToggleFromMenu]
 * @property {(identity:ComposeIdentity,event:any,cx:any)=>void} [onChooseFrom]
 * @property {(contact:ComposeContact,event:any,cx:any)=>void} [onAcceptSuggestion]
 * @property {(event:any,cx:any)=>void} [onRetryForward]
 */

/**
 * What the toasts are drawn from. Deliberately not the compose model: the
 * window draws these when no compose page exists, so everything they need has
 * to be sayable without one.
 * @typedef {object} ComposeToastModel
 * @property {boolean} [sendPending] a send is queued and can still be taken back
 * @property {number} [undoSeconds] what the countdown reads, this beat
 * @property {string} [notice] the toast text, "" when there is none
 * @property {(event:any,cx:any)=>void} [onUndo]
 */

/**
 * Nothing painted. gpui's colour vocabulary is a theme token or a hex literal
 * and has no "transparent" keyword — passing one is not a type slip the runtime
 * forgives, it refuses to render the view at all.
 */
const clear = /** @type {import("gpui").Color} */ ("#00000000");

/** Secondary text mixes toward the ground; a third tone sits below it. */
const dimmer = (/** @type {import("gpui").Context} */ cx) =>
  mix(cx.theme().colors.foreground, cx.theme().colors.background, 0.55);

/**
 * A menu card's ground. The popup surface is its own role in `shell.toml` —
 * a menu is not the window background, and a theme may say so — and it may
 * carry transparency for floating shell panels. These sit over form rows, so
 * it is made opaque here.
 *
 * It comes from the style tokens rather than from `cx.theme()`: gpui's colour
 * set has no `popover`, and reading one gives `undefined`, which the runtime
 * refuses to paint.
 * @param {import("gpui").Context} cx
 */
const popupSurface = (cx) =>
  alpha(
    resolveSurfaceColor(
      style(),
      style().surfaces.popupBackground,
      cx.theme().colors.background,
    ),
    1,
  );

/** A control fill: the surrounding foreground at one of the theme's alphas. */
const stateFill = (
  /** @type {import("gpui").Context} */ cx,
  /** @type {number} */ value,
) => alpha(cx.theme().colors.foreground, value);

/**
 * A label column wide enough for the longest of To / Cc / Subject keeps the
 * inputs aligned without a grid.
 * @param {string} caption @param {import("gpui").Context} cx
 * @param {{align?:"start"}} [options]
 */
function fieldLabel(caption, cx, options = {}) {
  const tokens = style();
  return (
    div()
      .flex_none()
      // On a row whose control is a stack rather than a line, the caption sits
      // two below the stack's own top: the QML's `space(9)` against the
      // summary column's `space(7)`, inside a row padded by `space(7)`.
      .when(options.align === "start", (caption_) =>
        caption_.mt(tokens.space(2)),
      )
      .w(tokens.space(52))
      // Right-aligned, so the four captions end on the same edge the fields
      // begin at however long each word is.
      .text_right()
      .text_size(tokens.font.caption)
      .text_color(cx.theme().colors.muted_foreground)
      .child(caption)
  );
}

/**
 * The compact title over the form. Caption-sized and dim rather than a page
 * heading: it names the draft, and the draft itself is the page.
 * @param {string} value @param {import("gpui").Context} cx
 */
function bandTitle(value, cx) {
  return div()
    .id("compose-title")
    .text_size(style().font.caption)
    .font_bold()
    .text_color(cx.theme().colors.muted_foreground)
    .child(value);
}

/**
 * One row of the form. The control plus the same breathing room it carries
 * inside itself, so its border is not crowded against the rules above and
 * below — derived rather than fixed, because the field grows with the theme's
 * font scale and a fixed row would scale that growth a second time.
 * @param {string} id @param {string} caption @param {any} control
 * @param {import("gpui").Context} cx @param {{align?:"start"}} [options]
 */
function formRow(id, caption, control, cx, options = {}) {
  const tokens = style();
  return h_flex()
    .id(id)
    .flex_none()
    .w_full()
    .min_w_0()
    .gap(tokens.space(10))
    .pl(tokens.space(18))
    .pr(tokens.space(18))
    .py(tokens.space(7))
    .border_b(tokens.spacing.hairline)
    .border_color(cx.theme().colors.border)
    .when(options.align === "start", (row) => row.items_start())
    .when(options.align !== "start", (row) => row.items_center())
    .child(fieldLabel(caption, cx, options))
    .child(control);
}

/**
 * The address-completion menu, anchored under the field it is completing.
 * A `Popup` rather than a positioned sibling: the menu extends past the form
 * into the message body, and only a layer of its own crosses that boundary.
 * @param {string} id @param {any} trigger
 * @param {{contacts:Array<ComposeContact>,highlighted:number}} offered
 * @param {ComposeModel} model @param {import("gpui").Context} cx
 */
function suggestionPopup(id, trigger, offered, model, cx) {
  const tokens = style();
  const accept = model.onAcceptSuggestion;
  if (offered.contacts.length === 0 || typeof accept !== "function")
    return trigger;
  return Popup.new(id, trigger)
    .anchor("bottom_left")
    .flex_1()
    .min_w_0()
    .content(
      v_flex()
        .id(`${id}-list`)
        .role("list_box")
        // The kit's dropdown width, where the QML takes the field's own. A
        // `Popup` measures its trigger inside the host and hands a script
        // nothing, so there is no field width to read here — and a fixed one
        // that never matches the field is better than a guess that changes as
        // the window is resized.
        .w(tokens.spacing.dropdownWidth)
        .max_h(tokens.space(210))
        .overflow_y_scroll()
        .p(tokens.space(2))
        .rounded(tokens.cornerRadius)
        .border(tokens.state.normalBorderWidth)
        .border_color(cx.theme().colors.border)
        .bg(popupSurface(cx))
        .children(
          offered.contacts.map((contact, index) =>
            v_flex()
              .id(`${id}-${index}`)
              .role("list_box_option")
              .w_full()
              .min_w_0()
              .justify_center()
              .h(tokens.space(40))
              .px(tokens.space(9))
              .gap(tokens.space(1))
              .rounded(tokens.cornerRadius)
              .bg(
                index === offered.highlighted
                  ? stateFill(cx, tokens.state.selectedFillAlpha)
                  : clear,
              )
              .hover((appearance) =>
                appearance.bg(stateFill(cx, tokens.state.hoverFillAlpha)),
              )
              .on_click(
                (/** @type {any} */ event, /** @type {any} */ eventCx) =>
                  accept(contact, event, eventCx),
              )
              .child(
                div()
                  .w_full()
                  .truncate()
                  .text_size(tokens.font.bodySmall)
                  .text_color(cx.theme().colors.foreground)
                  .child(contact.name || contact.email),
              )
              .when(Boolean(contact.name), (row) =>
                row.child(
                  div()
                    .w_full()
                    .text_ellipsis_middle()
                    .text_size(tokens.font.caption)
                    .text_color(cx.theme().colors.muted_foreground)
                    .child(contact.email),
                ),
              ),
          ),
        ),
    );
}

/**
 * The From row. The trigger is sized to the address rather than to the row: a
 * full-width one puts the chevron a screen away from the name it belongs to.
 * @param {ComposeModel} model @param {import("gpui").Context} cx
 */
function fromRow(model, cx) {
  const tokens = style();
  const identities = model.identities ?? [];
  const chosen = model.from.toLowerCase();
  const trigger = new Button("compose-from-button")
    .label(model.from || "No sending account")
    .bordered()
    .disabled(!model.canChooseFrom)
    .selected(Boolean(model.fromMenuOpen))
    .size("small")
    .onClick(model.onToggleFromMenu ?? (() => {}))
    .build(cx)
    // Grows to the address and no further, and gives way rather than pushing
    // the row wider when the address is a long one. That is the QML's
    // `min(implicitWidth + trailing, parent.width - label - space(46))`: a
    // shrinkable box with no growth is the same clamp without a measurement.
    .flex_grow_0()
    .flex_shrink_1()
    .min_w_0()
    .justify_start()
    .py(tokens.spacing.inputPaddingY)
    // The chevron follows the address rather than leading it — the kit's own
    // is a font glyph, which at this size renders thinner than every other
    // mark in the window, so this is the app's drawn set at the size the rest
    // of the icons use. `button`'s own `iconName` puts a glyph *before* the
    // caption, which is the wrong end of a picker.
    .when(Boolean(model.canChooseFrom), (control) =>
      control.child(
        icon("chevronDown", cx, {
          size: tokens.font.iconSmall,
          color: cx.theme().colors.muted_foreground,
        }),
      ),
    );
  const choose = model.onChooseFrom;
  const control =
    model.fromMenuOpen && typeof choose === "function"
      ? Popup.new("compose-from-menu", trigger)
          .anchor("bottom_left")
          .flex_none()
          .content(
            v_flex()
              .id("compose-from-menu-list")
              .role("menu")
              .w(tokens.space(360))
              .max_h(tokens.space(260))
              .overflow_y_scroll()
              .p(tokens.space(4))
              .rounded(tokens.cornerRadius)
              .border(tokens.state.normalBorderWidth)
              .border_color(cx.theme().colors.border)
              .bg(popupSurface(cx))
              .children(
                identities.map((identity) => {
                  const selected = identity.email.toLowerCase() === chosen;
                  return v_flex()
                    .id(`compose-from-${identity.email}`)
                    .role("menu_item")
                    .w_full()
                    .min_w_0()
                    .justify_center()
                    .h(tokens.space(42))
                    .px(tokens.space(9))
                    .gap(tokens.space(1))
                    .rounded(tokens.cornerRadius)
                    .bg(
                      selected
                        ? stateFill(cx, tokens.state.selectedFillAlpha)
                        : clear,
                    )
                    .hover((appearance) =>
                      appearance.bg(stateFill(cx, tokens.state.hoverFillAlpha)),
                    )
                    .on_click(
                      (/** @type {any} */ event, /** @type {any} */ eventCx) =>
                        choose(identity, event, eventCx),
                    )
                    .child(
                      div()
                        .w_full()
                        .text_ellipsis_middle()
                        .text_size(tokens.font.bodySmall)
                        .text_color(cx.theme().colors.foreground)
                        .when(selected, (line) => line.font_bold())
                        .child(identity.email),
                    )
                    .when(Boolean(identity.subtitle), (row) =>
                      row.child(
                        div()
                          .w_full()
                          .truncate()
                          .text_size(tokens.font.caption)
                          .text_color(cx.theme().colors.muted_foreground)
                          .child(identity.subtitle),
                      ),
                    );
                }),
              ),
          )
      : trigger;
  return formRow(
    "compose-from-row",
    "From",
    h_flex().flex_1().min_w_0().items_center().child(control),
    cx,
  );
}

/**
 * An address row: the field, its completion menu, and — on To — the two
 * disclosures for the copy rows.
 * @param {"to"|"cc"|"bcc"} name @param {string} caption
 * @param {ComposeModel} model @param {import("gpui").Context} cx
 */
function addressRow(name, caption, model, cx) {
  const tokens = style();
  const state = model[name];
  const offered = model.suggestions;
  const control = state
    ? new TextField()
        .state(state)
        .build(cx)
        .id(`compose-${name}-field`)
        .accessibility_label(caption)
        .text_size(tokens.font.bodySmall)
    : new MutedText("Not set").build(cx).id(`compose-${name}-field`).flex_1();
  const withPopup =
    offered && offered.field === name
      ? suggestionPopup(
          `compose-${name}-suggestions`,
          control,
          offered,
          model,
          cx,
        )
      : control;
  const row = h_flex()
    .flex_1()
    .min_w_0()
    .items_center()
    .gap(tokens.space(8))
    .child(withPopup);
  if (name !== "to") return formRow(`compose-${name}-row`, caption, row, cx);
  // The two disclosures carry their state in the colour rather than in a fill:
  // they sit outside the field's box, and a chrome of their own out there
  // reads as two more controls beside the address. They are toggles, not
  // one-way reveals — `ComposeView.qml` flips `ccVisible` either way.
  //
  // Their own `Row` at `Style.space(4)`, inside the row's `Style.space(8)`:
  // the pair reads as one control with two halves rather than as two more
  // things spaced like the field beside them.
  const toggle = (
    /** @type {string} */ id,
    /** @type {string} */ label,
    /** @type {boolean} */ on,
    /** @type {(event:any,cx:any)=>void} */ press,
  ) =>
    new Button(id)
      .label(label)
      .tone(
        on ? cx.theme().colors.foreground : cx.theme().colors.muted_foreground,
      )
      .size("xsmall")
      .onClick(press)
      .build(cx)
      .flex_none();
  return formRow(
    "compose-to-row",
    caption,
    row.child(
      h_flex()
        .id("compose-copy-toggles")
        .flex_none()
        .items_center()
        .gap(tokens.space(4))
        .when(typeof model.onShowCc === "function", (line) =>
          line.child(
            toggle(
              "compose-cc-toggle",
              "Cc",
              Boolean(model.ccVisible),
              model.onShowCc ?? (() => {}),
            ),
          ),
        )
        .when(typeof model.onShowBcc === "function", (line) =>
          line.child(
            toggle(
              "compose-bcc-toggle",
              "Bcc",
              Boolean(model.bccVisible),
              model.onShowBcc ?? (() => {}),
            ),
          ),
        ),
    ),
    cx,
  );
}

/**
 * What a forward carries from the original. The files are read before the
 * draft may leave, so this row is also where a failed read is answered. Drawn
 * only where there is something to name; the page above decides that.
 * @param {ComposeModel} model @param {import("gpui").Context} cx
 */
function forwardRow(model, cx) {
  const tokens = style();
  const forward = model.forward ?? {
    originals: [],
    files: [],
    loading: false,
    error: "",
  };
  // A forward's files belong to the message being forwarded; a reopened
  // draft's belong to the draft. The wait and the Retry are the same, and
  // saying "will be forwarded" over a draft nobody is forwarding is not.
  const saved = forward.kind === "draft";
  const summary = forward.loading
    ? saved
      ? "Loading the files saved with this draft..."
      : "Loading original attachments..."
    : forward.error ||
      (saved
        ? `${formatCount(forward.files.length, "saved file")} will be sent`
        : `${formatCount(forward.files.length, "original attachment")} will be forwarded`);
  return formRow(
    "compose-forward-row",
    "Files",
    h_flex()
      .flex_1()
      .min_w_0()
      .items_start()
      .gap(tokens.space(8))
      .child(
        v_flex()
          .flex_1()
          .min_w_0()
          .gap(tokens.space(3))
          .child(
            div()
              .w_full()
              .text_size(tokens.font.bodySmall)
              .text_color(
                forward.error
                  ? cx.theme().colors.primary
                  : cx.theme().colors.foreground,
              )
              .child(summary),
          )
          .children(
            forward.originals.map((file, index) =>
              div()
                .id(`compose-forward-file-${index}`)
                .w_full()
                .text_ellipsis_middle()
                .text_size(tokens.font.caption)
                .text_color(cx.theme().colors.muted_foreground)
                .child(
                  `${file.filename || "attachment"}  ${formatSize(file.size)}`,
                ),
            ),
          ),
      )
      .when(
        Boolean(forward.error) && typeof model.onRetryForward === "function",
        (row) =>
          row.child(
            new Button("compose-forward-retry")
              .label("Retry")
              .size("xsmall")
              .onClick(model.onRetryForward ?? (() => {}))
              .build(cx)
              .flex_none(),
          ),
      ),
    cx,
    { align: "start" },
  );
}

/**
 * Whether a file is worth drawing rather than naming. Both halves matter: a
 * picture the chooser reported without a path is one this window cannot read,
 * and a preview slot left open for it is a hole in the strip.
 * @param {ComposeAttachment} file
 */
const isPreviewable = (file) =>
  String(file.mimeType || "").startsWith("image/") &&
  String(file.path || "") !== "";

/**
 * The files this draft carries. Drawn only where there is one; the page above
 * decides that.
 * @param {ComposeModel} model @param {import("gpui").Context} cx
 */
function attachmentStrip(model, cx) {
  const tokens = style();
  const attachments = model.attachments ?? [];
  const remove = model.onRemoveAttachment;
  return v_flex()
    .id("compose-attachments")
    .flex_none()
    .min_w_0()
    .max_h(tokens.space(240))
    .overflow_y_scroll()
    .gap(tokens.space(8))
    .px(tokens.space(18))
    .pt(tokens.space(4))
    .pb(tokens.space(8))
    .children(
      attachments.map((file, index) =>
        v_flex()
          .id(`compose-attachment-${index}`)
          .w_full()
          .min_w_0()
          .flex_none()
          .gap(tokens.space(4))
          // A picture is what the file is; its name is only what it is called.
          // `ComposeView.qml` draws the preview above the name for exactly the
          // files a preview says something about, and leaves the row alone for
          // the rest.
          .when(isPreviewable(file), (item) =>
            item.child(
              image(String(file.path || ""))
                .w_full()
                .flex_none()
                .min_h(tokens.space(72))
                .max_h(tokens.space(200)),
            ),
          )
          .child(
            h_flex()
              .w_full()
              .min_w_0()
              .items_center()
              .gap(tokens.space(6))
              .child(
                icon("attachment", cx, {
                  size: tokens.font.iconSmall,
                  color: cx.theme().colors.muted_foreground,
                }),
              )
              .child(
                div()
                  .flex_1()
                  .min_w_0()
                  .text_ellipsis_middle()
                  .text_size(tokens.font.caption)
                  .text_color(cx.theme().colors.foreground)
                  .child(file.filename || "attachment"),
              )
              .child(
                div()
                  .flex_none()
                  .text_size(tokens.font.caption)
                  .text_color(dimmer(cx))
                  .child(formatSize(file.size)),
              )
              .when(typeof remove === "function", (row) =>
                row.child(
                  // The small step rather than the kit's default, which beside
                  // a caption-sized filename reads as the loudest thing on the
                  // row — and quiet, so the × waits until the row is pointed
                  // at.
                  actionIcon(
                    `compose-attachment-remove-${index}`,
                    "close",
                    "Remove",
                  )
                    .quiet()
                    .size("small")
                    .onClick(
                      (/** @type {any} */ event, /** @type {any} */ eventCx) =>
                        remove?.(index, event, eventCx),
                    )
                    .build(cx),
                ),
              ),
          ),
      ),
    );
}

/**
 * A floating notice above the status bar. Both toasts are the same card, so
 * the one that replaces the other lands in the same place.
 *
 * Drawn at the window root, which is where `App.qml` puts both of them: it
 * anchors them to `statusBar.top`, so from the bottom of the window they clear
 * the status bar's own `Style.space(28)` and then the same twelve. Written as
 * the two measurements rather than as their sum, because that is the pair the
 * QML has and either can move on its own.
 * @param {string} id @param {any} content @param {import("gpui").Context} cx
 */
function toast(id, content, cx) {
  const tokens = style();
  return (
    h_flex()
      .id(id)
      .role("status")
      .absolute()
      .right(tokens.space(16))
      .bottom(tokens.space(28) + tokens.space(12))
      .items_center()
      .justify_center()
      .min_h(tokens.space(42))
      .px(tokens.space(10))
      .gap(tokens.space(12))
      .rounded(tokens.cornerRadius)
      .border(tokens.state.normalBorderWidth)
      .border_color(cx.theme().colors.border)
      // Opaque: a card floating over the form must not let the rows read through
      // it, whatever transparency the theme gives its shell panels.
      .bg(popupSurface(cx))
      .child(content)
  );
}

/** @param {ComposeModel} model @param {import("gpui").Context} cx */
export function renderCompose(model, cx) {
  const tokens = style();
  const forward = model.forward;
  // A forward whose files are still arriving would go out without them, and
  // one whose read failed would go out claiming to carry them. A reply whose
  // original has not arrived is the same objection a step earlier: it would go
  // out quoting nothing and threaded against no message. The status line says
  // which of the two is being waited for.
  const blocked =
    Boolean(forward?.loading) ||
    Boolean(forward?.error) ||
    Boolean(model.quoting?.loading);
  const sendDisabled =
    Boolean(model.sending) || Boolean(model.sendPending) || blocked;
  const attachHandler = model.onAttach;
  const commands = h_flex()
    .items_center()
    .gap(tokens.space(10))
    .child(
      iconTextButton("compose-send", "send", model.sending ? "Sending" : "Send")
        .disabled(sendDisabled)
        .tooltip("Send · Ctrl+Enter")
        .onClick(model.onSend)
        .build(cx),
    )
    .when(typeof attachHandler === "function", (bar) =>
      bar.child(
        iconTextButton(
          "compose-attach",
          "attachment",
          model.attaching ? "Attaching" : "Attach...",
        )
          .disabled(Boolean(model.attaching))
          .tooltip("Attach files...")
          .onClick((/** @type {any} */ event, /** @type {any} */ eventCx) =>
            attachHandler?.(event, eventCx),
          )
          .build(cx),
      ),
    )
    // Discard is borderless and in the dim colour. It is the destructive
    // choice on this bar, and a bordered one beside Send would read as the
    // other half of a pair of equals.
    //
    // Send, Attach, Discard, and nothing else. There is no Save draft: the
    // QML has none because leaving the composer saves the draft on the way
    // out, and a button for what already happens is a button that teaches the
    // wrong thing about when a draft is safe.
    .child(
      new Button("compose-discard")
        .label("Discard")
        .disabled(Boolean(model.sending))
        .tone(cx.theme().colors.muted_foreground)
        .size("small")
        .onClick(model.onDiscard)
        .build(cx),
    );

  return (
    v_flex()
      .id("compose")
      .relative()
      .size_full()
      .min_w_0()
      .min_h_0()
      .bg(cx.theme().colors.background)
      // One compact title band. Back is the exit path and the title names the
      // draft; splitting them into two stacked bands gave one short decision the
      // hierarchy of a whole settings page.
      .when(typeof model.onBack === "function", (page) =>
        page.child(
          h_flex()
            .id("compose-title-bar")
            .relative()
            .flex_none()
            .items_center()
            .h(tokens.space(44))
            .px(tokens.space(14))
            .border_b(tokens.spacing.hairline)
            .border_color(cx.theme().colors.border)
            .child(
              iconTextButton("compose-back", "back", "Back")
                .tooltip("Back · Esc")
                // `BackBar.qml` gives the whole control the dim tone, glyph
                // included. A `text_color` on the element cannot reach the
                // glyph, which paints itself in the button's own foreground —
                // which is what a tone is for.
                .tone(cx.theme().colors.muted_foreground)
                .onClick(model.onBack ?? (() => {}))
                .build(cx)
                .flex_none(),
            )
            // Centred on the band, not between the two controls beside it.
            // `ComposeView.qml` anchors the title to the band's own horizontal
            // centre, so it stays put whatever the Back control's label costs;
            // a flex row with a balancing spacer only lands there while the two
            // sides happen to weigh the same.
            .child(
              div()
                .id("compose-title-slot")
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .child(bandTitle(model.title ?? "New message", cx)),
            ),
        ),
      )
      .child(
        v_flex()
          .id("compose-fields")
          .flex_none()
          .min_w_0()
          .child(fromRow(model, cx))
          .child(addressRow("to", "To", model, cx))
          .when(Boolean(model.ccVisible), (fields) =>
            fields.child(addressRow("cc", "Cc", model, cx)),
          )
          .when(Boolean(model.bccVisible), (fields) =>
            fields.child(addressRow("bcc", "Bcc", model, cx)),
          )
          .child(
            formRow(
              "compose-subject-row",
              "Subject",
              new TextField()
                .state(model.subject)
                .build(cx)
                .id("compose-subject-field")
                .accessibility_label("Subject")
                .text_size(tokens.font.bodySmall),
              cx,
            ),
          )
          // A forward names what it carries, and so does a draft reopened
          // with files saved on it; every other draft has nothing to say here
          // and gives the row back to the body.
          .when((model.forward?.originals.length ?? 0) > 0, (fields) =>
            fields.child(forwardRow(model, cx)),
          ),
      )
      // The kit has no multi-line field, so this is a plain editor on the window
      // ground; the rows above already carry the structure.
      .child(
        v_flex()
          .id("compose-body")
          .flex_1()
          .min_w_0()
          .min_h_0()
          .px(tokens.space(18))
          .pt(tokens.space(12))
          .child(
            Textarea.new(model.body)
              .id("compose-body-editor")
              .accessibility_label("Message")
              .flex_1()
              .min_h_0()
              .border(0)
              .bg(clear)
              .text_size(tokens.font.bodySmall)
              .text_color(cx.theme().colors.foreground),
          ),
      )
      // Absent until there is a file, so an ordinary message gives the whole
      // area below the body to the action bar.
      .when((model.attachments?.length ?? 0) > 0, (page) =>
        page.child(attachmentStrip(model, cx)),
      )
      // The band the QML gives the three commands: a rule across the top and
      // `Style.space(52)` of room, which is the control height with the air the
      // form rows above it carry. Nothing sits on its right — a draft's status
      // is the window's status line and the saved-draft toast, and a third copy
      // of it here would be the same sentence in three places.
      .child(
        new ActionBar("compose-action-bar")
          .actions(commands)
          .build(cx)
          .h(tokens.space(52)),
      )
  );
}

/**
 * The two toasts a send puts up, drawn over whatever screen is on.
 *
 * They are not part of the compose page and cannot be: a queued send has left
 * the composer, the window has gone back to the list, and a card drawn inside a
 * page that is no longer rendered is a card nobody sees. `App.qml` has both of
 * these as children of the window root, above every view and below nothing, for
 * exactly this reason.
 *
 * Returns null where there is nothing to say, so the window can leave the layer
 * out rather than stack an empty one over the screen.
 * @param {ComposeToastModel} model @param {import("gpui").Context} cx
 */
export function composeToasts(model, cx) {
  const tokens = style();
  const undoing =
    Boolean(model.sendPending) && typeof model.onUndo === "function";
  if (!undoing && !model.notice) return null;
  // The undo card wins the spot while it is up. Both land in the same place, so
  // showing them together would show one of them through the other.
  if (undoing)
    return toast(
      "compose-undo-toast",
      h_flex()
        .items_center()
        .gap(tokens.space(12))
        .child(
          div()
            .id("compose-undo-message")
            .text_size(tokens.font.bodySmall)
            .text_color(cx.theme().colors.foreground)
            // The undo window *is* the send: while it is open nothing has left,
            // and the countdown is the only thing that says how long that stays
            // true. It counts because the window beats a clock at it.
            .child(`Sending in ${model.undoSeconds ?? 0}s`),
        )
        .child(
          new Button("compose-undo-button")
            .label("Undo  Alt+Z")
            .bordered()
            .size("small")
            .onClick(model.onUndo ?? (() => {}))
            .build(cx)
            .text_color(cx.theme().colors.primary),
        ),
      cx,
    );
  return toast(
    "compose-notice-toast",
    h_flex()
      .items_center()
      .gap(tokens.space(8))
      .child(
        div()
          .flex_none()
          .size(tokens.space(7))
          .rounded_full()
          .bg(cx.theme().colors.primary),
      )
      .child(
        new Label(model.notice ?? "")
          .build(cx)
          .text_size(tokens.font.bodySmall),
      ),
    cx,
  );
}
