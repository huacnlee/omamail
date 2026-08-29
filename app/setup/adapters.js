// @ts-check

const FIXED_ERROR = "Setup host failed";

/** @param {unknown} value */
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : null;
}

/** @param {unknown} value */
function deadline(value) {
  const milliseconds = Number(value);
  if (
    !Number.isInteger(milliseconds) ||
    milliseconds <= 0 ||
    milliseconds > 120000
  )
    throw new Error(FIXED_ERROR);
  return milliseconds;
}

/** @param {(request:string)=>Promise<string>} dispatch @param {Record<string,unknown>} request */
async function call(dispatch, request) {
  try {
    const reply = object(JSON.parse(await dispatch(JSON.stringify(request))));
    if (!reply || reply.ok !== true) throw new Error(FIXED_ERROR);
    return reply;
  } catch (_) {
    throw new Error(FIXED_ERROR);
  }
}

/** @param {unknown} outcome */
function credentialError(outcome) {
  const error = new Error(
    outcome === "beforeEffect"
      ? "Credential was not changed"
      : "Credential state uncertain",
  );
  /** @type {any} */ (error).credentialOutcome =
    outcome === "beforeEffect" ? "beforeEffect" : "uncertain";
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
    throw credentialError(reply?.credentialOutcome);
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
