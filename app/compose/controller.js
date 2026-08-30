// @ts-check
import { headerSafe, quoteBody, replySubject } from "../message/Message.js";
import { remainingSeconds, schedule } from "../message/Outbox.js";
import { accept as acceptRecipient, suggest } from "./Recipients.js";
import {
  identities as senderIdentities,
  subtitle as senderSubtitle,
  visible as visibleSenders,
} from "./Senders.js";

// How many completions the popup offers. More than a handful stops being a
// shortlist and starts being a directory the user has to read.
const SUGGESTION_LIMIT = 5;

// What the status line says while the message being answered is still being
// read. One sentence, said from the snapshot rather than written into `status`,
// because a keystroke clears `status` and the wait outlives it.
const QUOTE_LOADING = "Loading the message you are answering...";

// How long a toast stays up, which is `MailAccount`'s `noticeTimer` and
// `App.qml`'s `draftSavedTimer` — the same four seconds in both places.
const NOTICE_MS = 4000;

/**
 * The outbox: at most one queued send, and nothing else.
 *
 * In the QML this is a property of the account host — `MailAccount.pendingSend`
 * — and not of the compose form, and that difference is the whole of what this
 * file was missing. A queued message has **left** the composer: it is a payload
 * and a time, with the fields it was built from parked beside it so undo has
 * something to give back. Nothing the form does to itself afterwards can reach
 * it, and it survives the form being cleared, refilled with another draft, or
 * taken off screen entirely.
 *
 * It holds no timer of its own. Whoever has a clock says what time it is, which
 * is what makes the countdown testable and what lets one beat both redraw the
 * toast and decide the message is due.
 */
export function createOutbox() {
  /** @type {null | {payload:any,dueAt:number,parked:any}} */
  let held = null;
  return {
    /** @param {{payload:any,dueAt:number,parked:any}} item */
    queue(item) {
      held = item;
      return held;
    },
    peek() {
      return held;
    },
    /** Takes the queued item out, due or not. There is nothing left after. */
    take() {
      const item = held;
      held = null;
      return item;
    },
  };
}

/** The title band names the draft. Compose, reply and forward are one form. */
const TITLES = {
  reply: "Reply",
  replyAll: "Reply all",
  forward: "Forward",
  draft: "Draft",
};

/** @param {any} source */
function clean(source) {
  const value = source || {};
  const result = /** @type {any} */ ({
    mode: String(value.mode || "new"),
    to: headerSafe(value.to),
    cc: headerSafe(value.cc),
    bcc: headerSafe(value.bcc),
    subject: headerSafe(value.subject),
    body: String(value.body || ""),
    accountId: headerSafe(value.accountId),
  });
  for (const key of [
    "draftId",
    "threadId",
    "messageId",
    "inReplyTo",
    "references",
    "from",
    "originalFrom",
    "originalTo",
    "originalCc",
  ]) {
    const field = headerSafe(value[key]);
    if (field) result[key] = field;
  }
  return result;
}
/** @param {any} value @returns {string} */
function addressText(value) {
  if (Array.isArray(value))
    return value.map(addressText).filter(Boolean).join(", ");
  if (value && typeof value === "object") {
    const email = headerSafe(value.email).trim();
    const display = headerSafe(value.display || value.name).trim();
    const name = /[",]/.test(display)
      ? `"${display.replace(/(["\\])/g, "\\$1")}"`
      : display;
    return name && email ? `${name} <${email}>` : email || name;
  }
  return headerSafe(value);
}
/** @param {any} message */
function sourceFields(message) {
  const messageId = headerSafe(message.messageId || message.id);
  const priorReferences = headerSafe(message.references);
  return {
    accountId: message.accountId,
    threadId: message.threadId,
    messageId,
    inReplyTo: messageId || message.inReplyTo,
    references: [priorReferences, messageId].filter(Boolean).join(" "),
    // `from` is the identity this draft will be *sent* as and belongs to the
    // From picker; the original's own addresses are kept apart under
    // `original*`, which is what the preferred identity is chosen against.
    from: "",
    originalFrom: addressText(message.from),
    originalTo: addressText(message.to),
    originalCc: addressText(message.cc),
  };
}
/** @param {any} message */
function replyAddress(message) {
  return typeof message.replyTo === "string" && message.replyTo.trim()
    ? message.replyTo
    : message.replyTo?.email
      ? message.replyTo
      : message.from;
}
/** @param {any} value @returns {Array<string>} */
function addresses(value) {
  return addressText(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
/** @param {string} value */
function mailbox(value) {
  return (value.match(/<([^>]+)>/)?.[1] || value).trim().toLowerCase();
}
/** @param {unknown} subject */
function forwardSubject(subject) {
  const value = headerSafe(subject).trim();
  return /^fwd?:/i.test(value) ? value : `Fwd: ${value || "(no subject)"}`;
}
/** @param {{send?:(draft:any, done:(result:any)=>void)=>any,notify?:()=>void,currentAccountId?:()=>string,onSent?:(payload:any)=>void,onQueued?:()=>void,onNotice?:()=>void,clock?:()=>number,outbox?:ReturnType<typeof createOutbox>}} dependencies */
export function createComposeController(dependencies) {
  const values = dependencies || {};
  // Every time the seconds are asked for, they are asked for against this. A
  // test hands over a clock it moves by hand; the window hands over none and
  // gets the real one.
  const clock = values.clock ?? (() => Date.now());
  // Held apart on purpose, and injectable so the window can own the one it
  // drains on the way out. `const`, so no code below can swap the outbox for
  // another; that it is never written to except through its own three methods
  // is what makes "a keystroke cannot cancel a send" a property rather than a
  // convention.
  const outbox = values.outbox ?? createOutbox();
  let draft = clean({});
  let revision = 0;
  let status = "";
  let sending = false;

  // ------------------------------------------------------ the form's own state
  //
  // Everything below belongs to the draft being edited rather than to the
  // message that will be sent: which copy rows are revealed, which identity is
  // sending, what the completion popup is offering, and what is attached. The
  // view draws it and decides none of it.
  let ccVisible = false;
  let bccVisible = false;
  /** @type {Array<any>} the mailbox rows `Senders.identities` reads */
  let mailboxes = [];
  /** @type {Array<any>} */ let identities = [];
  let fromMenuOpen = false;
  // A chosen From survives an account's aliases arriving late; an unchosen one
  // is re-derived, because the preferred address is only knowable once they do.
  let fromWasChosen = false;
  /** @type {Array<any>} the address book behind the completion popup */
  let contacts = [];
  /** @type {""|"to"|"cc"|"bcc"} which field the popup belongs to */
  let focusedField = "";
  // Where the keyboard is in the popup. -1 is "nowhere yet", and Enter on it
  // takes the first row: the list is ranked, so the top one is the answer.
  let highlighted = -1;
  /** @type {Array<any>} files the user added to this draft */
  let attachments = [];
  /** @type {Array<any>} what the message being forwarded listed */
  let originalAttachments = [];
  /** @type {Array<any>} those files once their bytes are here */
  let forwardedAttachments = [];
  let forwardLoading = false;
  let forwardError = "";
  // Whether the message this draft answers is still on its way, and what went
  // wrong if it never came. A reply raised from the list opens the form at
  // once — nobody is made to watch a fetch before they may start typing — so
  // the quote, the Message-ID and the addresses only the full read knows land
  // in a form that is already up. See `loadingQuote`.
  let quoteLoading = false;
  let quoteError = "";
  let attaching = false;
  let notice = "";
  // When the notice went up, so a beat of the clock can take it down again
  // rather than a timer nobody can see from a test.
  let noticeAt = 0;

  /**
   * Put a toast up. `MailAccount.note`, with the same four-second life — which
   * is counted from here rather than started on a timer, so one beat of the
   * window's clock takes it down again.
   * @param {string} message @param {number} [at]
   */
  function note(message, at) {
    notice = String(message || "");
    noticeAt = at === undefined ? clock() : at;
    // The window has to be told, because by now its clock may have stopped.
    // A send is queued, the clock beats the countdown down to nothing, the
    // outbox empties and the loop ends — and only then does the host answer,
    // and `finishSend` puts "Sent" up against a clock that is no longer
    // running. Nothing retires it and the toast stays for the life of the
    // window. Anything that raises a notice from outside a beat has the same
    // shape, which is why this sits in `note` rather than at that one call.
    if (notice !== "") values.onNotice?.();
  }

  /**
   * Which title the band shows, and which identities the From picker offers.
   * A stored draft is bound to the account that holds it exactly the way a
   * reply is, and it is `draftId` rather than a mode of its own that says so —
   * the wire `mode` is validated against a fixed list before a draft may leave
   * the window, so "draft" must never reach it.
   */
  function formKind() {
    if (draft.draftId) return "draft";
    return draft.mode === "mailto" ? "new" : draft.mode;
  }

  /**
   * Which identity a draft sends from before anybody chooses. The address the
   * original was addressed to beats the account's first: an alias is just as
   * often the address a thread copied you on as the one it was sent to, and
   * answering from the account's default instead is how a thread ends up split
   * in two.
   * @param {Array<any>} rows @param {Array<string>} addressed
   */
  function preferred(rows, addressed) {
    for (const recipient of addressed) {
      const wanted = mailbox(recipient);
      const match = rows.find((row) => mailbox(row.email) === wanted);
      if (match) return match;
    }
    return rows[0] || null;
  }

  /** Rebuild the From list, and the chosen address while it is still nobody's. */
  function refreshIdentities() {
    identities = visibleSenders(
      senderIdentities(mailboxes),
      draft.accountId,
      formKind(),
    ).map((/** @type {any} */ row) => ({
      accountId: String(row.accountId || ""),
      email: String(row.email || ""),
      subtitle: senderSubtitle(row),
    }));
    if (fromWasChosen) return;
    const choice = preferred(identities, [
      ...addresses(draft.originalTo),
      ...addresses(draft.originalCc),
    ]);
    draft = clean({ ...draft, from: choice ? choice.email : "" });
  }

  /** What the popup is offering, which is only ever for the focused field. */
  function suggestions() {
    if (!focusedField) return [];
    return suggest(contacts, draft[focusedField], SUGGESTION_LIMIT);
  }

  /** Forwarded files ride along with the draft's own; a reply forwards none. */
  function outgoingAttachments() {
    return [
      ...(draft.mode === "forward" ? forwardedAttachments : []),
      ...attachments,
    ];
  }

  /** The per-draft state a new draft starts from. */
  function resetForm() {
    // Revealed by having something in them, the way the QML form opened a
    // reply-all: a row the user never asked for and cannot see is a header
    // nobody agreed to.
    ccVisible = draft.cc !== "";
    bccVisible = draft.bcc !== "";
    fromMenuOpen = false;
    fromWasChosen = Boolean(draft.from);
    focusedField = "";
    highlighted = -1;
    attachments = [];
    originalAttachments = [];
    forwardedAttachments = [];
    forwardLoading = false;
    forwardError = "";
    quoteLoading = false;
    quoteError = "";
    attaching = false;
    refreshIdentities();
  }

  /** @param {any} next */ function set(next) {
    // Nothing here about the outbox, and that is the point. A queued send is a
    // snapshot that has already left this form, so editing what is in the form
    // now edits a different message — the one being written next. This used to
    // drop `pending` on any keystroke, which un-queued the send silently and,
    // because the form was still on screen with live fields, on any keystroke
    // at all.
    draft = clean({ ...draft, ...next });
    revision += 1;
    status = "";
    // The popup is offering completions for text that has just been replaced.
    highlighted = -1;
  }
  /**
   * A new draft: the fields first, then the form built around them.
   *
   * It starts from a blank one rather than merging into whatever was open,
   * because every entry point names only the fields it has an opinion about —
   * a forward names no recipients at all, and inheriting the last draft's is
   * how a message reaches somebody nobody addressed it to.
   * @param {any} next
   */
  function begin(next) {
    draft = clean({});
    set(next);
    resetForm();
  }

  /**
   * Take the draft out of the form and hand it back.
   *
   * This is the mechanism the port was missing. `ComposeView.parkForSend` does
   * these three things in this order — snapshot the fields, clear the form,
   * close it — and everything the undo window gets right follows from them: the
   * window can go back to the list with nothing half-typed behind it, the
   * mailbox keys are live again, a keystroke lands on a new draft rather than
   * on the message that is leaving, and undo has something to put back.
   *
   * The mailbox stays: the next thing written in this window belongs to the
   * account the last one was sent from.
   */
  function park() {
    const held = {
      draft,
      ccVisible,
      bccVisible,
      fromWasChosen,
      attachments,
      originalAttachments,
      forwardedAttachments,
    };
    draft = clean({ accountId: draft.accountId });
    revision += 1;
    status = "";
    resetForm();
    return held;
  }

  /** Put a parked draft back, the way `resumePendingSend` does. */
  function restore(/** @type {any} */ held) {
    draft = clean(held.draft);
    revision += 1;
    status = "";
    resetForm();
    // After the form is rebuilt, not before: `resetForm` derives these from a
    // draft that has only just been assigned, and the parked ones are what the
    // user actually had open.
    ccVisible = held.ccVisible;
    bccVisible = held.bccVisible;
    fromWasChosen = held.fromWasChosen;
    attachments = held.attachments;
    originalAttachments = held.originalAttachments;
    forwardedAttachments = held.forwardedAttachments;
  }

  /**
   * Whatever the user started during the undo window, as something that can be
   * saved — or null where they started nothing. Undo gives the form back to the
   * queued message, so this is the draft that would otherwise be written over.
   */
  function displacedDraft() {
    const written = ["to", "cc", "bcc", "subject", "body"].some(
      (key) => String(draft[key] || "").trim() !== "",
    );
    if (!written && attachments.length === 0) return null;
    return { ...clean(draft), attachments: outgoingAttachments(), save: true };
  }

  /**
   * Hand a payload to the host.
   *
   * A save and a send finish differently because they are about different
   * things. A save is about the draft still on the form, so its answer is
   * written back into it — under the revision guard, because the form may have
   * moved on. A send is about a message that has already left the form: nothing
   * it answers may be written into whatever draft is there now, so it reports
   * through a toast and through `onSent`, and touches no field at all. That is
   * `MailAccount.deliver`, which notes "Sent" and emits `replySent` and never
   * assigns a compose field.
   * @param {any} payload @param {number} sentRevision
   */
  function deliver(payload, sentRevision) {
    sending = true;
    try {
      values.send?.(payload, (result) => {
        sending = false;
        if (payload.save) finishSave(result, payload, sentRevision);
        else finishSend(result, payload);
        values.notify?.();
      });
    } catch (error) {
      sending = false;
      const message = error instanceof Error ? error.message : "Send failed";
      if (!payload.save) note(message);
      else if (sentRevision === revision) status = message;
      values.notify?.();
    }
  }

  /** @param {any} result @param {any} payload @param {number} sentRevision */
  function finishSave(result, payload, sentRevision) {
    if (
      sentRevision !== revision ||
      (payload.accountId && payload.accountId !== values.currentAccountId?.())
    )
      return;
    if (result?.ok === false) {
      status = String(result.error || "Send failed");
      return;
    }
    status = "Draft saved";
    if (result?.value?.id)
      draft = clean({ ...draft, draftId: result.value.id });
  }

  /** @param {any} result @param {any} payload */
  function finishSend(result, payload) {
    if (result?.ok === false) {
      // Said out loud rather than dropped. By now the composer is off screen,
      // so a failure that only set a compose status would be a message that
      // never went and never said so.
      note(String(result.error || "Send failed"));
      return;
    }
    note("Sent");
    values.onSent?.(payload);
  }
  return {
    /** @param {any} [next] */ compose(next = {}) {
      begin({
        accountId: next.accountId,
        threadId: "",
        messageId: "",
        inReplyTo: "",
        references: "",
        from: "",
        originalFrom: "",
        originalTo: "",
        originalCc: "",
        ...next,
        mode: "new",
      });
      return this.snapshot();
    },
    /** @param {any} [next] */ mailto(next = {}) {
      begin({
        threadId: "",
        messageId: "",
        inReplyTo: "",
        references: "",
        from: "",
        originalFrom: "",
        originalTo: "",
        originalCc: "",
        ...next,
        mode: "mailto",
      });
      return this.snapshot();
    },
    /**
     * A draft the server already holds, reopened.
     *
     * The threading comes back with it, which is what `Message.draftFields`
     * carries in the QML: a reply saved half-written is still a reply, and a
     * draft reopened without its In-Reply-To goes out as a message of its own
     * that no client will file under the conversation it answers. `References`
     * comes back too — the QML rebuilds it from the one id it kept, which
     * loses every earlier hop of a long thread, and the header the draft was
     * saved with is the whole chain.
     *
     * The From is the address the draft was written as, so reopening it does
     * not silently move the reply to the account's default alias. It is the
     * bare mailbox rather than `addressText`'s `"Name" <a@b>`, because this is
     * matched against the identity list by address.
     * @param {any} [message]
     */ draft(message = {}) {
      begin({
        accountId: message.accountId,
        draftId: message.draftId,
        mode: "new",
        to: addressText(message.to),
        cc: addressText(message.cc),
        bcc: addressText(message.bcc),
        subject: message.subject === "(no subject)" ? "" : message.subject,
        body: message.body,
        threadId: message.threadId,
        inReplyTo: message.inReplyTo,
        references: message.references,
        from: headerSafe(message.from?.email || message.from).trim(),
      });
      return this.snapshot();
    },
    /** @param {any} [message] */ reply(message = {}) {
      begin({
        ...sourceFields(message),
        mode: "reply",
        to: addressText(replyAddress(message)),
        subject: replySubject(message.subject),
        body: quoteBody(message, message.body),
      });
      return this.snapshot();
    },
    /** @param {any} [message] @param {string} [ownAddress] */ replyAll(
      message = {},
      ownAddress = "",
    ) {
      const own = mailbox(ownAddress);
      const sender = addressText(replyAddress(message));
      const recipients = [sender, ...addresses(message.to)].filter(
        (value, index, all) =>
          mailbox(value) !== own &&
          all.findIndex(
            (candidate) => mailbox(candidate) === mailbox(value),
          ) === index,
      );
      begin({
        ...sourceFields(message),
        mode: "replyAll",
        to: recipients.join(", "),
        cc: addresses(message.cc)
          .filter(
            (value) =>
              mailbox(value) !== own &&
              !recipients.some(
                (recipient) => mailbox(recipient) === mailbox(value),
              ),
          )
          .join(", "),
        subject: replySubject(message.subject),
        body: quoteBody(message, message.body),
      });
      return this.snapshot();
    },
    /** @param {any} [message] */ forward(message = {}) {
      begin({
        accountId: message.accountId,
        threadId: "",
        messageId: "",
        inReplyTo: "",
        references: "",
        from: "",
        originalFrom: "",
        originalTo: "",
        originalCc: "",
        mode: "forward",
        subject: forwardSubject(message.subject),
        body: quoteBody(message, message.body),
      });
      return this.snapshot();
    },
    /** @param {any} next */ update(next) {
      set(next);
      return this.snapshot();
    },

    // ---------------------------------------------------------------- From
    //
    // One list of every address this window may send as: a mailbox can have
    // several of its own, and several mailboxes can be signed in at once. A
    // reply or forward stays on the mailbox holding the original, because
    // sending that draft from another account would hand a second server a
    // thread id it has never seen.

    /** @param {Array<any>} rows the signed-in mailboxes */ useIdentities(
      rows,
    ) {
      mailboxes = Array.isArray(rows) ? rows.slice() : [];
      refreshIdentities();
      return this.snapshot();
    },
    /** @param {any} identity */ chooseFrom(identity) {
      const row = identity && typeof identity === "object" ? identity : {};
      const accountId = String(row.accountId || "");
      fromWasChosen = true;
      fromMenuOpen = false;
      // Choosing an address on another mailbox moves the draft there with it;
      // the caller is what makes that mailbox the active one.
      draft = clean({
        ...draft,
        from: String(row.email || ""),
        ...(accountId ? { accountId } : {}),
      });
      refreshIdentities();
      return this.snapshot();
    },
    toggleFromMenu() {
      fromMenuOpen = identities.length > 1 && !fromMenuOpen;
      return this.snapshot();
    },
    closeFromMenu() {
      fromMenuOpen = false;
      return this.snapshot();
    },

    // -------------------------------------------------------- Cc, Bcc, popup

    showCc() {
      ccVisible = !ccVisible;
      return this.snapshot();
    },
    showBcc() {
      bccVisible = !bccVisible;
      return this.snapshot();
    },
    /** @param {Array<any>} rows the address book */ useContacts(rows) {
      contacts = Array.isArray(rows) ? rows.slice() : [];
      return this.snapshot();
    },
    /** @param {""|"to"|"cc"|"bcc"} name */ focusRecipients(name) {
      // The popup belongs to the field being typed into and to no other, so
      // leaving one closes it rather than leaving a menu attached to nothing.
      focusedField =
        name === "to" || name === "cc" || name === "bcc" ? name : "";
      highlighted = -1;
      return this.snapshot();
    },
    /** @param {number} delta */ moveSuggestion(delta) {
      const count = suggestions().length;
      if (count === 0) highlighted = -1;
      else if (highlighted < 0) highlighted = Number(delta) < 0 ? count - 1 : 0;
      else
        highlighted = Math.max(
          0,
          Math.min(count - 1, highlighted + Number(delta)),
        );
      return this.snapshot();
    },
    /**
     * Take a completion into the focused field. With nothing highlighted this
     * is the first row: the list is ranked, so the top one is the answer.
     * @param {any} [contact]
     */
    acceptSuggestion(contact) {
      const offered = suggestions();
      const chosen =
        contact ??
        offered[
          highlighted >= 0 && highlighted < offered.length ? highlighted : 0
        ];
      if (!focusedField || !chosen) return this.snapshot();
      const field = focusedField;
      set({ [field]: acceptRecipient(draft[field], chosen) });
      focusedField = field;
      return this.snapshot();
    },

    // --------------------------------------------------------- attachments

    /** @param {boolean} [flag] */ setAttaching(flag) {
      attaching = flag !== false;
      return this.snapshot();
    },
    /** @param {any} entry */ attach(entry) {
      if (entry) attachments = [...attachments, entry];
      attaching = false;
      return this.snapshot();
    },
    /**
     * The removed entry is reported back because a pasted file is a temporary
     * this window owns: dropping it from the list without saying so leaves it
     * on disk for nobody.
     * @param {number} at
     */
    detach(at) {
      const index = Math.floor(Number(at));
      if (index < 0 || index >= attachments.length) return this.snapshot();
      const removed = attachments[index];
      attachments = attachments.filter(
        (_entry, position) => position !== index,
      );
      return { ...this.snapshot(), removed };
    },
    /** @param {Array<any>} listed what the original message carries */
    loadingForwardAttachments(listed) {
      originalAttachments = Array.isArray(listed) ? listed.slice() : [];
      forwardedAttachments = [];
      forwardError = "";
      forwardLoading = originalAttachments.length > 0;
      return this.snapshot();
    },
    /** @param {Array<any>} loaded @param {string} [error] */
    loadedForwardAttachments(loaded, error = "") {
      forwardLoading = false;
      forwardError = String(error || "");
      forwardedAttachments = forwardError
        ? []
        : Array.isArray(loaded)
          ? loaded.slice()
          : [];
      return this.snapshot();
    },
    /**
     * The message being answered is still being read.
     *
     * Said after the draft has begun, because beginning one clears the form.
     * While it is true the form is live and Send is not: a reply whose quote
     * has not arrived would go out unthreaded and quoting nothing, which is
     * the same objection `forwardLoading` makes to a forward whose files are
     * still coming.
     */
    loadingQuote() {
      quoteLoading = true;
      quoteError = "";
      return this.snapshot();
    },
    /**
     * It arrived, or it did not. A failed read does not lock the form: the
     * draft is addressed and the user can see there is no quote in it, and a
     * Send that can never be pressed is a worse answer than a sentence saying
     * what is missing.
     * @param {string} [error]
     */
    loadedQuote(error = "") {
      quoteLoading = false;
      quoteError = String(error || "");
      return this.snapshot();
    },
    /** @param {string} message the draft-saved toast, "" to take it down */
    setNotice(message) {
      note(message);
      return this.snapshot();
    },

    /** @param {string} message */ setStatus(message) {
      status = String(message);
      values.notify?.();
      return this.snapshot();
    },
    /**
     * Queue this draft, and hand the form back empty.
     *
     * Both halves happen however long the undo window is, zero included: the
     * message is a snapshot of the moment Send was pressed, and a form still
     * holding its fields is a form whose next keystroke edits a message that
     * has already gone. `ComposeView.submit` parks on every accepted send for
     * that reason, and `App.qml` returns to the list on the signal it emits.
     * @param {number} [now] @param {number} [delay]
     */
    send(now = clock(), delay = 0) {
      // One at a time, which is `MailAccount.send`'s `sending || sendPending`.
      if (sending || outbox.peek()) return this.snapshot();
      // A forward whose files are still arriving would go out without them,
      // and one whose read failed would go out claiming to carry them.
      if (forwardLoading || forwardError) return this.snapshot();
      // Same objection, about the message being answered rather than the files
      // it carries. Nothing is set here: the status line is already saying
      // that the original is still coming, which is the whole explanation, and
      // a sentence written into `status` would outlive the wait it describes.
      if (quoteLoading) return this.snapshot();
      const payload = { ...clean(draft), attachments: outgoingAttachments() };
      if (
        values.currentAccountId &&
        payload.accountId !== values.currentAccountId()
      ) {
        status = "This draft belongs to another account.";
        return this.snapshot();
      }
      if (!payload.to.trim()) {
        status = "Add a recipient.";
        return this.snapshot();
      }
      const queued = schedule(payload, now, delay);
      outbox.queue({
        payload,
        dueAt: queued ? queued.dueAt : Number(now),
        parked: park(),
      });
      values.onQueued?.();
      // No undo window is not a second mechanism, only a window that has closed
      // already.
      if (!queued) return this.flush(now);
      return this.snapshot();
    },
    /**
     * Save the draft that is on the form. Never queued and never parked: a
     * saved draft is one the user is still writing, and it stays where it is.
     */
    save() {
      if (sending) return this.snapshot();
      const payload = {
        ...clean(draft),
        attachments: outgoingAttachments(),
        save: true,
      };
      if (
        values.currentAccountId &&
        payload.accountId !== values.currentAccountId()
      ) {
        status = "This draft belongs to another account.";
        return this.snapshot();
      }
      deliver(payload, revision);
      return this.snapshot();
    },
    /**
     * Send what is due.
     *
     * The expected due time is the caller's ticket: a beat left over from a
     * send that was undone must not deliver the one queued after it.
     * @param {number} [now] @param {number} [expectedDueAt]
     */
    flush(now = clock(), expectedDueAt) {
      const held = outbox.peek();
      if (!held) return this.snapshot();
      if (expectedDueAt !== undefined && held.dueAt !== expectedDueAt)
        return this.snapshot();
      if (held.dueAt > Number(now)) return this.snapshot();
      outbox.take();
      deliver(held.payload, revision);
      return this.snapshot();
    },
    /**
     * Send whatever is queued at once, due or not.
     *
     * The undo window is a courtesy this window can afford while it is open. It
     * cannot afford it while it is closing: a queued message that exists only
     * in this process is one the process takes with it. So closing spends the
     * rest of the window rather than the message.
     */
    drain() {
      const held = outbox.take();
      if (!held) return { ...this.snapshot(), drained: false };
      deliver(held.payload, revision);
      return { ...this.snapshot(), drained: true };
    },
    /**
     * One beat of the clock the toast is drawn against.
     *
     * `MailAccount` runs this every 250ms while a send is queued, and it is
     * what the port had no equivalent of: the seconds are worked out from the
     * time, so with nothing to make the time move again the toast reads
     * whatever it read when it was first drawn — "Sending in 10s", for ten
     * seconds. One beat both redraws the countdown, retires a toast that has
     * had its four seconds, and delivers a message that has come due, so a
     * single loop in the window drives all three.
     * @param {number} [now]
     */
    tick(now = clock()) {
      if (notice !== "" && Number(now) - noticeAt >= NOTICE_MS) notice = "";
      const held = outbox.peek();
      if (held && held.dueAt <= Number(now)) return this.flush(now);
      return this.snapshot();
    },
    /**
     * Take the queued message back, and put it where it came from.
     *
     * An undo without the restore is a message that neither went out nor came
     * back. Whatever was started while it was queued is handed to the caller
     * rather than written over — `App.undoPendingSend` saves that one to the
     * provider's Drafts before the queued message takes the form back.
     * @param {number} [now]
     */
    undo(now = clock()) {
      const held = outbox.take();
      if (!held)
        return { ...this.snapshot(), restored: false, interrupted: null };
      const displaced = displacedDraft();
      restore(held.parked);
      note("Send undone", now);
      return { ...this.snapshot(), restored: true, interrupted: displaced };
    },
    /**
     * What is in the form, as something that could be saved — or null where
     * there is nothing worth saving. The same question `undo` asks about a
     * draft it is about to write over, asked at the exit instead.
     */
    unsavedDraft() {
      return displacedDraft();
    },
    discard() {
      // The outbox is left alone. Discard is the exit for the draft on the
      // form, and a message queued from an earlier one is not that draft —
      // throwing it away here would destroy mail the user only meant to stop
      // writing a second one of.
      sending = false;
      draft = clean({});
      revision += 1;
      status = "";
      notice = "";
      resetForm();
      return this.snapshot();
    },
    snapshot() {
      const offered = suggestions();
      const held = outbox.peek();
      const now = clock();
      return {
        draft,
        revision,
        // The payload and its due time, and not the parked fields: those are
        // the outbox's business and no view has anything to draw with them.
        pending: held ? { payload: held.payload, dueAt: held.dueAt } : null,
        sendPending: Boolean(held),
        // Read against the clock every time it is asked for, so the number
        // changes as the time does rather than as the state does.
        undoSeconds: held ? remainingSeconds(held.dueAt, now) : 0,
        // Whether anything on screen is still moving. The window runs its clock
        // while this is true and stops the moment it is not: a beat that
        // outlives its reason is a window that never goes idle.
        needsTick: Boolean(held) || notice !== "",
        sending,
        // What is being waited for outranks what was last said, and both
        // outrank a failure the user has since acted past: `set` clears
        // `status` on every keystroke, so a quote that never arrived goes on
        // saying so until something else has something to say.
        status: quoteLoading ? QUOTE_LOADING : status || quoteError,
        // Whether the original this draft answers is still coming. The view
        // holds Send while it is.
        quoting: { loading: quoteLoading, error: quoteError },
        notice,
        title:
          TITLES[/** @type {keyof typeof TITLES} */ (formKind())] ||
          "New message",
        ccVisible,
        bccVisible,
        identities,
        // The picker is a picker only where there is a choice; one identity is
        // a fact about the account, not a question to put to the user.
        canChooseFrom: identities.length > 1,
        fromMenuOpen,
        suggestions: {
          field: focusedField,
          contacts: offered,
          highlighted: highlighted < offered.length ? highlighted : -1,
        },
        attachments,
        attaching,
        forward: {
          originals: originalAttachments,
          files: forwardedAttachments,
          loading: forwardLoading,
          error: forwardError,
        },
      };
    },
  };
}
