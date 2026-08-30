// @ts-check

import * as Registry from "../providers/Registry.js";
import * as Mail from "../message/Message.js";
import * as Model from "../account/Model.js";
import { hintsFor } from "../keys/keymap.js";
import { displayAddress } from "./addresses.js";
import { allowRemoteImages } from "./mail-actions.js";
import { unavailableWriting } from "./account-capabilities.js";
import {
  endReaderSelection,
  toggleReaderSelection,
} from "./reader-selection.js";

// What the reader is given.
//
// Lifted out of `main.js` alongside the mail, calendar and compose models: it
// is the one with three states and a dozen fields, and reading the window's
// own shape past it was the harder half of the job. It stays a plain function
// of the window rather than a method for the same reason the others did — the
// file has a size ceiling `tests/test_source.sh` enforces.

/**
 * When a message was sent, from whichever of the three places carries it. The
 * detail is the better source; the summary is what a provider that answers the
 * list from its own index gives, and it is still a real timestamp.
 * @param {any} detail @param {any} summary
 */
function readerDate(detail, summary) {
  const parsed = Mail.messageDate(detail);
  if (parsed) return parsed;
  // `date` on either, and never `time`: on a row that has been through
  // `Message.summarize`, `time` is the rendered string rather than a timestamp,
  // and "Fri" parses to an Invalid Date that formats as "undefined NaN, NaN".
  for (const value of [detail?.date, summary?.date]) {
    if (!value) continue;
    const date = new Date(String(value));
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

/**
 * @param {any} app the window
 * @param {any} snapshot the controller's snapshot
 * @param {any} mail the mail slice of it
 * @param {any} provider the active account's provider
 */
export function readerModel(app, snapshot, mail, provider) {
  if (app.readerHidden || !mail?.selectedId)
    return {
      state: "blank",
      mailbox: {
        label: Registry.mailboxFor(provider.id, mail?.mailboxKey ?? "inbox")
          .label,
        searchQuery: mail?.searchText ?? "",
        loading: mail?.loading === true,
        empty: (mail?.messages?.length ?? 0) === 0,
      },
      // The blank slate is where the keyboard is explained, and it reads from
      // the keymap like every other list of keys in the window — filtered,
      // like the status row, by what this provider refuses.
      hints: hintsFor(
        "list",
        Model.unavailableActions(provider.capabilities).concat(
          unavailableWriting(provider.capabilities),
        ),
      ),
    };

  const summary = (mail.messages ?? []).find(
    (/** @type {any} */ message) => String(message.id) === mail.selectedId,
  );
  const detail =
    snapshot.detail?.id === mail.selectedId ? snapshot.detail : null;
  // Nothing known at all, which after the reader learned to open on the
  // list's own row is only a message that is not in the list.
  if (!detail && !summary) return { state: "loading" };
  // The reader opens on what the list already knows — sender, subject, date,
  // flags — rather than on a skeleton over the whole pane. The row *is* a
  // summary and it is the same shape the live read produces, so the body
  // alone is what stands in: a whole-pane skeleton hid the very thing that
  // had just become available.
  const message = detail ?? summary;
  const reader = detail ? app.readerController?.snapshot() : null;
  return {
    state: detail ? "content" : "loading",
    message: {
      ...message,
      id: mail.selectedId,
      // The reader has room for the whole date and says it in full; the
      // list's column has room for "Fri" and says that. A provider that
      // reports neither an internal date nor a Date header still sends the
      // timestamp on the summary, so fall through to it rather than leaving
      // the header with no date at all.
      fullTime: Mail.fullTime(readerDate(detail, summary)) || "",
      subject:
        typeof message.subject === "string" ||
        typeof message.subject === "number"
          ? String(message.subject)
          : "",
      sender: displayAddress(message.sender ?? message.from),
      to: (message.to ?? []).map(displayAddress),
      starred:
        summary?.starred === true ||
        message.labelIds?.includes("STARRED") === true,
    },
    presentation: reader?.presentation
      ? {
          ...reader.presentation,
          blockedImages: reader.blockedImages,
          remoteImagesBlocked: reader.remoteImages > 0,
        }
      : null,
    // The window's own choice, which is what the picker shows selected —
    // distinct from the mode actually shown, which a refusal can override.
    bodyMode: reader?.mode ?? "reader",
    hasHtml: reader?.hasHtml === true,
    tooHeavy: reader?.tooHeavy === true,
    // Which refusal the "too heavy" notice is about: Qt's own layout cost,
    // which insisting can override, or this port's block cap, which it
    // cannot — there is nothing built to show.
    refused: reader?.refused === true,
    readingEmpty: reader?.readingEmpty === true,
    remoteImages: reader?.remoteImages ?? 0,
    remoteImagesAllowed: reader?.remoteImagesAllowed === true,
    unsubscribe: reader?.unsubscribe ?? null,
    // Whether the body is drawn as the reading blocks or as the plain surface a
    // selection can happen in. Not one of the three readings: it is a way of
    // handling whichever reading is chosen, so it sits beside the picker rather
    // than in it.
    selecting: app.readerSelecting === true,
    selection: app.readerSelection ?? null,
    zoom: app.bodyZoom,
    showBack: true,
    capabilities: {
      ...provider.capabilities,
      reply:
        ["gmail", "hey", "imap"].includes(provider.id) &&
        provider.capabilities.send,
      replyAll:
        ["gmail", "imap"].includes(provider.id) && provider.capabilities.send,
      forward:
        ["gmail", "hey", "imap"].includes(provider.id) &&
        provider.capabilities.send,
      trash: true,
      openOnWeb: Boolean(
        Registry.webMessageUrl(provider.id, mail.selectedId),
      ),
    },
    onMode: (
      /** @type {"reader"|"original"|"plain"} */ mode,
      /** @type {any} */ _event,
      /** @type {import("gpui").Context} */ eventCx,
    ) => {
      app.readerController?.setMode(mode);
      // The selecting surface holds the text of the reading it was opened on.
      // Changing which reading is shown changes that text, and the host has no
      // way to re-seed a textarea somebody may be part way through selecting
      // in — so the mode ends and the new reading is drawn as blocks.
      endReaderSelection(app);
      eventCx.notify();
    },
    onToggleSelect: (
      /** @type {any} */ _event,
      /** @type {import("gpui").Context} */ eventCx,
    ) => toggleReaderSelection(app, eventCx),
    onShowAnyway: (
      /** @type {any} */ _event,
      /** @type {import("gpui").Context} */ eventCx,
    ) => {
      /** @type {any} */ (app.readerController)?.showAnyway();
      eventCx.notify();
    },
    onShowImages: (
      /** @type {any} */ _event,
      /** @type {import("gpui").Context} */ eventCx,
    ) => allowRemoteImages(app, eventCx),
    onUnsubscribe: (
      /** @type {any} */ _event,
      /** @type {import("gpui").Context} */ eventCx,
    ) => {
      eventCx.spawn(async (asyncCx) => {
        await /** @type {any} */ (app.readerController)?.unsubscribe();
        asyncCx.notify();
      });
    },
    // A reading size somebody reached for is theirs until they change it, so
    // it outlives the message it was set on.
    onZoom: (
      /** @type {number} */ step,
      /** @type {any} */ _event,
      /** @type {import("gpui").Context} */ eventCx,
    ) => app.zoomBy(step, eventCx),
    onOpenWeb: (
      /** @type {any} */ _event,
      /** @type {import("gpui").Context} */ eventCx,
    ) => {
      const url = Registry.webMessageUrl(provider.id, mail.selectedId);
      if (url) eventCx.open_url(url);
    },
    onOpenLink: (
      /** @type {string} */ url,
      /** @type {any} */ _event,
      /** @type {import("gpui").Context} */ eventCx,
    ) => eventCx.open_url(url),
    onBack: (
      /** @type {any} */ _event,
      /** @type {import("gpui").Context} */ eventCx,
    ) => app.back(eventCx),
    onReply: (
      /** @type {any} */ _event,
      /** @type {import("gpui").Context} */ eventCx,
    ) => app.openResponse("reply", eventCx),
    onReplyAll: (
      /** @type {any} */ _event,
      /** @type {import("gpui").Context} */ eventCx,
    ) => app.openResponse("replyAll", eventCx),
    onForward: (
      /** @type {any} */ _event,
      /** @type {import("gpui").Context} */ eventCx,
    ) => app.openResponse("forward", eventCx),
    onEditDraft: (
      /** @type {any} */ _event,
      /** @type {import("gpui").Context} */ eventCx,
    ) => app.openDraft(eventCx),
    onAttachment:
      provider.id === "hey"
        ? undefined
        : (
            /** @type {any} */ attachment,
            /** @type {any} */ _event,
            /** @type {import("gpui").Context} */ eventCx,
          ) => app.openAttachment(attachment, eventCx),
    onArchive: (
      /** @type {any} */ _event,
      /** @type {import("gpui").Context} */ eventCx,
    ) => app.readerAct("archive", eventCx),
    onStar: (
      /** @type {any} */ _event,
      /** @type {import("gpui").Context} */ eventCx,
    ) => app.readerAct("star", eventCx),
    onSpam: (
      /** @type {any} */ _event,
      /** @type {import("gpui").Context} */ eventCx,
    ) => app.readerAct("spam", eventCx),
    onTrash: (
      /** @type {any} */ _event,
      /** @type {import("gpui").Context} */ eventCx,
    ) => app.readerAct("trash", eventCx),
  };
}
