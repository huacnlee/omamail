// Builds a provider's client on a given transport (tests pass a stand-in).
import { gmailClient } from "./gmail";
import { heyClient } from "./hey";
import { imapClient } from "./imap";
import { jmapClient } from "./jmap";
import { m365Client } from "./m365";
import type { MailClient, ProviderContext, Rpc } from "./shared";

export function createClient(rpc: Rpc, accountId: string, provider: string, context: () => ProviderContext = () => ({})): MailClient {
  switch (String(provider ?? "").toLowerCase()) {
    case "imap": return imapClient(rpc, accountId, "imap");
    case "outlook": return imapClient(rpc, accountId, "outlook");
    case "jmap": return jmapClient(rpc, accountId);
    case "m365": return m365Client(rpc, accountId);
    case "hey": return heyClient(rpc, accountId, context);
    default: return gmailClient(rpc, accountId);
  }
}
