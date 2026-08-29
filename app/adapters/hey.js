// @ts-check

import * as Registry from "../providers/Registry.js";
import * as Cli from "../providers/HeyCli.js";
import { redactError } from "./effect-port.js";

/** @param {any} operation */
function identityOf(operation) {
  return operation && operation.identity ? operation.identity : {};
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
    error: "HEY cannot " + action + " messages",
    refused: true,
    identity,
  };
}

/** @param {any} reply */
function errorFor(reply) {
  return redactError(
    Cli.commandError(
      reply.status,
      reply.stdout,
      reply.stderr,
      redactError(reply.error),
    ),
  );
}

/** @param {any} result @param {any} operation */
function normalizeListResult(result, operation) {
  if (!result || !result.ok) return result;
  const value = result.value;
  const parsed = Cli.parseQuery(operation.query);
  const rows = Array.isArray(value?.messages)
    ? value.messages
    : Cli.parseListing(value);
  const page = Cli.pageOf(
    parsed,
    value,
    Cli.filterRows(parsed, rows),
    operation.maxResults,
    operation.pageToken,
  );
  return {
    ...result,
    value: { messages: page.rows, nextPageToken: page.nextPageToken },
  };
}

/** @param {any} port */
export function createHeyAdapter(port) {
  if (!port || typeof port.dispatch !== "function")
    throw new TypeError("an effect port is required");

  return {
    /** @param {any} operation @param {(result: any) => void} [callback] */
    list(operation = {}, callback) {
      const identity = identityOf(operation);
      return port.dispatch(
        {
          kind: "hey.cli",
          scope: "list",
          accountId: identity.accountId,
          identity,
          args: Cli.listCommand(
            Cli.parseQuery(operation.query),
            operation.maxResults,
            operation.pageToken,
          ),
          stdin: "",
        },
        (/** @type {any} */ result) =>
          callback?.(normalizeListResult(result, operation)),
        errorFor,
      );
    },

    /** @param {any} operation @param {(result: any) => void} [callback] */
    action(operation = {}, callback) {
      const identity = identityOf(operation);
      const action = String(operation.action || "");
      const capability = capabilityFor(action);
      if (capability && !Registry.can("hey", capability)) {
        const result = refusal(action, identity);
        if (typeof callback === "function") callback(result);
        return { cancel() {} };
      }
      const args = Cli.actionCommand(action, operation.ids);
      if (args.length === 0) {
        const result = refusal(action || "change", identity);
        if (typeof callback === "function") callback(result);
        return { cancel() {} };
      }
      if (typeof operation.onOptimistic === "function")
        operation.onOptimistic();
      return port.dispatch(
        {
          kind: "hey.cli",
          scope: "object",
          accountId: identity.accountId,
          identity,
          args,
          stdin: "",
        },
        callback,
        errorFor,
      );
    },

    /** @param {any} operation @param {(result: any) => void} [callback] */
    detail(operation = {}, callback) {
      const identity = identityOf(operation);
      return port.dispatch(
        {
          kind: "hey.cli",
          scope: "object",
          accountId: identity.accountId,
          identity,
          args: Cli.threadCommand(identity.objectId),
          stdin: "",
        },
        callback,
        errorFor,
      );
    },
  };
}
