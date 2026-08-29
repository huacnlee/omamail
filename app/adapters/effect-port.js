// @ts-check

/** @typedef {{ accountId: string, query: string, objectId: string, revision: number }} RequestIdentity */
/** @typedef {{ kind: string, accountId?: string, identity?: Partial<RequestIdentity>, [key: string]: any }} Effect */
/** @typedef {{ ok?: boolean, status?: number, error?: string, value?: any, identity?: Partial<RequestIdentity>, [key: string]: any }} EffectReply */

/** @param {unknown} value */
function string(value) {
  return String(value === undefined || value === null ? "" : value);
}

var SENSITIVE_ASSIGNMENT_KEY = "(?:pass(?:word)?|pwd|api[_-]?key|access[_-]?key|secret[_-]?key|auth|cookie|token|credential)";
/** @type {Readonly<Record<string, boolean>>} */
var SENSITIVE_KEYS = Object.freeze({
  pass: true,
  password: true,
  pwd: true,
  apikey: true,
  accesskey: true,
  secretkey: true,
  authorization: true,
  auth: true,
  cookie: true,
  token: true,
  accesstoken: true,
  refreshtoken: true,
  idtoken: true,
  credential: true,
  credentials: true,
  clientsecret: true,
});

/** @param {string} key */
function isSensitiveKey(key) {
  var normalized = string(key).toLowerCase().replace(/[\s_-]/g, "");
  return SENSITIVE_KEYS[normalized] === true;
}

/** @param {string} value */
function redactPlainText(value) {
  var assignment = new RegExp(
    "((?:[\\\"']?\\b" + SENSITIVE_ASSIGNMENT_KEY + "\\b[\\\"']?)\\s*[=:]\\s*)"
      + "(?:\\\"(?:\\\\.|[^\\\"\\\\])*\\\"|'(?:\\\\.|[^'\\\\])*'|[^,;\\n]*?)"
      + "(?=\\s*(?:[,;\\n]|$)|\\s+(?:[\\\"']?" + SENSITIVE_ASSIGNMENT_KEY + "[\\\"']?\\s*[=:]))",
    "gi",
  );
  return value
    .replace(/(Authorization\s*:\s*)(Bearer|Basic)\s+\S+/gi, "$1$2 [redacted]")
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [redacted]")
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1[redacted]@")
    .replace(assignment, "$1[redacted]");
}

/** @param {unknown} value @param {number} [depth] @returns {any} */
function redactValue(value, depth = 0) {
  if (depth > 8) return "[redacted]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactPlainText(value);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, depth + 1));
  const object = /** @type {Record<string, unknown>} */ (value);
  const out = /** @type {Record<string, unknown>} */ ({});
  Object.keys(object).forEach((key) => {
    out[key] = isSensitiveKey(key) ? "[redacted]" : redactValue(object[key], depth + 1);
  });
  return out;
}

/** @param {string} value */
function decodeEscapedText(value) {
  if (value.indexOf('\\"') < 0) return value;
  try {
    // The whole payload is escaped once by a transport. JSON parses that one
    // string layer without evaluating it; it is never executable input.
    return JSON.parse('"' + value + '"');
  } catch (_) {
    return value;
  }
}

/** @param {string} value */
function parseDiagnosticJson(value) {
  try {
    return JSON.parse(value);
  } catch (_) {
    var decoded = decodeEscapedText(value);
    if (decoded === value) return null;
    try {
      return JSON.parse(decoded);
    } catch (_) {
      return null;
    }
  }
}

/** @param {string} value */
function redactText(value) {
  var parsed = parseDiagnosticJson(value);
  if (parsed && typeof parsed === "object") return JSON.stringify(redactValue(parsed));
  return redactPlainText(decodeEscapedText(value));
}

/** @param {unknown} value @param {number} [depth] @returns {string} */
export function redactError(value, depth = 0) {
  if (depth > 8) return "[redacted]";
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return redactText(String(value));
  if (Array.isArray(value))
    return value.map((entry) => redactError(entry, depth + 1)).join(", ");
  if (typeof value === "object") {
    const object = /** @type {Record<string, unknown>} */ (value);
    return Object.keys(object).map((key) => {
      const sensitive = isSensitiveKey(key);
      return key + ": " + (sensitive ? "[redacted]" : redactError(object[key], depth + 1));
    }).join(", ");
  }
  return redactText(String(value));
}

/** @param {Partial<RequestIdentity>} [values] @returns {RequestIdentity} */
export function requestIdentity(values = {}) {
  return Object.freeze({
    accountId: string(values.accountId),
    query: string(values.query),
    objectId: string(values.objectId),
    revision: Number.isFinite(Number(values.revision)) ? Number(values.revision) : 0,
  });
}

/** @param {Effect} effect @param {EffectReply} reply @param {(reply: EffectReply) => string} [errorFor] */
function resultFor(effect, reply, errorFor) {
  const raw = reply || {};
  const succeeded = raw.ok !== false && (raw.ok === true ||
    (!string(raw.error) && Number(raw.status) >= 200 && Number(raw.status) < 300));
  const error = succeeded ? "" : redactError(typeof errorFor === "function" ? errorFor(raw) : raw.error);
  return {
    ok: succeeded,
    value: raw.value === undefined ? null : raw.value,
    error,
    identity: effect.identity,
  };
}

/** @param {Effect} effect */
function scopeFor(effect) {
  return effect.scope === "object" ? "object" : "list";
}

/** @param {RequestIdentity} left @param {RequestIdentity} right @param {"list" | "object"} scope */
function sameIdentity(left, right, scope) {
  if (left.accountId !== right.accountId || left.revision !== right.revision) return false;
  if (scope === "list") return left.query === right.query;
  return right.objectId === "" || left.objectId === right.objectId;
}

/** @param {Effect} effect */
function discardedResult(effect) {
  return {
    ok: false,
    value: null,
    error: "Request result was discarded",
    discarded: true,
    cancelled: true,
    identity: effect.identity,
  };
}

/**
 * @param {(effect: Effect, complete: (reply: EffectReply) => void) => any} execute
 * @param {() => Partial<RequestIdentity>} currentIdentity
 */
export function createEffectPort(execute, currentIdentity) {
  if (typeof execute !== "function") throw new TypeError("an effect executor is required");
  if (typeof currentIdentity !== "function") throw new TypeError("a current identity getter is required");

  return {
    /**
     * @param {Effect} effect
     * @param {(result: any) => void} [callback]
     * @param {(reply: EffectReply) => string} [errorFor]
      */
    dispatch(effect, callback, errorFor) {
      const request = { ...effect, identity: requestIdentity(effect && effect.identity) };
      const scope = scopeFor(request);
      let settled = false;
      function discard() {
        if (settled) return;
        settled = true;
        if (typeof callback === "function") callback(discardedResult(request));
      }
      return execute(request, (reply) => {
        if (settled) return;
        const returnedIdentity = reply && reply.identity
          ? requestIdentity(reply.identity)
          : request.identity;
        if (!sameIdentity(request.identity, returnedIdentity, scope)) return discard();
        if (!sameIdentity(request.identity, requestIdentity(currentIdentity()), scope)) return discard();
        settled = true;
        if (typeof callback === "function") callback(resultFor(request, reply, errorFor));
      });
    },
  };
}
