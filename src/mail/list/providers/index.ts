// The list's provider clients: one `MailClient` per account and provider.
// `createClient` takes its transport (tests pass a stand-in); `clientFor` is
// the app's, on the backend, cached per account.
import { call, on } from "../../../backend/client";
import { createClient } from "./create";
import type { MailClient, ProviderContext } from "./shared";

export * from "./shared";
export * from "./facts";
export { createClient } from "./create";
export { heyVerbFor } from "./hey";

const contexts = new Map<string, ProviderContext>();
const cache = new Map<string, MailClient>();

/** What a provider's sign-in knows that its requests need (HEY's CLI path). Accounts calls it. */
export function setProviderContext(accountId: string, context: ProviderContext) {
  contexts.set(accountId, { ...context });
}

/** The account's client on the app's backend. */
export function clientFor(account: { id: string; provider: string }): MailClient {
  const key = account.id + "\u0000" + account.provider;
  let client = cache.get(key);
  if (!client) {
    client = createClient({ call, on }, account.id, account.provider, () => contexts.get(account.id) ?? {});
    cache.set(key, client);
  }
  return client;
}
