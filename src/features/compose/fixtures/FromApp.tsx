// A test entry for the From address: two synthetic mailboxes, the active one
// not first; mailboxes and send-as rows that can arrive after the draft
// opens; and a button for each way a draft starts. Synthetic backend only.
import "./syntheticBackend";
import { mount, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { app } from "../../../app/store";
import { setComposeHost, defaultHost, type Alias } from "../../../mail/compose/host";
import type { SendIdentity } from "../../../mail/compose/senders";
import { Button, Toaster } from "../../../ui";
import { compose, ComposeSurface, openCompose } from "..";

const JANE = { id: "jane@example.com", email: "jane@example.com", provider: "gmail", label: "Jane" };
const SAM = { id: "imap:sam@example.org", email: "sam@example.org", provider: "imap", label: "Sam" };

const ALIASES: Record<string, Alias[]> = {
  [JANE.id]: [{ email: JANE.email, displayName: "Jane Doe", isPrimary: true }],
  [SAM.id]: [
    { email: SAM.email, displayName: "Sam Roe", isPrimary: true },
    { email: "team@example.org", displayName: "Team" },
  ],
};
const IDENTITIES: SendIdentity[] = [
  { accountId: JANE.id, email: JANE.email, displayName: "Jane Doe", isPrimary: true },
  { accountId: SAM.id, email: SAM.email, displayName: "Sam Roe", isPrimary: true },
  { accountId: SAM.id, email: "team@example.org", displayName: "Team" },
];

// Mailboxes known to the registry yet (aliases), and the send-as rows' answer.
const registryLoaded = signal(false);
let releaseIdentities: (() => void) | null = null;
const identitiesHeld = signal(false);

setComposeHost({
  ...defaultHost,
  providerFor: (id) => (id === SAM.id ? "imap" : "gmail"),
  ownAddressFor: (id) => (registryLoaded() ? (id === SAM.id ? SAM.email : id === JANE.id ? JANE.email : "") : ""),
  aliasesFor: (id) => (registryLoaded() ? ALIASES[id] ?? [] : []),
  signatureFor: () => ({ text: "", html: "" }),
  identities: () =>
    identitiesHeld()
      ? new Promise<SendIdentity[]>((resolve) => (releaseIdentities = () => resolve(IDENTITIES)))
      : Promise.resolve(IDENTITIES),
  saveDraft: async () => ({}),
  attachment: async () => "",
});

/** The mailboxes listed, and their registry entries (aliases) read. */
function loadAccounts() {
  registryLoaded.set(true);
  app.setAccounts([JANE, SAM]);
}

const original = {
  from: { name: "Ann Lee", email: "ann@example.net" },
  to: [{ email: "team@example.org" }],
  cc: [{ email: "bob@example.net" }],
  subject: "Plans",
  messageId: "<m1@example.net>",
  threadId: "t1",
};

function Harness() {
  return (
    <View class="flex-1 bg-background gap-1">
      <Text testID="probe">{`from=${compose.draft().fromEmail} acct=${compose.draft().accountId} send=${compose.canSend()} reason=${compose.sendBlockedReason()}`}</Text>
      <View class="flex-row flex-wrap gap-1">
        <Button testID="load-accounts" label="Load accounts" onPress={loadAccounts} />
        <Button testID="list-accounts" label="List accounts only" onPress={() => app.setAccounts([JANE, SAM])} />
        <Button testID="activate-sam" label="Open Sam" onPress={() => app.openAccount(SAM.id)} />
        <Button testID="hold-identities" label="Hold identities" onPress={() => identitiesHeld.set(true)} />
        <Button testID="release-identities" label="Release identities" onPress={() => releaseIdentities?.()} />
        <Button testID="new" label="New" onPress={() => openCompose()} />
        <Button testID="bare-overlay" label="Bare overlay" onPress={() => app.openOverlay("compose")} />
        <Button testID="reply" label="Reply" onPress={() => openCompose({ accountId: SAM.id, replyTo: { accountId: SAM.id, messageId: "m1", mode: "reply", summary: original, body: "Hi" } })} />
        <Button testID="reply-all" label="Reply all" onPress={() => openCompose({ accountId: SAM.id, replyTo: { accountId: SAM.id, messageId: "m1", mode: "replyAll", summary: original, body: "Hi" } })} />
        <Button testID="forward" label="Forward" onPress={() => openCompose({ accountId: SAM.id, replyTo: { accountId: SAM.id, messageId: "m1", mode: "forward", summary: original, body: "Hi" } })} />
        <Button testID="reopen-draft" label="Reopen draft" onPress={() => openCompose({ accountId: SAM.id, draftId: "d9", from: "team@example.org", to: "ann@example.net", subject: "Saved", body: "Saved body" })} />
        <Button testID="reopen-draft-nofrom" label="Reopen draft without From" onPress={() => openCompose({ accountId: SAM.id, draftId: "d8", to: "ann@example.net", subject: "Saved", body: "Saved body" })} />
        <Button testID="mailto" label="Mailto" onPress={() => openCompose({ mailto: "mailto:ann@example.net?subject=Hello" })} />
      </View>
      <View class="flex-1">
        <If when={app.composing()}>
          <ComposeSurface />
        </If>
      </View>
      <Toaster />
    </View>
  );
}

mount(() => <Window id="main" title="Omamail">{() => <Harness />}</Window>);
