// @ts-check

const FIXED_ERROR = "Setup host failed";

// The longest reason worth putting on one status line. A host writes short
// sentences; anything longer did not come from one.
const MAX_REASON = 160;

/**
 * `providers/OAuth.js`'s `redact`, on the same journey it was written for.
 *
 * Every message a setup host produces is a fixed string the host chose —
 * `SetupError::message` in `src/gmail_setup.rs` returns `&'static str`, and the
 * IMAP and HEY hosts answer from their own closed vocabularies — so none of
 * them carries request, reply or credential text. This is still the last gate
 * before a label, and the rule is that anything which *could* carry a
 * credential passes through here first: a reason is only worth showing if
 * showing it can never cost one.
 * @param {string} text
 */
function redact(text) {
  return text
    .replace(
      // `code` as well as the list the QML redacts: an authorization code is
      // the one credential that reaches this side as a bare query parameter.
      /(refresh_token|access_token|code_verifier|client_secret|id_token|code)=[^&\s"']+/gi,
      "$1=[redacted]",
    )
    .replace(
      /"(refresh_token|access_token|code_verifier|client_secret|id_token)"\s*:\s*"[^"]*"/gi,
      '"$1":"[redacted]"',
    );
}

/**
 * What the host said went wrong, or nothing.
 *
 * Nothing rather than a guess: a reply that is not a plain short line is a
 * reply this cannot vouch for, and the caller falls back to its own wording.
 * @param {unknown} value
 */
function reason(value) {
  if (typeof value !== "string") return "";
  // A control character never appears in a host's own vocabulary. One here
  // means the string came from somewhere else, and a label is not the place to
  // find out where.
  if (/[\u0000-\u001f\u007f]/.test(value)) return "";
  const text = redact(value.trim());
  return text.length > 0 && text.length <= MAX_REASON ? text : "";
}

/**
 * The host's refusal, carried rather than flattened.
 *
 * `.reason` is the part a caller may show. `.message` is for a developer and is
 * never drawn, because it is also what an ordinary JavaScript fault would carry
 * and that is not a sentence anybody should read off a setup page.
 * @param {unknown} said
 */
function hostError(said) {
  const text = reason(said);
  const error = new Error(text || FIXED_ERROR);
  if (text) /** @type {any} */ (error).reason = text;
  return error;
}

/** @param {unknown} value */
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : null;
}

/** @param {unknown} value */
// The host's own ceiling, mirrored here so a request it would refuse is
// refused before it is sent. A browser sign-in is a person's deadline — they
// pick an account, read an unverified-app warning and tick three consent boxes
// — so it is minutes, not the seconds a round trip gets.
const MAX_DEADLINE_MS = 300000;

/** @param {unknown} value */
function deadline(value) {
  const milliseconds = Number(value);
  if (
    !Number.isInteger(milliseconds) ||
    milliseconds <= 0 ||
    milliseconds > MAX_DEADLINE_MS
  )
    throw new Error(FIXED_ERROR);
  return milliseconds;
}

/** @param {(request:string)=>Promise<string>} dispatch @param {Record<string,unknown>} request */
async function call(dispatch, request) {
  // Three outcomes, not one. The refusal a host *wrote* is the only one worth
  // showing, and wrapping the whole body in a single `catch` used to throw the
  // fixed error over the top of it — so a host that said exactly what was wrong
  // reached the page as "Setup failed".
  let raw;
  try {
    raw = await dispatch(JSON.stringify(request));
  } catch (_) {
    throw new Error(FIXED_ERROR);
  }
  let reply;
  try {
    reply = object(JSON.parse(raw));
  } catch (_) {
    throw new Error(FIXED_ERROR);
  }
  if (!reply || reply.ok !== true) throw hostError(reply?.error);
  return reply;
}

/** @param {unknown} outcome @param {unknown} [said] the host's own reason */
function credentialError(outcome, said) {
  const standing =
    outcome === "beforeEffect"
      ? "Credential was not changed"
      : "Credential state uncertain";
  const error = new Error(standing);
  /** @type {any} */ (error).credentialOutcome =
    outcome === "beforeEffect" ? "beforeEffect" : "uncertain";
  // What happened to the credential and why are two different facts, and the
  // page needs both: "Credential was not changed" without a reason leaves
  // somebody pressing the same button again.
  const text = reason(said);
  /** @type {any} */ (error).reason = text ? `${standing} — ${text}` : standing;
  return error;
}

/** @param {(request:string)=>Promise<string>} dispatch @param {Record<string,unknown>} request */
async function deleteCredential(dispatch, request) {
  let raw;
  try {
    raw = await dispatch(JSON.stringify(request));
  } catch (_) {
    throw credentialError("uncertain");
  }
  let reply;
  try {
    reply = object(JSON.parse(raw));
  } catch (_) {
    throw credentialError("uncertain");
  }
  if (!reply || reply.ok !== true)
    throw credentialError(reply?.credentialOutcome, reply?.error);
  const outcome = object(reply.data)?.outcome;
  if (outcome !== "deleted" && outcome !== "notFound")
    throw credentialError("uncertain");
  return { outcome };
}

/**
 * @param {{gmail:(request:string)=>Promise<string>,imap:(request:string)=>Promise<string>,hey:(request:string)=>Promise<string>}} modules
 */
export function createSetupAdapters(modules) {
  if (
    !modules ||
    [modules.gmail, modules.imap, modules.hey].some(
      (entry) => typeof entry !== "function",
    )
  )
    throw new TypeError("setup host modules are required");
  return {
    gmail: {
      /** @param {number} deadlineMs */
      async begin(deadlineMs) {
        const reply = await call(modules.gmail, {
          operation: "gmail.oauth.begin",
          deadlineMs: deadline(deadlineMs),
        });
        if (
          typeof reply.flowId !== "string" ||
          !reply.flowId ||
          typeof reply.url !== "string" ||
          !reply.url.startsWith("https://accounts.google.com/")
        )
          throw new Error(FIXED_ERROR);
        return { flowId: reply.flowId, url: reply.url };
      },
      /** @param {string} flowId */
      async status(flowId) {
        const reply = await call(modules.gmail, {
          operation: "gmail.oauth.status",
          flowId: String(flowId),
        });
        if (reply.status !== "pending" && reply.status !== "completed")
          throw new Error(FIXED_ERROR);
        return reply.status === "pending"
          ? { status: "pending" }
          : { status: "completed", account: reply.account };
      },
      /** @param {string} flowId */
      async cancel(flowId) {
        await call(modules.gmail, {
          operation: "gmail.oauth.cancel",
          flowId: String(flowId),
        });
        return {};
      },
      /**
       * The Google OAuth client every Gmail mailbox signs in through. It is one
       * client for the whole app rather than one per account, which is why
       * adding a second mailbox never asks for another.
       */
      /**
       * @param {{includeSecret?: boolean}} [options] the setup page asks for
       * the secret so its field can show what is stored; the settings page
       * does not, so it never holds one.
       */
      async readClient(options = {}) {
        const includeSecret = options.includeSecret === true;
        const reply = await call(modules.gmail, {
          operation: "gmail.oauth.client",
          includeSecret,
        });
        const data = object(reply.data) ?? {};
        return {
          present: data.present === true,
          clientId: String(data.clientId ?? ""),
          description: String(data.description ?? ""),
          ...(includeSecret
            ? { clientSecret: String(data.clientSecret ?? "") }
            : {}),
        };
      },
      /**
       * The secret is optional: Google's desktop clients may have none, and an
       * empty one is stored as absent rather than as an empty secret.
       * @param {string} clientId @param {string} clientSecret
       */
      async saveClient(clientId, clientSecret) {
        const id = String(clientId || "").trim();
        if (!id) throw credentialError("beforeEffect");
        await call(modules.gmail, {
          operation: "gmail.oauth.saveClient",
          clientId: id,
          clientSecret: String(clientSecret || "").trim(),
        });
        return {};
      },
      /** @param {string} accountId @param {string} clientId */
      async revokeLocal(accountId, clientId) {
        if (!String(accountId) || !String(clientId))
          throw credentialError("beforeEffect");
        return deleteCredential(modules.gmail, {
          operation: "gmail.oauth.revokeLocal",
          accountId: String(accountId),
          clientId: String(clientId),
        });
      },
    },
    imap: {
      /** @param {Record<string,unknown>} form @param {number} deadlineMs */
      async verifyAndStore(form, deadlineMs) {
        const fields = object(form);
        if (!fields) throw new Error(FIXED_ERROR);
        const reply = await call(modules.imap, {
          ...fields,
          operation: "imap.setup.verifyAndStore",
          deadlineMs: deadline(deadlineMs),
        });
        const data = object(reply.data);
        if (!data || !object(data.account)) throw new Error(FIXED_ERROR);
        return { account: data.account, context: object(data.context) };
      },
      /** @param {unknown} descriptor */
      async forgetCredential(descriptor) {
        const fields = object(descriptor);
        if (
          !fields ||
          !String(fields.accountId || "") ||
          !String(fields.imapHost || "") ||
          !String(fields.username || "") ||
          !Number.isInteger(Number(fields.imapPort))
        )
          throw credentialError("beforeEffect");
        return deleteCredential(modules.imap, {
          operation: "imap.setup.forgetCredential",
          ...fields,
        });
      },
    },
    hey: {
      /** @param {number} deadlineMs */
      async status(deadlineMs) {
        const reply = await call(modules.hey, {
          operation: "hey.auth.status",
          deadlineMs: deadline(deadlineMs),
        });
        const data = object(reply.data);
        if (
          !data ||
          typeof data.authenticated !== "boolean" ||
          typeof data.expired !== "boolean"
        )
          throw new Error(FIXED_ERROR);
        return { authenticated: data.authenticated, expired: data.expired };
      },
      /** @param {number} deadlineMs */
      async accounts(deadlineMs) {
        const reply = await call(modules.hey, {
          operation: "hey.auth.accounts",
          deadlineMs: deadline(deadlineMs),
        });
        const data = object(reply.data);
        if (!data || !Array.isArray(data.accounts))
          throw new Error(FIXED_ERROR);
        return { accounts: data.accounts };
      },
      async login() {
        const reply = await call(modules.hey, { operation: "hey.auth.login" });
        const data = object(reply.data);
        if (!data || data.launched !== true) throw new Error(FIXED_ERROR);
        return { launched: true };
      },
      /** @param {number} deadlineMs */
      async logout(deadlineMs) {
        const reply = await call(modules.hey, {
          operation: "hey.auth.logout",
          deadlineMs: deadline(deadlineMs),
        });
        const data = object(reply.data);
        if (!data || data.machineGlobal !== true) throw new Error(FIXED_ERROR);
        return { machineGlobal: true };
      },
    },
  };
}
