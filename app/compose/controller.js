// @ts-check
import { headerSafe, quoteBody, replySubject } from "../message/Message.js";
import { schedule } from "../message/Outbox.js";
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
    from: addressText(message.from),
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
/** @param {{send?:(draft:any, done:(result:any)=>void)=>any,notify?:()=>void,currentAccountId?:()=>string,onSent?:(payload:any)=>void}} dependencies */
export function createComposeController(dependencies) {
  const values = dependencies || {};
  let draft = clean({});
  let revision = 0;
  let status = "";
  let sending = false;
  /** @type {null | {payload:any,dueAt:number,revision:number}} */ let pending =
    null;
  /** @param {any} next */ function set(next) {
    // A delayed send is a snapshot, not a live draft.  Editing replaces that
    // snapshot; it must never later send what the user has changed away from.
    if (pending) {
      pending = null;
      sending = false;
    }
    draft = clean({ ...draft, ...next });
    revision += 1;
    status = "";
  }
  /** @param {any} payload @param {number} sentRevision */
  function deliver(payload, sentRevision) {
    sending = true;
    try {
      values.send?.(payload, (result) => {
        sending = false;
        if (
          sentRevision === revision &&
          (!payload.accountId ||
            payload.accountId === values.currentAccountId?.())
        )
          status =
            result?.ok === false
              ? String(result.error || "Send failed")
              : payload.save
                ? "Draft saved"
                : "Sent";
        if (
          result?.ok !== false &&
          payload.save &&
          result?.value?.id &&
          sentRevision === revision &&
          (!payload.accountId ||
            payload.accountId === values.currentAccountId?.())
        )
          draft = clean({ ...draft, draftId: result.value.id });
        if (
          result?.ok !== false &&
          !payload.save &&
          sentRevision === revision &&
          (!payload.accountId ||
            payload.accountId === values.currentAccountId?.())
        ) {
          draft = clean({ accountId: payload.accountId });
          revision += 1;
          values.onSent?.(payload);
        }
        values.notify?.();
      });
    } catch (error) {
      sending = false;
      if (sentRevision === revision)
        status = error instanceof Error ? error.message : "Send failed";
      values.notify?.();
    }
  }
  return {
    /** @param {any} [next] */ compose(next = {}) {
      set({
        accountId: next.accountId,
        threadId: "",
        messageId: "",
        inReplyTo: "",
        references: "",
        from: "",
        originalTo: "",
        originalCc: "",
        ...next,
        mode: "new",
      });
      return this.snapshot();
    },
    /** @param {any} [next] */ mailto(next = {}) {
      set({
        threadId: "",
        messageId: "",
        inReplyTo: "",
        references: "",
        from: "",
        originalTo: "",
        originalCc: "",
        ...next,
        mode: "mailto",
      });
      return this.snapshot();
    },
    /** @param {any} [message] */ draft(message = {}) {
      set({
        accountId: message.accountId,
        draftId: message.draftId,
        mode: "new",
        to: addressText(message.to),
        cc: addressText(message.cc),
        bcc: addressText(message.bcc),
        subject: message.subject === "(no subject)" ? "" : message.subject,
        body: message.body,
      });
      return this.snapshot();
    },
    /** @param {any} [message] */ reply(message = {}) {
      set({
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
      set({
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
      set({
        accountId: message.accountId,
        threadId: "",
        messageId: "",
        inReplyTo: "",
        references: "",
        from: "",
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
    /** @param {string} message */ setStatus(message) {
      status = String(message);
      values.notify?.();
      return this.snapshot();
    },
    /** @param {number} [now] @param {number} [delay] */ send(
      now = Date.now(),
      delay = 0,
    ) {
      if (sending) return this.snapshot();
      const payload = clean(draft);
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
      const sentRevision = revision;
      const queued = schedule(payload, now, delay);
      pending = queued ? { ...queued, revision: sentRevision } : null;
      if (pending) {
        sending = true;
        status = "Sending…";
      } else deliver(payload, sentRevision);
      return this.snapshot();
    },
    /** @param {number} [now] @param {number} [delay] */
    save(now = Date.now(), delay = 0) {
      if (sending) return this.snapshot();
      const payload = { ...clean(draft), save: true };
      if (
        values.currentAccountId &&
        payload.accountId !== values.currentAccountId()
      ) {
        status = "This draft belongs to another account.";
        return this.snapshot();
      }
      const queued = schedule(payload, now, delay);
      pending = queued ? { ...queued, revision } : null;
      if (pending) {
        sending = true;
        status = "Saving draft…";
      } else deliver(payload, revision);
      return this.snapshot();
    },
    /** @param {number} [now] @param {number} [expectedDueAt] */ flush(
      now = Date.now(),
      expectedDueAt,
    ) {
      if (
        pending &&
        (expectedDueAt === undefined || pending.dueAt === expectedDueAt) &&
        pending.dueAt <= now
      ) {
        const queued = pending;
        pending = null;
        sending = false;
        deliver(queued.payload, queued.revision);
      }
      return this.snapshot();
    },
    undo() {
      pending = null;
      sending = false;
      status = "";
      return this.snapshot();
    },
    discard() {
      pending = null;
      sending = false;
      draft = clean({});
      revision += 1;
      status = "";
      return this.snapshot();
    },
    snapshot() {
      return { draft, revision, pending, sending, status };
    },
  };
}
