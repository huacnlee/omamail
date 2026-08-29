// @ts-check

const PROVIDERS = Object.freeze({ gmail: true, imap: true, hey: true });
const BUSY = Object.freeze(["authenticating", "verifying", "committing"]);

/** @param {unknown} value */
function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : null;
}

/** @param {unknown} value @param {string} provider @returns {any} */
function safeAccount(value, provider) {
  const account = plain(value);
  const id = String(account?.id || "");
  const email = String(account?.email || account?.address || "").toLowerCase();
  const label = String(account?.label || email);
  if (!id || !email || (account?.provider && account.provider !== provider))
    return null;
  if (provider === "gmail") {
    const clientId = String(account?.clientId || "");
    if (id !== email || !clientId.endsWith(".apps.googleusercontent.com"))
      return null;
    return { id, email, provider, clientId, label };
  }
  if (provider === "imap") {
    const imap = plain(account?.imap);
    const username = String(imap?.username || "");
    const imapHost = String(imap?.imapHost || "");
    const smtpHost = String(imap?.smtpHost || "");
    const imapPort = Number(imap?.imapPort);
    const smtpPort = Number(imap?.smtpPort);
    if (
      id !== `imap:${email}` ||
      !username ||
      !imapHost ||
      !smtpHost ||
      !Number.isInteger(imapPort) ||
      !Number.isInteger(smtpPort) ||
      imapPort < 1 ||
      imapPort > 65535 ||
      smtpPort < 1 ||
      smtpPort > 65535
    )
      return null;
    return {
      id,
      email,
      provider,
      label,
      imap: {
        username,
        imapHost,
        imapPort,
        smtpHost,
        smtpPort,
        insecure: imap?.insecure === true,
      },
    };
  }
  if (provider === "hey" && id === `hey:${email}`)
    return { id, email, provider, label };
  return null;
}

/** @param {unknown} value @param {string} provider @param {any} account */
function safeContext(value, provider, account) {
  const context = plain(value);
  if (provider === "gmail") {
    const clientId = String(context?.clientId || account?.clientId || "");
    const grant = String(
      context?.grant || "gmail.modify gmail.send calendar.events",
    );
    if (context?.accountId && context.accountId !== account.id) return null;
    if (!clientId.endsWith(".apps.googleusercontent.com") || !grant)
      return null;
    return { kind: "gmail", accountId: account.id, clientId, grant };
  }
  if (provider === "imap") {
    if (
      context?.kind !== "imap" ||
      context?.accountId !== account.id ||
      context?.email !== account.email
    )
      return null;
    const imap = account.imap;
    for (const key of [
      "username",
      "imapHost",
      "imapPort",
      "smtpHost",
      "smtpPort",
      "insecure",
    ])
      if (context[key] !== imap[key]) return null;
    return {
      kind: "imap",
      accountId: account.id,
      email: account.email,
      username: imap.username,
      imapHost: imap.imapHost,
      imapPort: imap.imapPort,
      smtpHost: imap.smtpHost,
      smtpPort: imap.smtpPort,
      insecure: imap.insecure,
    };
  }
  return provider === "hey" ? { kind: "hey", accountId: account.id } : null;
}

/** @param {any} adapters */
export function createSetupController(adapters) {
  if (!adapters?.gmail || !adapters?.imap || !adapters?.hey)
    throw new TypeError("setup adapters are required");
  let revision = 0;
  let flowId = "";
  let state = /** @type {any} */ ({ phase: "choose", provider: "", error: "" });

  function snapshot() {
    return JSON.parse(JSON.stringify(state));
  }
  /** @param {number} token */
  function current(token) {
    return token === revision && state.phase !== "cancelled";
  }
  /** @param {unknown} _error */
  function fail(_error) {
    state = { phase: "error", provider: state.provider, error: "Setup failed" };
    return snapshot();
  }
  /** @param {any} account @param {any} context */
  function ready(account, context) {
    const normalized = safeAccount(account, state.provider);
    if (!normalized) return fail(null);
    const cleanContext = safeContext(context, state.provider, normalized);
    if (!cleanContext) return fail(null);
    const compensation =
      state.provider === "gmail"
        ? {
            kind: "gmail",
            accountId: normalized.id,
            clientId: normalized.clientId,
          }
        : state.provider === "imap"
          ? {
              kind: "imap",
              accountId: normalized.id,
              imapHost: normalized.imap.imapHost,
              imapPort: normalized.imap.imapPort,
              username: normalized.imap.username,
            }
          : null;
    state = {
      phase: "ready",
      provider: state.provider,
      error: "",
      commitIntent: {
        account: normalized,
        context: cleanContext,
        compensation,
      },
    };
    return snapshot();
  }

  return {
    snapshot,
    /** @param {string} provider */
    choose(provider) {
      if (!Object.prototype.hasOwnProperty.call(PROVIDERS, provider))
        return fail(null);
      revision += 1;
      flowId = "";
      state = { phase: "form", provider, error: "" };
      return snapshot();
    },
    /** @param {Record<string,unknown>} form @param {number} deadlineMs */
    async submit(form = {}, deadlineMs = 30000) {
      if (BUSY.includes(String(state.phase))) return snapshot();
      if (state.phase !== "form" && state.phase !== "error") return snapshot();
      const token = ++revision;
      const provider = state.provider;
      try {
        if (provider === "gmail") {
          state = { phase: "authenticating", provider, error: "" };
          const result = await adapters.gmail.begin(deadlineMs);
          if (!current(token)) {
            if (result?.flowId)
              void adapters.gmail.cancel(result.flowId).catch(() => {});
            return snapshot();
          }
          flowId = result.flowId;
          state = {
            phase: "authenticating",
            provider,
            error: "",
            intent: { kind: "open-browser", url: result.url },
          };
        } else if (provider === "imap") {
          state = { phase: "verifying", provider, error: "" };
          const result = await adapters.imap.verifyAndStore(form, deadlineMs);
          if (!current(token)) {
            const account = safeAccount(result?.account, provider);
            if (account)
              await adapters.imap
                .forgetCredential({
                  accountId: account.id,
                  imapHost: account.imap.imapHost,
                  imapPort: account.imap.imapPort,
                  username: account.imap.username,
                })
                .catch(() => {});
            return snapshot();
          }
          state = { phase: "committing", provider, error: "" };
          return ready(result.account, result.context);
        } else if (provider === "hey") {
          state = { phase: "authenticating", provider, error: "" };
          await adapters.hey.login();
          if (!current(token)) return snapshot();
        } else return fail(null);
        return snapshot();
      } catch (error) {
        return current(token) ? fail(error) : snapshot();
      }
    },
    /** @param {number} deadlineMs */
    async poll(deadlineMs = 30000) {
      if (state.phase !== "authenticating" || !state.provider)
        return snapshot();
      const token = ++revision;
      const provider = state.provider;
      state = { phase: "verifying", provider, error: "" };
      try {
        if (provider === "gmail") {
          const result = await adapters.gmail.status(flowId);
          if (!current(token)) return snapshot();
          if (result.status === "pending") {
            state = { phase: "authenticating", provider, error: "" };
            return snapshot();
          }
          state = { phase: "committing", provider, error: "" };
          return ready(result.account, {
            provider: "gmail",
            accountId: String(result.account?.id || ""),
          });
        }
        if (provider === "hey") {
          const status = await adapters.hey.status(deadlineMs);
          if (!current(token)) return snapshot();
          if (!status.authenticated || status.expired) {
            state = { phase: "authenticating", provider, error: "" };
            return snapshot();
          }
          const result = await adapters.hey.accounts(deadlineMs);
          if (!current(token)) return snapshot();
          if (result.accounts.length === 0) return fail(null);
          if (result.accounts.length > 1) {
            const accounts = result.accounts
              .map((/** @type {any} */ account) => safeAccount(account, "hey"))
              .filter(Boolean);
            if (accounts.length !== result.accounts.length) return fail(null);
            state = {
              phase: "select-account",
              provider,
              error: "",
              accounts,
            };
            return snapshot();
          }
          state = { phase: "committing", provider, error: "" };
          const account = result.accounts[0];
          return ready(account, {
            provider: "hey",
            accountId: String(account?.id || ""),
          });
        }
        return fail(null);
      } catch (error) {
        return current(token) ? fail(error) : snapshot();
      }
    },
    /** @param {string} accountId */
    selectAccount(accountId) {
      if (state.provider !== "hey" || state.phase !== "select-account")
        return snapshot();
      const account = state.accounts.find(
        (/** @type {any} */ entry) => entry.id === accountId,
      );
      return account
        ? ready(account, { kind: "hey", accountId: account.id })
        : fail(null);
    },
    cancel() {
      const cancelledFlow = flowId;
      const provider = state.provider;
      revision += 1;
      flowId = "";
      state = { phase: "cancelled", provider, error: "" };
      if (provider === "gmail" && cancelledFlow)
        void adapters.gmail.cancel(cancelledFlow).catch(() => {});
      return snapshot();
    },
    /** @param {unknown} descriptor */
    async compensate(descriptor) {
      const value = plain(descriptor);
      try {
        if (value?.kind === "gmail")
          await adapters.gmail.revokeLocal(
            String(value.accountId),
            String(value.clientId),
          );
        else if (value?.kind === "imap")
          await adapters.imap.forgetCredential({
            accountId: String(value.accountId),
            imapHost: String(value.imapHost),
            imapPort: Number(value.imapPort),
            username: String(value.username),
          });
        else if (value?.kind !== null) throw new Error("invalid");
        return true;
      } catch (_) {
        return false;
      }
    },
    /** @param {number} deadlineMs */
    async logout(deadlineMs = 30000) {
      if (state.provider !== "hey" || BUSY.includes(String(state.phase)))
        return snapshot();
      const token = ++revision;
      try {
        const result = await adapters.hey.logout(deadlineMs);
        if (!current(token)) return snapshot();
        state = {
          phase: "form",
          provider: "hey",
          error: "",
          machineGlobal: result.machineGlobal === true,
        };
        return snapshot();
      } catch (error) {
        return current(token) ? fail(error) : snapshot();
      }
    },
  };
}
