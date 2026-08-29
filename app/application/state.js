// @ts-check

const PROVIDERS = new Set(["gmail", "hey", "imap"]);

/** @typedef {{ id: string, providerId: string, email?: string, label?: string }} Account */
/**
 * @typedef {{
 *   route: "setup" | "mail" | "settings" | "compose" | "calendar",
 *   previousRoute: "setup" | "mail" | "settings" | "compose" | "calendar",
 *   accounts: Account[],
 *   activeAccountId: string | null,
 *   setupProviderId: string | null,
 *   overlay: string | null
 * }} ApplicationState
 */

/** @returns {ApplicationState} */
export function createApplicationState() {
  return {
    route: "setup",
    previousRoute: "setup",
    accounts: [],
    activeAccountId: null,
    setupProviderId: null,
    overlay: null,
  };
}

/** @param {ApplicationState} state @param {any} event @returns {ApplicationState} */
export function reduceApplicationState(state, event) {
  if (event.type === "choose-provider") {
    if (!PROVIDERS.has(event.providerId)) throw new Error(`unknown provider: ${event.providerId}`);
    return { ...state, setupProviderId: event.providerId };
  }

  if (event.type === "accounts-loaded") {
    const accounts = /** @type {Account[]} */ (
      Array.isArray(event.accounts) ? event.accounts.slice() : []
    );
    const requested = accounts.find((account) => account.id === event.activeAccountId);
    return {
      ...state,
      route: accounts.length > 0 ? "mail" : "setup",
      previousRoute: accounts.length > 0 ? "mail" : "setup",
      accounts,
      activeAccountId: requested?.id ?? accounts[0]?.id ?? null,
      setupProviderId: null,
    };
  }

  if (event.type === "switch-account") {
    if (!state.accounts.some((account) => account.id === event.accountId)) return state;
    return { ...state, activeAccountId: event.accountId, overlay: null };
  }

  if (event.type === "open-settings") {
    return { ...state, previousRoute: state.route, route: "settings", overlay: null };
  }

  if (event.type === "back") {
    const route = state.previousRoute === "settings" ? (state.accounts.length ? "mail" : "setup") : state.previousRoute;
    return { ...state, route, previousRoute: route, overlay: null };
  }

  return state;
}
