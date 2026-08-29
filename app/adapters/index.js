// @ts-check

import { createEffectPort } from "./effect-port.js";
import { createGmailAdapter } from "./gmail.js";
import { createHeyAdapter } from "./hey.js";
import { createImapAdapter } from "./imap.js";

/** @param {string} providerId @param {any} execute @param {() => any} currentIdentity */
export function createProviderAdapter(providerId, execute, currentIdentity) {
  const port = createEffectPort(execute, currentIdentity);
  if (providerId === "gmail") return createGmailAdapter(port);
  if (providerId === "hey") return createHeyAdapter(port);
  if (providerId === "imap") return createImapAdapter(port);
  throw new Error("unknown provider: " + providerId);
}
