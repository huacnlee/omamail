// @ts-check

import { h_flex, v_flex } from "gpui-base";
import * as Html from "../message/Html.js";
import {
  button,
  emptyState,
  label,
  muted,
  title,
} from "../lib/omarchy-ui/index.js";

/** @param {any} node */
function nodeText(node) {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text")
    return Html.decodeReferences(String(node.text || ""));
  return (node.children ?? []).map(nodeText).join("");
}

/** @param {string} value */
function visibleText(value) {
  return String(value)
    .replace(/[\t\r ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const MAX_READING_BLOCKS = 512;

/** @param {any} node @param {Array<{kind:string,text:string,level?:number}>} blocks @param {{overflow:boolean}} state */
function readingBlocks(node, blocks, state) {
  if (!node || typeof node !== "object" || state.overflow) return;
  if (blocks.length >= MAX_READING_BLOCKS) {
    state.overflow = true;
    return;
  }
  const name = String(node.name || "");
  if (/^h[1-6]$/.test(name)) {
    const text = visibleText(nodeText(node));
    if (text) blocks.push({ kind: "heading", text, level: Number(name[1]) });
    return;
  }
  if (name === "blockquote") {
    const text = visibleText(nodeText(node));
    if (text) blocks.push({ kind: "quote", text });
    return;
  }
  if (name === "li") {
    const text = visibleText(nodeText(node));
    if (text) blocks.push({ kind: "list-item", text });
    return;
  }
  if (["p", "pre", "tr"].includes(name)) {
    const text = visibleText(nodeText(node));
    if (text) blocks.push({ kind: name === "pre" ? "pre" : "paragraph", text });
    return;
  }
  for (const child of node.children ?? []) readingBlocks(child, blocks, state);
}

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
  const blocks =
    /** @type {Array<{kind:string,text:string,level?:number}>} */ ([]);
  if (ready.reader?.tooHeavy)
    return {
      mode: "reading",
      blocks,
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
  const state = { overflow: false };
  readingBlocks(ready.reader?.document, blocks, state);
  if (state.overflow) blocks.length = 0;
  const fallback = Html.readableText(ready.plainText?.text ?? "");
  if (!state.overflow && blocks.length === 0 && fallback)
    blocks.push({ kind: "paragraph", text: fallback });
  return {
    mode: "reading",
    blocks,
    blockedImages: Number(
      ready.reader?.blockedImages ?? ready.blockedImages ?? 0,
    ),
    remoteImagesBlocked:
      Number(ready.remoteImages ?? 0) > 0 ||
      Number(ready.reader?.blockedImages ?? 0) > 0,
    complexity: ready.reader?.complexity ?? ready.complexity,
    tooHeavy: Boolean(ready.reader?.tooHeavy),
    refused: state.overflow,
    empty: blocks.length === 0,
    formattedAvailable: false,
  };
}

/** @param {{kind:string,text:string,level?:number}} block @param {number} index @param {import("gpui").Context} cx */
function renderReadingBlock(block, index, cx) {
  const content =
    block.kind === "heading"
      ? title(block.text, cx)
      : block.kind === "quote"
        ? muted(block.text, cx)
        : label(
            block.kind === "list-item" ? `• ${block.text}` : block.text,
            cx,
          );
  return v_flex()
    .id(`reader-block-${index}-${block.kind}`)
    .when(block.kind === "quote", (element) =>
      element
        .border_l(2)
        .border_color(cx.theme().colors.border)
        .pl(cx.theme().spacing.md),
    )
    .child(content);
}

/** @param {any} model @param {import("gpui").Context} cx */
export function renderReader(model, cx) {
  if (model.state === "loading") {
    return emptyState(
      "Loading message…",
      "Fetching the selected message",
      cx,
    ).id("reader-loading");
  }
  if (model.state !== "content" || !model.message) {
    return emptyState("No message selected", "Choose a message to read", cx).id(
      "reader-blank",
    );
  }

  const actions = [
    ["back", "← Back", typeof model.onBack === "function", model.onBack],
    [
      "edit-draft",
      "Edit draft",
      Boolean(model.message.draftId),
      model.onEditDraft,
    ],
    ["reply", "Reply", model.capabilities?.reply, model.onReply],
    ["reply-all", "Reply all", model.capabilities?.replyAll, model.onReplyAll],
    ["forward", "Forward", model.capabilities?.forward, model.onForward],
    ["archive", "Archive", model.capabilities?.archive, model.onArchive],
    ["star", "Star", model.capabilities?.star, model.onStar],
    ["spam", "Report spam", model.capabilities?.spam, model.onSpam],
    ["trash", "Trash", model.capabilities?.trash, model.onTrash],
  ];
  const toolbar = h_flex()
    .id("reader-toolbar")
    .items_center()
    .gap(cx.theme().spacing.xs)
    .p(cx.theme().spacing.sm)
    .border_t(1)
    .border_color(cx.theme().colors.border)
    .children(
      actions
        .filter(
          ([, , supported, callback]) =>
            supported && typeof callback === "function",
        )
        .map(([id, caption, , callback]) =>
          button(
            id === "back" ? "reader-back" : `reader-action-${id}`,
            String(caption),
            (event, eventCx) => callback(event, eventCx),
            cx,
          ),
        ),
    );
  const modes = h_flex()
    .id("reader-modes")
    .items_center()
    .gap(cx.theme().spacing.xs)
    .children(
      ["reader", "original", "plain"].map((mode) =>
        button(
          `reader-mode-${mode}`,
          mode === "reader" ? "Reader" : mode === "original" ? "Original" : "Plain",
          (event, eventCx) => model.onMode?.(mode, event, eventCx),
          cx,
          {
            disabled: typeof model.onMode !== "function",
            selected: model.presentation?.mode === mode,
          },
        ),
      ),
    );
  return v_flex()
    .id(`reader-content-${model.message.id}`)
    .flex_1()
    .min_w_0()
    .min_h_0()
    .bg(cx.theme().colors.background)
    .child(modes)
    .child(
      v_flex()
        .id("reader-message-body")
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .p(cx.theme().spacing.lg)
        .child(
          v_flex()
            .id("reader-message-column")
            .w_full()
            .max_w("48rem")
            .gap(cx.theme().spacing.md)
            .child(
              v_flex()
                .id("reader-message-header")
                .gap(cx.theme().spacing.xs)
                .child(
                  title(
                    typeof model.message.subject === "string" ||
                      typeof model.message.subject === "number"
                      ? String(model.message.subject)
                      : "",
                    cx,
                  ),
                )
                .child(
                  muted(
                    typeof model.message.sender === "string" ||
                      typeof model.message.sender === "number"
                      ? String(model.message.sender)
                      : model.message.sender &&
                          typeof model.message.sender === "object"
                        ? (() => {
                            const name = String(
                              model.message.sender.name ?? "",
                            ).trim();
                            const email = String(
                              model.message.sender.email ?? "",
                            ).trim();
                            return name && email
                              ? `${name} <${email}>`
                              : name || email;
                          })()
                        : "",
                    cx,
                  ),
                ),
            )
            .child(
              model.presentation
                ? v_flex()
                    .id("reader-reading-mode")
                    .gap(cx.theme().spacing.md)
                    .children(
                      model.presentation.blocks.map(
                        (
                          /** @type {any} */ block,
                          /** @type {number} */ index,
                        ) => renderReadingBlock(block, index, cx),
                      ),
                    )
                    .children([
                      muted(
                        `Reading view · ${Number(model.presentation.complexity?.tags ?? 0)} elements`,
                        cx,
                      ).id("reader-complexity"),
                      ...(model.presentation.empty
                        ? [muted("This message has no readable text.", cx)]
                        : []),
                      ...(model.presentation.tooHeavy
                        ? [
                            muted(
                              "This message is too complex to show fully.",
                              cx,
                            ),
                          ]
                        : []),
                      ...(model.presentation.remoteImagesBlocked
                        ? [
                            muted("Remote images are blocked.", cx).id(
                              "reader-remote-images-blocked",
                            ),
                          ]
                        : []),
                    ])
                    .child(
                      muted("Formatted view is unavailable safely.", cx).id(
                        "reader-formatted-unavailable",
                      ),
                    )
                : label(model.message.body, cx),
            )
            .children(
              (typeof model.onAttachment === "function" &&
              Array.isArray(model.message.attachments)
                ? model.message.attachments
                : []
              ).map((/** @type {any} */ attachment) =>
                h_flex()
                  .id(
                    `reader-attachment-${String(attachment.partId || attachment.attachmentId)}`,
                  )
                  .items_center()
                  .justify_between()
                  .gap(cx.theme().spacing.md)
                  .p(cx.theme().spacing.sm)
                  .border(1)
                  .border_color(cx.theme().colors.border)
                  .rounded(cx.theme().radius.sm)
                  .child(
                    v_flex()
                      .min_w_0()
                      .child(
                        label(String(attachment.filename || "attachment"), cx),
                      )
                      .child(
                        muted(
                          `${String(attachment.mimeType || "application/octet-stream")} · ${Math.max(0, Number(attachment.size) || 0)} bytes`,
                          cx,
                        ),
                      ),
                  )
                  .child(
                    button(
                      `reader-attachment-open-${String(attachment.partId || attachment.attachmentId)}`,
                      "Open…",
                      (event, eventCx) =>
                        model.onAttachment?.(attachment, event, eventCx),
                      cx,
                      { disabled: typeof model.onAttachment !== "function" },
                    ),
                  ),
              ),
            ),
        ),
    )
    .child(toolbar);
}
