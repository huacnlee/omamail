// @ts-check

import * as Registry from "../providers/Registry.js";
import * as Calendar from "../message/Calendar.js";
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
 * The message a `mailto:` List-Unsubscribe asks for, sent as itself.
 *
 * `MailAccount.unsubscribe` sends it through the account's own client; here it
 * is the same `compose.send` the composer uses, addressed and worded by
 * `Unsubscribe.parseMailto` out of the header the list wrote. It never opens
 * the composer: nothing about this is a draft the user is writing, and putting
 * a half-filled form on screen would be asking them to finish a request they
 * have already made.
 *
 * @param {any} app @param {any} account @param {any} provider
 * @param {string} from @param {{to:string,subject:string,body:string}} outgoing
 */
function sendUnsubscribeMail(app, account, provider, from, outgoing) {
  return new Promise((resolve, reject) => {
    if (!account?.id || typeof app.executeEffect !== "function") {
      reject(new Error("This mailbox cannot send"));
      return;
    }
    app.executeEffect(
      {
        type: "compose.send",
        provider: provider.id,
        accountId: account.id,
        draft: {
          mode: "new",
          to: [outgoing.to],
          cc: [],
          bcc: [],
          subject: outgoing.subject,
          body: outgoing.body,
          // The list only ever knew the address it delivered to, so the
          // request has to come from it rather than from wherever the host
          // would otherwise put the account.
          from,
        },
      },
      (/** @type {any} */ result) =>
        result?.ok === true
          ? resolve(result)
          : reject(new Error(String(result?.error || "The unsubscribe message could not be sent"))),
    );
  });
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
  const account = (snapshot.accounts?.accounts ?? []).find(
    (/** @type {any} */ entry) => entry.id === snapshot.accounts?.activeId,
  );
  // The address this account answers as. `MailAccount` picks the alias the
  // message was addressed to, out of the Gmail send-as list; nothing here has
  // that list yet, so it is the account's own address — which is what the
  // alias falls back to there as well.
  const answeringAs = String(account?.email ?? "");
  // Whether unsubscribing by mail is on offer at all. Not simply "the provider
  // can send": the standalone host's `compose.send` carries a new message for
  // Gmail and IMAP, while HEY's own command takes a reply or a forward and
  // nothing else — so on HEY the list's page is the honest offer and a mailto
  // would be a button that could not do what it said.
  const canSend =
    provider.capabilities.send === true &&
    ["gmail", "imap"].includes(provider.id);
  const reader = detail ? app.readerController?.snapshot({ canSend }) : null;
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
      // Read back out of the invitation rather than remembered beside it, the
      // way `MailAccount.selectedResponse` is: an answer that was sent rewrote
      // this account's ATTENDEE line in the copy on disk, so the card and the
      // file cannot disagree.
      response: message.invite
        ? Calendar.responseOf(message.invite, answeringAs)
        : "",
      // Answering is sending an RFC 5546 REPLY, and the standalone host's
      // message builder has no `text/calendar` part to put one in — so the
      // card shows the meeting and what was answered, and offers no buttons
      // that would send a reply no calendar server would act on.
      canRespond: false,
      rsvpSending: false,
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
    imageSources: reader?.imageSources ?? [],
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
    // Three ways off a list and one button, because `Unsubscribe.plan` has
    // already chosen between them. Only the POST is the controller's own work:
    // a page needs a live context to open it and a message needs the account
    // to send it, so both are handed down from here rather than reached for
    // from inside the reader.
    onUnsubscribe: (
      /** @type {any} */ _event,
      /** @type {import("gpui").Context} */ eventCx,
    ) => {
      eventCx.spawn(async (asyncCx) => {
        try {
          await /** @type {any} */ (app.readerController)?.unsubscribe({
            canSend,
            openUrl: (/** @type {string} */ url) => asyncCx.open_url(url),
            sendMail: (/** @type {any} */ outgoing) =>
              sendUnsubscribeMail(app, account, provider, answeringAs, outgoing),
          });
        } catch (error) {
          // `MailAccount.unsubscribe`'s `fail`, which is the status line. An
          // unhandled rejection out of a spawned task takes the window with
          // it, and a request that failed silently is one the user has no
          // reason to think failed at all.
          app.controller?.refuse(
            String(
              /** @type {any} */ (error)?.message ||
                "The unsubscribe request could not be sent",
            ),
          );
        }
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
    onOpenImage: (
      /** @type {number} */ index,
      /** @type {import("gpui").Context} */ eventCx,
    ) => {
      const source = reader?.imageSources?.[index];
      if (source && /^https?:\/\//i.test(source)) eventCx.open_url(source);
    },
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
