// @ts-check

import * as Protocol from "../providers/ImapProtocol.js";
import * as Registry from "../providers/Registry.js";
import * as Calendar from "../message/Calendar.js";
import * as Message from "../message/Message.js";
import * as Unsubscribe from "../message/Unsubscribe.js";
import { redactError } from "./effect-port.js";

/** @param {any} operation */
function identityOf(operation) {
  return operation && operation.identity ? operation.identity : {};
}

/** @param {any} reply */
function errorFor(reply) {
  return redactError(
    Protocol.responseError(
      reply.status,
      redactError(reply.detail || reply.error),
      redactError(reply.error),
    ),
  );
}

/** @param {any} result @param {any} identity @param {string} folder @param {boolean} detail */
/** @param {any} result @param {any} identity @param {string} folder @param {boolean} detail @param {any} specialFolders */
function normalizeTransportResult(
  result,
  identity,
  folder,
  detail,
  specialFolders,
) {
  if (!result || !result.ok) return result;
  const encoded = result.value?.responseBase64;
  if (typeof encoded !== "string" || encoded.length === 0)
    return {
      ok: false,
      value: null,
      error: "Mail host returned invalid message data",
      identity: result.identity,
    };
  const bytes = Message.base64ToBytes(encoded);
  const text = Message.bytesToLatin1(bytes);
  const literal = /BODY\[[^\]]*\]\s*(?:<\d+>)?\s*\{(\d+)\+?\}\r\n/g;
  let match;
  while ((match = literal.exec(text))) {
    const end = literal.lastIndex + Number(match[1]);
    if (
      !Number.isSafeInteger(Number(match[1])) ||
      end >= bytes.length ||
      bytes[end] !== 41
    )
      return {
        ok: false,
        value: null,
        error: "Mail host returned invalid message data",
        identity: result.identity,
      };
  }
  const fetched = Protocol.parseFetch(text);
  const resources = fetched.map((item) => {
    if (!item.raw) return null;
    return {
      id: `${item.uid}:${folder}`,
      payload: Message.parseRfc822(item.raw),
      labelIds: Protocol.labelIdsFor(item.flags, folder, specialFolders || {}),
      internalDate: item.internalDate,
      sizeEstimate: item.size,
    };
  });
  if (resources.length === 0 || resources.some((item) => !item))
    return {
      ok: false,
      value: null,
      error: "Mail host returned invalid message data",
      identity: result.identity,
    };
  const messages = resources.filter((resource) => resource !== null);
  const summaries = messages.map((resource) => Message.summarize(resource));
  if (!detail) return { ...result, value: { messages: summaries } };
  if (summaries.length !== 1 || summaries[0].id !== identity.objectId)
    return {
      ok: false,
      value: null,
      error: "Mail host returned invalid message data",
      identity: result.identity,
    };
  const body = Message.extractBody(messages[0].payload);
  const attachments = Message.attachments(messages[0].payload).map(
    (attachment) => ({
      ...attachment,
      partId: attachment.attachmentId,
      data: String(
        /** @type {any} */ (
          Message.partForAttachment(
            messages[0].payload,
            attachment.attachmentId,
          )
        )?.body?.data ?? "",
      ),
    }),
  );
  return {
    ...result,
    value: {
      ...summaries[0],
      body: body.text,
      html: Message.extractHtml(messages[0].payload),
      attachments,
      // A detail read here is `BODY.PEEK[]` — the whole message — so both of
      // these are answered by the fetch that brought the body, with no second
      // request of the kind Gmail needs. Read off the same MIME tree the body
      // and the attachments came from, once.
      invite: Calendar.fromPayload(messages[0].payload),
      unsubscribe: Unsubscribe.fromMessage(messages[0]),
    },
  };
}

/** @param {string} action */
function capabilityFor(action) {
  if (action === "archive" || action === "unarchive") return "archive";
  if (action === "spam") return "spam";
  if (action === "star" || action === "unstar") return "star";
  return "";
}

/** @param {string} action @param {any} identity */
function refusal(action, identity) {
  return {
    ok: false,
    value: null,
    error:
      "IMAP cannot " +
      (action === "spam" ? "report spam" : action + " messages"),
    refused: true,
    identity,
  };
}

/** @param {any} group @param {any} plan @param {any} operation */
function commandsFor(group, plan, operation) {
  const stored = Protocol.storeCommand(group.uids, plan.add, plan.remove);
  const commands = Array.isArray(stored)
    ? stored.slice()
    : stored
      ? [stored]
      : [];
  if (plan.move && plan.move !== group.folder) {
    if (Protocol.hasCapability(operation.serverCapabilities, "MOVE")) {
      commands.push(Protocol.moveCommand(group.uids, plan.move));
    } else {
      commands.push(
        Protocol.copyCommand(group.uids, plan.move),
        ...Protocol.storeCommand(group.uids, ["\\Deleted"], []),
        Protocol.expungeCommand(group.uids),
      );
    }
  }
  return commands;
}

/** @param {any} port @param {Array<any>} effects @param {any} callback */
function dispatchAll(port, effects, callback) {
  let remaining = effects.length;
  let firstFailure = /** @type {any} */ (null);
  const handles = effects.map((effect) =>
    port.dispatch(
      effect,
      (/** @type {any} */ result) => {
        if (!result.ok && !firstFailure) firstFailure = result;
        remaining -= 1;
        if (remaining === 0 && typeof callback === "function") {
          callback(
            firstFailure || {
              ok: true,
              value: null,
              error: "",
              identity: effect.identity,
            },
          );
        }
      },
      errorFor,
    ),
  );
  return {
    cancel() {
      handles.forEach((handle) => {
        if (handle && typeof handle.cancel === "function") handle.cancel();
      });
    },
  };
}

/** @param {any} port */
export function createImapAdapter(port) {
  if (!port || typeof port.dispatch !== "function")
    throw new TypeError("an effect port is required");

  let runtime =
    /** @type {{specialUse:Record<string,string>,supportsMove:boolean}} */ ({
      specialUse: {},
      supportsMove: false,
    });
  const allowed = new Set([
    "\\all",
    "\\archive",
    "\\drafts",
    "\\junk",
    "\\sent",
    "\\trash",
  ]);
  /** @param {any} value */
  function checkedRuntime(value) {
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.supportsMove !== "boolean"
    )
      return null;
    const source = value.specialUse;
    if (!source || typeof source !== "object" || Array.isArray(source))
      return null;
    const specialUse = /** @type {Record<string,string>} */ ({});
    for (const key of Object.keys(source)) {
      const folder = source[key];
      if (
        allowed.has(key) &&
        typeof folder === "string" &&
        folder.length > 0 &&
        folder.length <= 4096 &&
        !/[\0-\x1f\x7f]/.test(folder)
      )
        specialUse[key] = folder;
    }
    return { specialUse, supportsMove: value.supportsMove };
  }
  return {
    /** @param {any} [operation] @param {(result:any)=>void} [callback] */
    runtime(operation = {}, callback) {
      const identity = identityOf(operation);
      return port.dispatch(
        {
          kind: "imap.runtime",
          scope: "list",
          accountId: identity.accountId,
          identity,
        },
        (/** @type {any} */ result) => {
          if (result.ok) {
            const checked = checkedRuntime(result.value);
            if (!checked)
              return callback?.({
                ...result,
                ok: false,
                value: null,
                error: "Mail host returned invalid IMAP capabilities",
              });
            runtime = checked;
            return callback?.({ ...result, value: checked });
          }
          callback?.(result);
        },
        errorFor,
      );
    },
    /** @param {any} operation @param {(result: any) => void} [callback] */
    list(operation = {}, callback) {
      const identity = identityOf(operation);
      const query = Protocol.parseQuery(operation.query);
      return port.dispatch(
        {
          kind: "imap.list",
          scope: "list",
          accountId: identity.accountId,
          identity,
          hostOperation: {
            type: "list",
            folder: query.folder,
            criteria: query.criteria,
            maxResults: Number(operation.maxResults) || 25,
            pageToken: String(operation.pageToken || ""),
          },
          folder: query.folder,
          criteria: query.criteria,
          maxResults: Number(operation.maxResults) || 25,
          pageToken: operation.pageToken,
        },
        (/** @type {any} */ result) =>
          callback?.(
            normalizeTransportResult(
              result,
              identity,
              query.folder,
              false,
              runtime.specialUse,
            ),
          ),
        errorFor,
      );
    },

    /** @param {any} operation @param {(result: any) => void} [callback] */
    detail(operation = {}, callback) {
      const identity = identityOf(operation);
      const parsed = Protocol.parseMessageId(identity.objectId);
      if (parsed.uid < 1 || !parsed.folder) return { cancel() {} };
      return port.dispatch(
        {
          kind: "imap.transport",
          scope: "object",
          accountId: identity.accountId,
          identity,
          hostOperation: {
            type: "detail",
            messageId: identity.objectId,
            full: operation.full === true,
          },
          folder: parsed.folder,
          commands: [
            operation.full === true
              ? Protocol.fullFetchCommand([parsed.uid])
              : Protocol.summaryFetchCommand([parsed.uid]),
          ],
        },
        (/** @type {any} */ result) =>
          callback?.(
            normalizeTransportResult(
              result,
              identity,
              parsed.folder,
              true,
              runtime.specialUse,
            ),
          ),
        errorFor,
      );
    },

    /** @param {any} operation @param {(result: any) => void} [callback] */
    action(operation = {}, callback) {
      const identity = identityOf(operation);
      const ids = Array.isArray(operation.ids) ? operation.ids : [];
      const action = String(operation.action || "");
      const capability = capabilityFor(action);
      if (capability && !Registry.can("imap", capability)) {
        const result = refusal(action, identity);
        if (typeof callback === "function") callback(result);
        return { cancel() {} };
      }
      const plan = Protocol.actionPlan(action, runtime.specialUse);
      const groups = Protocol.groupByFolder(ids);
      const needsFolder = action === "archive" || action === "trash";
      if (!plan || groups.length === 0 || (needsFolder && !plan.move)) {
        const result = refusal(action || "change", identity);
        if (typeof callback === "function") callback(result);
        return { cancel() {} };
      }
      if (typeof operation.onOptimistic === "function")
        operation.onOptimistic();
      const effects = groups.map((group) => ({
        kind: "imap.transport",
        scope: "object",
        accountId: identity.accountId,
        identity,
        hostOperation: {
          type: "action",
          action,
          messageIds: group.uids.map(
            (/** @type {number} */ uid) => `${uid}:${group.folder}`,
          ),
          destination: String(plan.move || ""),
        },
        folder: group.folder,
        commands: commandsFor(group, plan, {
          serverCapabilities: runtime.supportsMove ? ["MOVE"] : [],
        }),
      }));
      return dispatchAll(port, effects, callback);
    },
  };
}
