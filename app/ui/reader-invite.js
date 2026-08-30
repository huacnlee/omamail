// @ts-check

// The meeting inside the message, drawn as the thing it is.
//
// A Google Calendar invitation reads badly as mail: the HTML part is a table of
// the same facts laid out for a browser, and the times in it are the
// organiser's, in the organiser's words. This is those facts read out of the
// `text/calendar` part instead — one clock, the reader's own — with the three
// buttons that answer it.
//
// It scrolls with the body rather than sitting above it. A recurring meeting
// with a dozen guests is taller than the panel, and pinning it would leave the
// message with nowhere to be.

import { div } from "gpui";
import { h_flex, v_flex } from "gpui-base";
import * as Calendar from "../message/Calendar.js";
import { button, style } from "../lib/omarchy-ui/index.js";
import { icon } from "./icons.js";
import { dimColor, dimmerColor, normalFill } from "./reader-chrome.js";

// Six of them, and then a count. A meeting with forty guests would otherwise be
// a card longer than the message it came in.
const SHOWN_GUESTS = 6;

const ANSWERS = [
  { answer: "accepted", label: "Yes" },
  { answer: "tentative", label: "Maybe" },
  { answer: "declined", label: "No" },
];

/**
 * The card's own button: `IconTextButton` at the caption size the QML passes
 * it. The kit's `iconTextButton` pins `bodySmall` and takes no size, so this is
 * the same control assembled from `button()` — bordered, one control high, with
 * the glyph beside the label.
 * @param {string} id @param {string} iconName @param {string} caption
 * @param {(event:import("gpui").ClickEvent,cx:import("gpui").Context)=>void} onClick
 * @param {import("gpui").Context} cx
 * @param {{selected?:boolean, disabled?:boolean}} [options]
 */
function cardButton(id, iconName, caption, onClick, cx, options = {}) {
  const tokens = style();
  return button(id, caption, onClick, cx, {
    ...options,
    iconName,
    bordered: true,
    fontSize: tokens.font.caption,
  })
    .flex_none()
    .h(tokens.spacing.controlHeight);
}

/** @param {string} name @param {string} text @param {import("gpui").Context} cx @param {import("gpui").Color} color */
function factRow(name, text, cx, color) {
  const tokens = style();
  return h_flex()
    .w_full()
    .items_center()
    .gap(tokens.space(6))
    .child(
      icon(name, cx, { size: tokens.font.iconSmall, color: dimmerColor(cx) }),
    )
    .child(
      div()
        .flex_1()
        .min_w_0()
        .truncate()
        .text_size(tokens.font.caption)
        .text_color(color)
        .child(text),
    );
}

/**
 * @param {{invite:any, response?:string, canRespond?:boolean, sending?:boolean, onRespond?:(answer:string,event:any,cx:import("gpui").Context)=>void, onOpen?:(url:string,event:any,cx:import("gpui").Context)=>void}} model
 * @param {import("gpui").Context} cx
 */
export function inviteCard(model, cx) {
  const tokens = style();
  const invite = model.invite;
  const response = String(model.response || "");
  const canRespond = model.canRespond === true;
  // A cancelled meeting keeps its name legible rather than striking it through:
  // the heading above already says what happened, and struck text at this size
  // is hard to read on half the themes.
  const cancelled =
    invite.method === "CANCEL" || String(invite.status || "") === "CANCELLED";
  const when = Calendar.formatWhen(invite);
  const span = Calendar.formatDuration(invite);
  const location = String(invite.location || "");
  const organizer = invite.organizer;
  const attendees = Array.isArray(invite.attendees) ? invite.attendees : [];
  const meetLink = String(invite.meetLink || "");
  const recurrence = String(invite.recurrence || "");

  return v_flex()
    .id("reader-invite")
    .flex_none()
    .w_full()
    .gap(tokens.space(6))
    .p(tokens.space(12))
    .rounded(tokens.cornerRadius)
    .bg(normalFill(cx))
    .border(tokens.state.normalBorderWidth)
    .border_color(cx.theme().colors.border)
    .child(
      h_flex()
        .items_center()
        .gap(tokens.space(6))
        .child(
          icon("calendar", cx, {
            size: tokens.font.iconSmall,
            color: dimColor(cx),
          }),
        )
        .child(
          div()
            .text_size(tokens.font.caption)
            .text_color(dimColor(cx))
            .child(Calendar.headline(invite)),
        ),
    )
    .child(
      div()
        .id("reader-invite-summary")
        .w_full()
        .text_size(tokens.font.body)
        .font_bold()
        .text_color(cx.theme().colors.foreground)
        .child(String(invite.summary || "(no title)")),
    )
    .when(Boolean(when), (card) =>
      card.child(
        div()
          .id("reader-invite-when")
          .w_full()
          .text_size(tokens.font.bodySmall)
          .text_color(cx.theme().colors.foreground)
          .child(span === "" ? when : `${when} · ${span}`),
      ),
    )
    .when(Boolean(recurrence), (card) =>
      card.child(
        div()
          .w_full()
          .text_size(tokens.font.caption)
          .text_color(dimColor(cx))
          .child(recurrence),
      ),
    )
    .when(Boolean(location), (card) =>
      card
        .child(div().flex_none().h(tokens.space(2)))
        .child(factRow("pin", location, cx, dimColor(cx))),
    )
    .when(Boolean(organizer && String(organizer.email || "")), (card) =>
      card.child(
        factRow(
          "people",
          (() => {
            const host = String(organizer.name || organizer.email);
            const guests = Calendar.attendeeSummary(invite);
            return guests === "" ? host : `${host} · ${guests}`;
          })(),
          cx,
          dimColor(cx),
        ),
      ),
    )
    .when(attendees.length > 0, (card) =>
      card.child(
        v_flex()
          .id("reader-invite-guests")
          .w_full()
          .gap(tokens.space(2))
          .children(
            attendees.slice(0, SHOWN_GUESTS).map(
              (/** @type {any} */ guest, /** @type {number} */ index) =>
              div()
                .id(`reader-invite-guest-${index}`)
                .w_full()
                .truncate()
                .pl(tokens.font.iconSmall + tokens.space(6))
                .text_size(tokens.font.caption)
                .text_color(dimmerColor(cx))
                .child(
                  `${String(guest.name || guest.email)} — ${Calendar.partstatLabel(guest.partstat)}${guest.optional ? " (optional)" : ""}`,
                ),
            ),
          ),
      ),
    )
    .when(attendees.length > SHOWN_GUESTS, (card) =>
      card.child(
        div()
          .w_full()
          .pl(tokens.font.iconSmall + tokens.space(6))
          .text_size(tokens.font.caption)
          .text_color(dimmerColor(cx))
          .child(`and ${attendees.length - SHOWN_GUESTS} more`),
      ),
    )
    .when(
      (Boolean(meetLink) && !cancelled) || canRespond,
      (card) => card.child(div().flex_none().h(tokens.space(4))),
    )
    .when(Boolean(meetLink) && !cancelled, (card) =>
      card.child(
        // A browser opens, so the label says so before it is pressed.
        cardButton(
          "reader-invite-join",
          "video",
          meetLink.indexOf("meet.google.com") > 0
            ? "Join with Google Meet..."
            : "Join the call...",
          (event, eventCx) => model.onOpen?.(meetLink, event, eventCx),
          cx,
        ),
      ),
    )
    .when(canRespond, (card) =>
      card.child(
        h_flex()
          .id("reader-invite-rsvp")
          .items_center()
          .gap(tokens.space(6))
          .child(
            div()
              .flex_none()
              .text_size(tokens.font.caption)
              .text_color(dimColor(cx))
              .child("Going?"),
          )
          .children(
            ANSWERS.map((entry) =>
              cardButton(
                `reader-invite-${entry.answer}`,
                // The fill alone must never carry this: a theme can put the
                // selected colour close enough to the normal one to say
                // nothing at all.
                response === entry.answer ? "check" : "",
                entry.label,
                (event, eventCx) =>
                  model.onRespond?.(entry.answer, event, eventCx),
                cx,
                {
                  selected: response === entry.answer,
                  disabled: model.sending === true,
                },
              ),
            ),
          ),
      ),
    )
    .when(!canRespond && response !== "", (card) =>
      // What was answered, where there is no answering to be done — somebody
      // else's reply, a cancelled meeting, an invitation this account sent.
      card.child(
        div()
          .id("reader-invite-answer")
          .w_full()
          .text_size(tokens.font.caption)
          .text_color(dimColor(cx))
          .child(
            response === "accepted"
              ? "You are going"
              : response === "declined"
                ? "You are not going"
                : "You might be going",
          ),
      ),
    );
}
