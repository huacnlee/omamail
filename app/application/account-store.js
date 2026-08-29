// @ts-check

import { label, load, serialize } from "../account/Accounts.js";

export const ACCOUNT_STORAGE_KEY = "omamail.accounts";

/** @param {Pick<Storage, "getItem">} storage */
export function loadAccounts(storage) {
  return load(storage.getItem(ACCOUNT_STORAGE_KEY) ?? "");
}

/**
 * @param {Pick<Storage, "setItem">} storage
 * @param {unknown} accounts
 */
export function saveAccounts(storage, accounts) {
  const normalized = load(serialize(accounts));
  storage.setItem(ACCOUNT_STORAGE_KEY, serialize(normalized));
  return normalized;
}

/** @param {{ accounts?: Array<any> }} list */
export function accountSummaries(list) {
  return (Array.isArray(list.accounts) ? list.accounts : [])
    .filter((account) => Boolean(account?.id))
    .map((account) => ({
      id: account.id,
      providerId: account.provider,
      email: account.email,
      label: label(account),
    }));
}
