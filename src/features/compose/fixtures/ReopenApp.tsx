// A test entry for a saved draft reopened by its id alone, as the list's
// Continue editing and the reader open one. Its read and its file can be held,
// to act while they are in flight. The probe shows the draft id the last
// provider save and the last recovery record carried (empty: a new draft), and
// whether Send is open. Synthetic backend only.
import { syntheticRecovery } from "./syntheticBackend";
import { mount, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { app } from "../../../app/store";
import { defaultHost, setComposeHost } from "../../../mail/compose/host";
import { Button, Toaster } from "../../../ui";
import { compose, ComposeSurface, openCompose } from "..";
import { chooseFrom, update } from "../store";

const SAM = { id: "imap:sam@example.org", email: "sam@example.org", provider: "imap", label: "Sam" };
const JANE = { id: "jane@example.com", email: "jane@example.com", provider: "gmail", label: "Jane" };
const DRAFT_ID = "7:Drafts";
const FILE = { attachmentId: "a1", filename: "plan.pdf", mimeType: "application/pdf", size: 3 };
const NOTE = { filename: "notes.txt", mimeType: "text/plain", size: 5, data: "bm90ZXM=" };

const readHeld = signal(false);
const withFile = signal(false);
const saved = signal("none");
let releaseRead = () => {};
let releaseFile = () => {};
let failFile = () => {};

setComposeHost({
  ...defaultHost,
  providerFor: (id) => (id === JANE.id ? "gmail" : "imap"),
  ownAddressFor: (id) => (id === JANE.id ? JANE.email : SAM.email),
  aliasesFor: (id) => [{ email: id === JANE.id ? JANE.email : SAM.email, displayName: id === JANE.id ? "Jane Doe" : "Sam Roe", isPrimary: true }],
  signatureFor: () => ({ text: "", html: "" }),
  identities: () => Promise.resolve([]),
  readMessage: async () => {
    if (readHeld()) await new Promise<void>((resolve) => (releaseRead = resolve));
    return {
      summary: { from: { name: "Sam Roe", email: SAM.email }, to: [{ name: "Ann Lee", email: "ann@example.net" }], subject: "Saved subject" },
      body: "Saved body",
      attachments: withFile() ? [FILE] : [],
    };
  },
  attachment: async () => {
    await new Promise<void>((resolve, reject) => {
      releaseFile = resolve;
      failFile = () => reject(new Error("the server dropped it"));
    });
    return "UERG";
  },
  saveDraft: async (_accountId, payload) => {
    saved.set(String(payload?.draftId ?? ""));
    return {};
  },
});

function Harness() {
  return (
    <View class="flex-1 bg-background gap-1">
      <Text testID="probe">
        {`saved=[${saved()}] recovered=[${syntheticRecovery()?.draft?.sourceDraftId ?? "none"}] typed=${String(syntheticRecovery()?.draft?.body ?? "").endsWith(" and more")} loading=${compose.forwardLoading()} send=${compose.canSend()} files=${compose.draft().draftAttachments.map((f) => f.filename).join(",")}`}
      </Text>
      <View class="flex-row flex-wrap gap-1">
        <Button testID="load-accounts" label="Load accounts" onPress={() => app.setAccounts([SAM, JANE])} />
        <Button testID="hold-read" label="Hold the read" onPress={() => readHeld.set(true)} />
        <Button testID="release-read" label="Release the read" onPress={() => releaseRead()} />
        <Button testID="with-file" label="Draft with a file" onPress={() => withFile.set(true)} />
        <Button testID="release-file" label="Release the file" onPress={() => releaseFile()} />
        <Button testID="fail-file" label="Fail the file" onPress={() => failFile()} />
        <Button testID="from-jane" label="Send from Jane" onPress={() => chooseFrom({ accountId: JANE.id, email: JANE.email, displayName: "Jane Doe" })} />
        <Button testID="attach-note" label="Attach a note" onPress={() => update({ draftAttachments: [...compose.draft().draftAttachments, NOTE] })} />
        <Button testID="reopen" label="Continue editing" onPress={() => openCompose({ accountId: SAM.id, draftId: DRAFT_ID })} />
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
