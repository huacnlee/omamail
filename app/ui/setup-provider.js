// @ts-check

// Which kind of mailbox is being added, and what the page about it opens with.
//
// The chooser exists because the three setups have nothing in common: one is a
// browser round trip through Google, one is a program 37signals publish, and
// one is an address and a password. Guessing from the address would be worse
// than asking — a Gmail address is a legitimate IMAP account, and picking the
// wrong one costs the user the whole setup before they find out.

import { div, image } from "gpui";
import { h_flex, v_flex } from "gpui-base";
import { splitBrand } from "../account/Model.js";
import { Label, MutedText, alpha, style } from "omarchy-ui";
import { icon } from "./icons.js";

// A provider's own artwork, as this application draws it.
//
// `Registry.mark` and `Registry.logo` name colour bitmaps under the plugin's
// `assets/`, and the gpui client reads assets from its own directory, so the
// brand artwork sits at `app/assets` beside the icon set. A service's own mark
// answers "which mailbox am I adding" before any of the words do, and it
// answers it in the service's colours — a themed monochrome stand-in would be
// this window's opinion of somebody else's logo. IMAP has no brand to draw, and
// the themed envelope is what it honestly is: a mailbox somewhere.
//
// **`mark` and `logo` are two different questions**, exactly as the registry
// splits them: `mark` is the square icon a chooser row wants, `logo` is the
// lockup a page about the service opens with. HEY's is a wordmark more than
// twice as wide as it is tall, and squaring it would either crop it or strand
// it in empty space.
//
// The aspect is written down because gpui cannot ask for it. `ProviderLogo.qml`
// takes a height and reads the width back off the loaded `Image`; gpui's `img`
// is given both, so the ratio of the file on disk is recorded here — a fact
// about the asset, checked by `tests/test_setup_ui_render.mjs` against the PNG
// headers rather than trusted.
const ARTWORK = {
  gmail: {
    mark: { image: "assets/gmail.png", aspect: 128 / 128 },
    logo: { image: "assets/gmail.png", aspect: 128 / 128 },
  },
  hey: {
    mark: { image: "assets/hey-mark.png", aspect: 128 / 128 },
    logo: { image: "assets/hey.png", aspect: 280 / 128 },
  },
};

/** The provider record the model carries, found by id. @param {any} model */
export function providerRecord(model) {
  const providers = Array.isArray(model.providers) ? model.providers : [];
  return (
    providers.find((/** @type {any} */ entry) => entry.id === model.provider) ??
    null
  );
}

/** @param {any} provider */
export function providerWebsite(provider) {
  try {
    return typeof provider?.webHomeUrl === "function"
      ? String(provider.webHomeUrl() || "")
      : String(provider?.webHomeUrl || "");
  } catch (_) {
    return "";
  }
}

/**
 * `ProviderLogo.qml`: the mark that answers "which mailbox am I adding" before
 * any of the words do.
 *
 * The height is what the caller asks for and the width follows from the
 * artwork, because a brand's own lockup decides its own proportions.
 * @param {string} id @param {string} providerId @param {number} size
 * @param {import("gpui").Context} cx
 * @param {{variant?: "mark" | "logo"}} [options]
 */
export function providerArtwork(id, providerId, size, cx, options = {}) {
  const art = /** @type {any} */ (ARTWORK)[providerId]?.[
    options.variant ?? "mark"
  ];
  if (art)
    return image(art.image)
      .id(id)
      .role("image")
      .flex_none()
      .h(size)
      .w(Math.round(size * art.aspect));
  // The envelope `ProviderLogo.qml` falls back to, in the theme's colour and a
  // shade under the slot, so a stroked glyph and a piece of artwork carry the
  // same weight in a row: artwork fills its box and a glyph does not. The slot
  // itself keeps the full size, so a fallback row lines up with a branded one.
  return div()
    .id(id)
    .role("image")
    .flex_none()
    .size(size)
    .flex()
    .items_center()
    .justify_center()
    .child(
      icon("unread", cx, {
        size: Math.round(size * 0.8),
        color: cx.theme().colors.foreground,
      }),
    );
}

/**
 * `LinkLabel.qml`: one word inside a line of text that leaves the window.
 *
 * Underlined, always — the affordance has to be there before the pointer is,
 * and colour alone must never carry it. A provider with no website to point at
 * gets the same word, plain.
 *
 * @param {string} id
 * @param {string} text
 * @param {string} url
 * @param {((url:string, cx:import("gpui").Context) => void)|undefined} onOpen
 * @param {import("gpui").Context} cx
 * @param {{tooltip?:string,size?:number,bold?:boolean}} [options]
 */
export function linkLabel(id, text, url, onOpen, cx, options = {}) {
  const tokens = style();
  const size = options.size ?? tokens.font.body;
  const plain = div()
    .id(id)
    .text_size(size)
    .text_color(cx.theme().colors.foreground)
    .when(options.bold === true, (element) => element.font_bold())
    .child(text);
  if (!url || typeof onOpen !== "function") return plain;
  return plain
    .role("link")
    .underline()
    .accessibility_label(options.tooltip || text)
    .when(Boolean(options.tooltip), (element) =>
      element.tooltip(options.tooltip ?? ""),
    )
    .on_click((_event, eventCx) => onOpen(url, eventCx))
    .hover((appearance) => appearance.text_color(cx.theme().colors.primary));
}

/**
 * The plain page heading — a title and one line under it — for a setup page
 * with no brand to open with. IMAP is a protocol rather than a service, so its
 * page says "Add a mailbox" and nothing recoloured stands in for a logo.
 * @param {string} id @param {string} heading @param {string} detail
 * @param {import("gpui").Context} cx
 */
export function pageHeading(id, heading, detail, cx) {
  const tokens = style();
  return v_flex()
    .id(id)
    .w_full()
    .min_w_0()
    .gap(tokens.spacing.labelGap)
    .child(
      div()
        .role("heading")
        .text_size(tokens.font.heading)
        .font_bold()
        .text_color(cx.theme().colors.foreground)
        .child(heading),
    )
    .when(Boolean(detail), (column) =>
      column.child(
        new MutedText(detail).build(cx).text_size(tokens.font.bodySmall),
      ),
    );
}

/**
 * `ProviderHero.qml`: the service's mark, its name, and one line saying what
 * connecting it involves.
 *
 * The brand word in the heading is the link, not the whole heading: a heading
 * that is entirely a link reads as one somebody made clickable by accident,
 * and the sentence around it is not about the website.
 *
 * @param {{id:string,provider:any,heading:string,detail:string,onOpenUrl?:(url:string,cx:any)=>void}} model
 * @param {import("gpui").Context} cx
 */
export function providerHero(model, cx) {
  const tokens = style();
  const provider = model.provider ?? {};
  const website = providerWebsite(provider);
  const parts = splitBrand(model.heading, String(provider.name || ""));
  const tooltip = `Open ${provider.name} in your browser`;
  // No gap inside the heading row: the spaces around the brand word are the
  // ones the sentence already had, and a row that added its own would space
  // "Add a HEY mailbox" twice.
  const heading = h_flex()
    .id(`${model.id}-heading`)
    .role("heading")
    .items_center()
    .flex_wrap()
    .children(
      /** @type {any[]} */ ([
        parts.before
          ? div().text_size(tokens.font.heading).font_bold().child(parts.before)
          : null,
        parts.brand
          ? linkLabel(
              `${model.id}-brand`,
              parts.brand,
              website,
              model.onOpenUrl,
              cx,
              { tooltip, size: tokens.font.heading, bold: true },
            )
          : null,
        parts.after
          ? div().text_size(tokens.font.heading).font_bold().child(parts.after)
          : null,
      ]).filter(Boolean),
    );
  // The mark is the other half of the same link, the way `ProviderHero.qml`
  // hangs a `TapHandler` and a tooltip off `ProviderLogo` — and it is the one
  // place in this window where a pointing hand is right, because this is a link
  // in the ordinary sense rather than a native control.
  const logo = providerArtwork(
    `${model.id}-logo`,
    String(provider.id || ""),
    tokens.space(40),
    cx,
    { variant: "logo" },
  )
    // `anchors.topMargin: Style.space(2)`: the artwork sits a shade below the
    // cap line of the heading beside it rather than on it.
    .mt(tokens.space(2))
    .when(Boolean(website) && typeof model.onOpenUrl === "function", (mark) =>
      mark
        .cursor_pointer()
        .tooltip(tooltip)
        .on_click((/** @type {any} */ _event, /** @type {any} */ eventCx) =>
          model.onOpenUrl?.(website, eventCx),
        ),
    );
  return h_flex()
    .id(model.id)
    .w_full()
    .min_w_0()
    .items_start()
    .gap(tokens.space(14))
    .child(logo)
    .child(
      v_flex()
        .flex_1()
        .min_w_0()
        .gap(tokens.spacing.labelGap)
        .child(heading)
        .child(
          new MutedText(model.detail)
            .build(cx)
            .text_size(tokens.font.bodySmall),
        ),
    );
}

/**
 * `ProviderPicker.qml`: one card per provider, in the registry's own order —
 * the two hosted mailboxes first, then the one that is every other mailbox.
 *
 * A provider with nothing behind it is listed and dimmed rather than hidden —
 * somebody looking for HEY should find the answer here, not conclude the app
 * forgot about it — and its card carries the reason instead of the summary.
 * Never both, and never a card that says nothing.
 *
 * @param {any} model @param {import("gpui").Context} cx
 */
export function providerPicker(model, cx) {
  const tokens = style();
  const foreground = cx.theme().colors.foreground;
  const providers = Array.isArray(model.providers) ? model.providers : [];
  return v_flex()
    .id("setup-provider-selector")
    .role("list")
    .w_full()
    .min_w_0()
    .gap(tokens.spacing.lg)
    .children(
      providers.map((/** @type {any} */ provider) => {
        const reason = String(provider.unavailable || "");
        const connectable = !reason;
        return (
          h_flex()
            .id(`setup-provider-${provider.id}`)
            .role("list_item")
            .accessibility_label(provider.name)
            .items_center()
            .w_full()
            .min_w_0()
            .gap(tokens.spacing.rowPaddingX)
            .px(tokens.spacing.rowPaddingX)
            // `implicitHeight: max(text, mark) + Style.space(24)` — twelve above
            // and twelve below, the same air the card keeps at its sides.
            .py(tokens.space(12))
            .rounded(tokens.cornerRadius)
            .border(tokens.state.normalBorderWidth)
            .border_color(alpha(foreground, tokens.state.hoverBorderAlpha))
            .bg(alpha(foreground, tokens.state.normalFillAlpha))
            // Not greyed out with a literal colour — the theme owns those.
            // Reduced opacity says "not available" without inventing a grey some
            // themes render as ordinary body text.
            .when(!connectable, (card) => card.opacity(0.55))
            .when(connectable, (card) =>
              card
                .on_click((_event, eventCx) =>
                  model.onProvider?.(provider.id, eventCx),
                )
                .hover((appearance) =>
                  appearance.bg(alpha(foreground, tokens.state.hoverFillAlpha)),
                ),
            )
            .child(
              providerArtwork(
                `setup-provider-${provider.id}-mark`,
                String(provider.id || ""),
                tokens.space(26),
                cx,
                // The square icon a row wants, never the page's wider lockup.
                { variant: "mark" },
              ),
            )
            .child(
              v_flex()
                .flex_1()
                .min_w_0()
                .gap(tokens.spacing.xs)
                .child(
                  new Label(provider.name)
                    .build(cx)
                    .text_size(tokens.font.bodySmall)
                    .font_bold(),
                )
                .child(
                  new MutedText(
                    connectable ? String(provider.summary || "") : reason,
                  )
                    .build(cx)
                    .id(`setup-provider-${provider.id}-summary`)
                    .text_size(tokens.font.caption),
                ),
            )
        );
      }),
    );
}
