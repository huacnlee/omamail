// @ts-check

// The right column, ported from `components/MessageReader.qml`.
//
// The QML reader handed the message to Qt's rich text engine after
// `Html.sanitize` removed unsafe markup and remote tracking images. The GPUI
// reader preserves that sanitized HTML through the native `mail-body` host
// component, which owns its TextView and link routing.
//
// Everything else the QML drew is here: the header block, the notices that say
// why a message does not look the way it was written, the invitation card, the
// attachment rows, and the toolbar split between what you do to a message and
// how you look at it.

import { div } from "gpui";
import { host_component } from "gpui-shell";
import { Textarea, h_flex, v_flex } from "gpui-base";
import * as Html from "../message/Html.js";
import * as Mail from "../message/Message.js";
import { Button, role, style } from "omarchy-ui";
import { actionIcon, iconTextButton } from "./controls.js";
import { icon } from "./icons.js";
import { readingHtmlOf } from "./reader-document.js";
import {
  dimColor,
  dimmerColor,
  readerBlankSlate,
  readerNotice,
  readerSkeleton,
} from "./reader-chrome.js";
import { inviteCard } from "./reader-invite.js";

/**
 * Build a GPUI-safe reading model. No sender markup or URL survives this seam.
 * @param {unknown} source
 */
export function prepareReadingPresentation(source) {
  const ready = Html.sanitize(String(source ?? ""), {
    withReader: true,
    withPlainText: true,
    allowRemoteImages: false,
  });
  if (ready.reader?.tooHeavy)
    return {
      mode: "reading",
      html: "",
      blockedImages: Number(ready.reader.blockedImages ?? 0),
      remoteImagesBlocked:
        Number(ready.remoteImages ?? 0) > 0 ||
        Number(ready.reader.blockedImages ?? 0) > 0,
      complexity: ready.reader.complexity,
      tooHeavy: true,
      refused: true,
      empty: false,
      formattedAvailable: false,
    };
  const { html, overflow } = readingHtmlOf(ready.reader?.document);
  const fallback = Html.readableText(ready.plainText?.text ?? "");
  const shown = !overflow && html === "" && fallback
    ? `<p>${Html.escapeMarkup(fallback).replace(/\n/g, "<br>")}</p>`
    : html;
  return {
    mode: "reading",
    html: shown,
    blockedImages: Number(
      ready.reader?.blockedImages ?? ready.blockedImages ?? 0,
    ),
    remoteImagesBlocked:
      Number(ready.remoteImages ?? 0) > 0 ||
      Number(ready.reader?.blockedImages ?? 0) > 0,
    complexity: ready.reader?.complexity ?? ready.complexity,
    tooHeavy: Boolean(ready.reader?.tooHeavy),
    refused: overflow,
    empty: shown === "",
    formattedAvailable: false,
  };
}

// ------------------------------------------------------------------ headers

/**
 * One address as the header shows it. Two spaces between the name and the
 * angle brackets: in a monospace face one space reads as part of the name.
 * @param {any} value
 */
function addressText(value) {
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (!value || typeof value !== "object") return "";
  const name = String(value.display ?? value.name ?? "").trim();
  const email = String(value.email ?? "").trim();
  return name && email ? `${name}  <${email}>` : name || email;
}

/** @param {any} message */
function recipientLine(message) {
  const list = Array.isArray(message.to) ? message.to : [];
  const people = Mail.formatAddressList(
    list.map((/** @type {any} */ entry) =>
      typeof entry === "string" ? { display: entry } : entry,
    ),
    3,
  );
  const when = String(message.fullTime ?? message.time ?? message.date ?? "");
  if (people && when) return `to ${people} · ${when}`;
  return people ? `to ${people}` : when;
}

/** @param {any} model @param {import("gpui").Context} cx */
function readerHeader(model, cx) {
  const tokens = style();
  const message = model.message;
  const starred = message.starred === true;
  // A way back only means something when something is behind it. At desktop
  // width the list is on screen and clicking another row is the navigation, so
  // the host says which of the two this is by supplying the callback — and can
  // say otherwise with `showBack: false`.
  const showBack =
    model.showBack !== false && typeof model.onBack === "function";
  return v_flex()
    .id("reader-message-header")
    .flex_none()
    .w_full()
    .px(tokens.space(14))
    .pt(tokens.space(14))
    .gap(tokens.space(14))
    .when(showBack, (header) =>
      header.child(
        h_flex().child(
          // Outlined rather than flat: an outline makes the box itself the
          // aligned edge, so both the glyph and the hover fill sit on the same
          // line as everything under them.
          iconTextButton("reader-back", "back", "Back")
            .tooltip("Back · Esc")
            .tone(dimColor(cx))
            .onClick((event, eventCx) => model.onBack(event, eventCx))
            .build(cx)
            .flex_none(),
        ),
      ),
    )
    .child(
      h_flex()
        .w_full()
        .items_start()
        .gap(tokens.space(8))
        .child(
          v_flex()
            .flex_1()
            .min_w_0()
            .gap(tokens.space(4))
            .child(
              // A stranger wrote this, so it is drawn as text and never as
              // markup — the same rule the body obeys.
              div()
                .id("reader-message-subject")
                .w_full()
                .text_size(tokens.font.subtitle)
                .font_bold()
                .text_color(cx.theme().colors.foreground)
                .child(
                  typeof message.subject === "string" ||
                    typeof message.subject === "number"
                    ? String(message.subject)
                    : "",
                ),
            )
            .child(
              div()
                .id("reader-message-sender")
                .w_full()
                .truncate()
                .text_size(tokens.font.bodySmall)
                .text_color(cx.theme().colors.foreground)
                .child(addressText(message.sender ?? message.from)),
            )
            .child(
              div()
                .id("reader-message-meta")
                .w_full()
                .truncate()
                .text_size(tokens.font.caption)
                .text_color(dimColor(cx))
                .child(recipientLine(message)),
            ),
        )
        .when(
          model.capabilities?.star !== false &&
            typeof model.onStar === "function",
          (row) =>
            row.child(
              // `hoverColor: root.accentColor`, not the foreground the other
              // icons lift to: this one is about to become accent. So the
              // accent is its tone, and quiet is what holds the tone back
              // until the star is set.
              actionIcon(
                "reader-action-star",
                // gpui paints an SVG as one mask in the element's text colour,
                // so "filled" is a different file rather than a different paint.
                starred ? "star-filled" : "star",
                `${starred ? "Unstar" : "Star"} · s`,
              )
                .tone(cx.theme().colors.ring)
                .quiet(!starred)
                .onClick((event, eventCx) => model.onStar(event, eventCx))
                .build(cx),
            ),
        ),
    );
}

// ------------------------------------------------------------------ notices

/**
 * Why this message does not look the way its sender meant it to, and the one
 * thing that would change that. A column rather than a chain of conditions on
 * each other: several of these can be up at once, and each one knowing which of
 * the others is showing is a rule that has to be rewritten every time another
 * is added.
 * @param {any} model @param {import("gpui").Context} cx
 */
function readerNotices(model, cx) {
  const tokens = style();
  const presentation = model.presentation;
  const attachments = Array.isArray(model.message.attachments)
    ? model.message.attachments
    : [];
  const tooHeavy = Boolean(model.tooHeavy ?? presentation?.tooHeavy);
  const readingEmpty = model.readingEmpty === true;
  // A message with nothing in it is a real answer, and an empty reader on its
  // own does not look like one — it looks like something failed. Only once
  // nothing more is coming: "no text" is not true while a body is still on the
  // way.
  const noText =
    Boolean(presentation) &&
    presentation.empty === true &&
    !tooHeavy &&
    attachments.length === 0 &&
    !model.message.invite;
  const remoteImages = Math.max(
    0,
    Number(model.remoteImages ?? presentation?.blockedImages ?? 0),
  );
  const blocked =
    model.remoteImagesAllowed !== true &&
    remoteImages > 0 &&
    !tooHeavy &&
    presentation?.remoteImagesBlocked !== false;
  const unsubscribe = model.unsubscribe;

  /** @type {any[]} */
  const notices = [];
  // Two refusals wear this notice. One is Qt's own layout cost, which the
  // reader can be told to spend anyway; the other is this port's block cap,
  // where the reading was never built — so there is nothing for "Show anyway"
  // to show, and offering it would be a button that empties the pane.
  const refused = model.refused === true || presentation?.refused === true;
  if (tooHeavy)
    notices.push(
      readerNotice(
        "reader-notice-too-heavy",
        refused
          ? {
              text: "Showing the plain text: this message has more parts than the reader can lay out",
            }
          : {
              text: "Showing the plain text: this message is heavy enough to stall the shell",
              actionLabel: "Show anyway",
              onActivate: model.onShowAnyway,
            },
        cx,
      ),
    );
  if (readingEmpty)
    notices.push(
      readerNotice(
        "reader-notice-reading-empty",
        {
          text: "Showing the sender's own formatting: there was nothing here to rebuild",
        },
        cx,
      ),
    );
  if (noText)
    notices.push(
      readerNotice(
        "reader-notice-no-text",
        {
          text: "This message has no text to show",
          // Only where there is somewhere to go and read it, and the "..." is
          // there because what it opens is a browser.
          actionLabel: "Open on the web...",
          onActivate: model.onOpenWeb,
        },
        cx,
      ),
    );
  if (blocked)
    notices.push(
      readerNotice(
        "reader-remote-images-blocked",
        {
          text: `${remoteImages === 1 ? "1 image is" : `${remoteImages} images are`} blocked: loading them tells the sender this message was opened`,
          // What the button does is turn them on for every message, and
          // Settings is where that is turned back off — so it says "always"
          // rather than letting somebody find out afterwards.
          actionLabel: "Always show",
          onActivate: model.onShowImages,
        },
        cx,
      ),
    );
  if (unsubscribe?.detail)
    notices.push(
      readerNotice(
        "reader-notice-unsubscribe",
        {
          text: String(unsubscribe.detail),
          // Stays up after the deed is done, saying what was done: a control
          // that vanishes under the pointer reads as a misclick.
          actionLabel: String(unsubscribe.label ?? ""),
          busy: unsubscribe.busy === true,
          busyLabel: "Unsubscribing...",
          onActivate: model.onUnsubscribe,
        },
        cx,
      ),
    );

  if (notices.length === 0) return null;
  // No gap where there is nothing to separate: an empty column is zero high,
  // but the margin above it would still push the message down.
  return v_flex()
    .id("reader-notices")
    .flex_none()
    .w_full()
    .px(tokens.space(14))
    .pt(tokens.space(8))
    .gap(tokens.space(6))
    .children(notices);
}

// --------------------------------------------------------------------- body

/**
 * The size the message itself is read at, which the chrome around it does not
 * follow. Body text where the chrome is bodySmall: this is the one long-form
 * thing in the window and the only one that is read rather than scanned.
 * @param {unknown} zoom
 */
function bodyFontSize(zoom) {
  const wanted = Number(zoom);
  return Math.max(
    7,
    Math.round(style().font.body * (Number.isFinite(wanted) ? wanted : 1)),
  );
}

/**
 * Sixty-five to seventy-five characters, which is as far as the eye travels and
 * still finds the start of the next line.
 *
 * The QML measured a sentence with Qt's `TextMetrics`, because a monospace face
 * and a proportional one disagree about that by half. gpui hands a render no
 * way to measure text, so this is the one ratio a monospace face makes safe —
 * and the family here is the desktop's own, which `omarchy font set` keeps
 * monospace.
 * @param {number} fontSize
 */
function readingMeasure(fontSize) {
  return Math.ceil(fontSize * 0.6 * 70);
}

/** @param {any} model @param {import("gpui").Context} cx */
function readerBody(model, cx) {
  const tokens = style();
  const base = bodyFontSize(model.zoom);
  const presentation = model.presentation;
  const html = presentation?.html ?? `<p>${Html.escapeMarkup(String(model.message.body ?? ""))}</p>`;
  // Reading mode centres its column in whatever the panel has spare. The other
  // two start at the page inset, because the sender's own layout and a
  // plain-text body both begin at the left edge — and a body handed over as
  // text with no presentation around it is one of those.
  const shown = String(presentation?.mode ?? "plain");
  const reading = shown === "reader" || shown === "reading";
  // The selecting mode. Everything around the body — the invitation card, the
  // page inset, the zoom gesture — is the same; only what carries the words
  // changes, because the point of the mode is the words and not a second layout
  // of the panel. `application/reader-selection.js` says why it exists and what
  // it costs.
  const selecting = model.selecting === true && Boolean(model.selection);

  const column = v_flex()
    .id("reader-message-column")
    .w_full()
    .when(reading, (body) => body.max_w(readingMeasure(base)))
    .child(
      host_component("mail-body", { html, zoom: Number(model.zoom ?? 1) })
        .id("reader-mail-body")
        .on("link", (url, eventCx) => {
          const image = Html.imageLinkIndex(url);
          if (image > 0) {
            model.onOpenImage?.(image - 1, eventCx);
            return;
          }
          eventCx.open_url(String(url));
        })
        .w_full(),
    );

  return (
    v_flex()
      .id("reader-message-body")
      .flex_1()
      .min_w_0()
      .min_h_0()
      // The panel scrolls the blocks, and the surface scrolls itself: a textarea
      // is its own scroller, and one inside another gives every wheel event two
      // plausible targets — the reason the message list is a `Column` and not a
      // `ListView` in the QML, said again one panel over.
      .when(!selecting, (body) => body.overflow_y_scroll())
      // One inset for the whole page. Giving the body a narrower one bought a few
      // pixels and cost the alignment: the message text started to the left of
      // the subject above it and the toolbar below, which reads as a mistake long
      // before it reads as extra room.
      .px(tokens.space(14))
      .pt(tokens.space(24))
      .pb(tokens.space(28))
      .gap(tokens.space(14))
      .when(typeof model.onZoom === "function", (body) =>
        // The same gesture every document reader has. Without the modifier this
        // is the scroller's own wheel event and must stay so.
        body.on_scroll_wheel((event, eventCx) => {
          if (!event.modifiers?.control) return;
          model.onZoom(event.delta.y > 0 ? 0.1 : -0.1, eventCx);
        }),
      )
      .when(Boolean(model.message.invite), (body) =>
        // Inside the scroller rather than pinned above it: a recurring invitation
        // with a dozen guests is taller than the panel, and a card that cannot
        // scroll would leave the message itself with nowhere to be. It keeps the
        // panel's full width in every mode — it is this app's own UI, not the
        // sender's document.
        body.child(
          inviteCard(
            {
              invite: model.message.invite,
              response: model.message.response,
              canRespond: model.message.canRespond,
              sending: model.message.rsvpSending,
              onRespond: model.onRsvp,
              onOpen: model.onOpenLink,
            },
            cx,
          ),
        ),
      )
      .child(
        selecting
          ? // No border and no fill: it stands where the message stood, and a
            // framed box would read as a form to fill in rather than as the
            // message being held still. The reading width is not applied either —
            // the surface wraps its own lines, and a measure it does not know
            // about would only leave the text short of the panel edge.
            Textarea.new(model.selection)
              .id("reader-message-selection")
              .accessibility_label("Message text")
              .flex_1()
              .min_h_0()
              .w_full()
              .border(0)
              .bg(cx.theme().colors.background)
              .text_size(base)
              .text_color(cx.theme().colors.foreground)
          : reading
            ? h_flex().w_full().justify_center().child(column)
            : column,
      )
  );
}

// ------------------------------------------------------------------- footer

/** @param {any} attachment @param {any} model @param {import("gpui").Context} cx */
function attachmentRow(attachment, model, cx) {
  const tokens = style();
  const key = String(attachment.partId || attachment.attachmentId || "");
  const filename = String(attachment.filename || "attachment");
  return h_flex()
    .id(`reader-attachment-${key}`)
    .w_full()
    .items_center()
    .gap(tokens.space(6))
    .child(
      icon("attachment", cx, {
        size: tokens.font.iconSmall,
        color: dimColor(cx),
      }),
    )
    .child(
      new Button(`reader-attachment-open-${key}`)
        .label(filename)
        .tooltip("Open attachment")
        .size("xsmall")
        .onClick((event, eventCx) =>
          model.onAttachment(attachment, event, eventCx),
        )
        .build(cx)
        .flex_1()
        .min_w_0()
        .justify_start()
        .px(0)
        .py(0)
        // Underlined, always. This leaves the window, and the affordance has to
        // be there before the pointer is: some themes put the accent close
        // enough to the foreground that colour alone says nothing.
        .underline()
        .truncate(),
    )
    .child(
      div()
        .flex_none()
        .text_size(tokens.font.caption)
        .text_color(dimmerColor(cx))
        .child(Mail.formatSize(attachment.size)),
    );
}

// Icons rather than labels: six actions fit where six words would not.
//
// Split in two. What you do to the message — answer it, file it, throw it away
// — sits on the left where reading ends. How you look at it is not something
// you do to it, so it goes to the far right, out of the path of the actions
// that change something.
/** @param {any} model @param {import("gpui").Context} cx */
function messageActions(model, cx) {
  const tokens = style();
  const can = model.capabilities ?? {};
  /** @type {Array<[string,string,string,any]>} */
  const answering = [
    ["reply", "reply", "Reply · r", model.onReply],
    ["reply-all", "replyAll", "Reply all · a", model.onReplyAll],
    ["forward", "forward", "Forward · f", model.onForward],
  ];
  /** @type {Array<[string,string,string,any]>} */
  const disposing = [
    // No archive button where the account has nowhere to archive to. On IMAP
    // that is a move to a folder, and a server without one would have this
    // quietly do nothing — or worse, delete.
    ["archive", "archive", "Archive · e", model.onArchive],
    ["trash", "trash", "Move to trash · d", model.onTrash],
    // Not in the QML toolbar, which had no spam action at all. It belongs with
    // the other two: all three are ways of being finished with a message.
    ["spam", "spam", "Report spam", model.onSpam],
  ];
  /** @param {[string,string,string,any]} entry */
  const offered = ([id, , , callback]) =>
    can[id === "reply-all" ? "replyAll" : id] !== false &&
    typeof callback === "function";
  /** @param {[string,string,string,any]} entry */
  const draw = ([id, icon, description, callback]) =>
    actionIcon(`reader-action-${id}`, icon, description)
      .quiet()
      .onClick((event, eventCx) => callback(event, eventCx))
      .build(cx);

  const left = answering.filter(offered);
  const right = disposing.filter(offered);
  return h_flex()
    .id("reader-message-actions")
    .flex_none()
    .items_center()
    .gap(tokens.space(2))
    .when(
      Boolean(model.message.draftId) && typeof model.onEditDraft === "function",
      (row) =>
        row.child(
          actionIcon("reader-action-edit-draft", "compose", "Edit draft")
            .quiet()
            .onClick((event, eventCx) => model.onEditDraft(event, eventCx))
            .build(cx),
        ),
    )
    .children(left.map(draw))
    .when(left.length > 0 && right.length > 0, (row) =>
      // Answering a message and disposing of one are different intentions, and
      // one of them cannot be undone from here. The gap is wide enough that a
      // hand aiming at Forward cannot land on Archive.
      row.child(
        h_flex()
          .flex_none()
          .w(tokens.space(28))
          .items_center()
          .justify_center()
          .child(
            div()
              .w(tokens.spacing.hairline)
              .h(tokens.space(15))
              // `PanelSeparator` at its own 0.12, which is what the QML puts
              // here — a rule at the control border's weight competes with the
              // icons on either side of it.
              .bg(role("separator", cx.theme().colors.border)),
          ),
      ),
    )
    .children(right.map(draw));
}

// Three names for one setting, so they share a track, an outside edge and the
// seams between them. The selected fill belongs to one segment of one control
// rather than to a loose button beside two others.
//
// Named rather than iconed: there is no drawing that says "the message as its
// sender laid it out" and is not a guess of one, and telling the three apart is
// the whole point of having them.
const MODES = [
  ["reader", "Reader", "Rebuild this message for reading"],
  ["original", "Original", "Show the sender's own formatting"],
  ["plain", "Plain", "Show plain text"],
];

/** @param {any} model @param {import("gpui").Context} cx */
function viewTools(model, cx) {
  const tokens = style();
  // `selected` is the window's choice rather than what is on screen: a message
  // too heavy to draw the chosen way says so in its own notice, and a picker
  // that quietly moved to the mode it fell back to would leave nothing saying
  // the choice still stands for the next message.
  const chosen = String(model.bodyMode ?? model.presentation?.mode ?? "reader");
  return (
    h_flex()
      .id("reader-view-tools")
      // `anchors.right: parent.right` in the QML, which holds whether the picker
      // sits beside the actions or on its own line under them: a single item on a
      // wrapped line takes the line's start, so the slot claims the rest of the
      // width and pushes its contents to the far edge instead.
      .flex_1()
      .min_w_0()
      .justify_end()
      .items_center()
      .gap(tokens.space(6))
      .when(model.hasHtml !== false, (tools) =>
        // Nothing to choose between where there is no markup: the text is then
        // the message rather than one reading of it.
        tools.child(
          h_flex()
            .id("reader-mode-track")
            .flex_none()
            .items_center()
            .rounded(tokens.cornerRadius)
            .border(tokens.state.normalBorderWidth)
            .border_color(cx.theme().colors.border)
            .overflow_hidden()
            .children(
              MODES.flatMap(([mode, caption, tooltip], index) => [
                ...(index === 0
                  ? []
                  : [
                      // As tall as the segments it stands between, taken from
                      // them rather than from a constant: a fixed height drifts
                      // the moment the type scale moves.
                      div()
                        .flex_none()
                        .self_stretch()
                        .w(tokens.spacing.hairline)
                        .bg(cx.theme().colors.border),
                    ]),
                new Button(`reader-mode-${mode}`)
                  .label(caption)
                  .disabled(typeof model.onMode !== "function")
                  .selected(chosen === mode)
                  .tooltip(tooltip)
                  .size("xsmall")
                  .onClick((event, eventCx) =>
                    model.onMode?.(mode, event, eventCx),
                  )
                  .build(cx)
                  .flex_none()
                  .px(tokens.space(7))
                  .py(tokens.space(3)),
              ]),
            ),
        ),
      )
      // Beside the reading picker rather than in it, because it is not a fourth
      // reading: it is what happens to whichever of the three is chosen. Named
      // rather than iconed for the same reason the three are — and the kit has no
      // glyph for "you may now drag across this" that would not be a guess.
      //
      // Bordered, so it reads as a control while it is off: a `Button` is
      // transparent when idle, and a toggle nobody can see is a toggle nobody
      // finds. Selected while it is on, which is the whole of how the panel says
      // the body is being held plain on purpose.
      .when(typeof model.onToggleSelect === "function", (tools) =>
        tools.child(
          new Button("reader-select-text")
            .label("Select")
            .bordered()
            .selected(model.selecting === true)
            // Not "formatted": a message with no markup of its own has a
            // reading and no formatting, and the toggle means the same thing
            // for it.
            .tooltip(
              model.selecting === true
                ? "Show the message as it is read"
                : "Show the text so it can be selected · Ctrl+A",
            )
            .size("xsmall")
            .onClick((event, eventCx) => model.onToggleSelect(event, eventCx))
            .build(cx)
            .flex_none()
            .px(tokens.space(7))
            .py(tokens.space(3)),
        ),
      )
      .when(
        model.capabilities?.openOnWeb !== false &&
          typeof model.onOpenWeb === "function",
        (tools) =>
          tools.child(
            actionIcon("reader-open-web", "browser", "Open in browser")
              .quiet()
              .onClick((event, eventCx) => model.onOpenWeb(event, eventCx))
              .build(cx),
          ),
      )
  );
}

/** @param {any} model @param {import("gpui").Context} cx */
function readerFooter(model, cx) {
  const tokens = style();
  const attachments =
    typeof model.onAttachment === "function" &&
    Array.isArray(model.message.attachments)
      ? model.message.attachments
      : [];
  return (
    v_flex()
      .id("reader-footer")
      .flex_none()
      .w_full()
      // The toolbar sits on its own ground rather than on whatever happens to be
      // scrolled behind it, and the rule above it runs the full width: it
      // separates the toolbar from the message, and that division is the panel's.
      .bg(cx.theme().colors.background)
      .border_t(tokens.spacing.hairline)
      .border_color(role("separator", cx.theme().colors.border))
      // Control frames share the status bar's eight-pixel chrome inset. The page
      // content keeps its wider reading inset; applying that to buttons as well
      // made their glyphs sit visibly farther inward than the chrome below.
      .px(tokens.space(8))
      .pt(tokens.space(6))
      .pb(tokens.space(4))
      .gap(tokens.space(4))
      .children(
        attachments.map((/** @type {any} */ attachment) =>
          attachmentRow(attachment, model, cx),
        ),
      )
      .child(
        // The mode picker takes its own line when the two of them will not fit
        // across the panel: a row of controls that overlaps another row of
        // controls is worse than a taller toolbar.
        h_flex()
          .id("reader-toolbar")
          .w_full()
          .items_center()
          .justify_between()
          .flex_wrap()
          .gap(tokens.space(4))
          .child(messageActions(model, cx))
          .child(viewTools(model, cx)),
      )
  );
}

/** @param {any} model @param {import("gpui").Context} cx */
export function renderReader(model, cx) {
  // Nothing known at all is either a message that is not in the list — which,
  // after the reader learned to open on the list's own row, is the only way
  // that happens — or no message picked yet.
  if (!model.message)
    return model.state === "loading"
      ? readerSkeleton("reader-loading", cx)
      : readerBlankSlate(model.mailbox ?? {}, cx);

  const notices = readerNotices(model, cx);
  return v_flex()
    .id(`reader-content-${model.message.id}`)
    .flex_1()
    .min_w_0()
    .min_h_0()
    .bg(cx.theme().colors.background)
    .child(readerHeader(model, cx))
    .when(notices !== null, (reader) =>
      reader.child(/** @type {any} */ (notices)),
    )
    .child(
      // The headers are known and the body is not, which is every message being
      // opened for the first time. Over the body alone, so the sender and the
      // subject stay readable while it arrives — a whole-reader skeleton would
      // hide the very thing that just became available.
      model.state === "loading"
        ? readerSkeleton("reader-body-loading", cx)
        : readerBody(model, cx),
    )
    .child(readerFooter(model, cx));
}
