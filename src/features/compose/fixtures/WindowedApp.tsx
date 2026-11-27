// A test entry: a synthetic draft that moves to its own window, with the
// shell's key router, for checking keys in the detached composer on a real
// desktop. Synthetic backend only: it never reaches this machine's mail.
import "./syntheticBackend";
import { mount, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { app } from "../../../app/store";
import { useKeyRouter } from "../../../keys/router";
import { setComposeHost, defaultHost } from "../../../mail/compose/host";
import { Button, Omarchy, Toaster } from "../../../ui";
import { syntheticOutbox } from "./syntheticBackend";
import { ComposeSurface, openCompose } from "..";

const ACCOUNT = "jane@example.com";

setComposeHost({
  ...defaultHost,
  providerFor: () => "gmail",
  ownAddressFor: () => ACCOUNT,
  aliasesFor: () => [{ email: ACCOUNT, displayName: "Jane Doe", isPrimary: true }],
  signatureFor: () => ({ text: "", html: "" }),
  identities: async () => [{ accountId: ACCOUNT, email: ACCOUNT, displayName: "Jane Doe", isPrimary: true }],
  saveDraft: async () => ({}),
  attachment: async () => "",
  undoSendSeconds: () => 10,
});

function Harness() {
  useKeyRouter();
  app.setAccounts([{ id: ACCOUNT, email: ACCOUNT, provider: "gmail", label: "Jane" }]);
  return (
    <View class="flex-1 bg-background gap-2">
      <Text testID="outbox-count">{`Synthetic outbox: ${syntheticOutbox().length}${syntheticOutbox().map((e) => ` ${e.accountId}`).join("")}`}</Text>
      <If when={app.composing()} else={
        <Button testID="open-draft" label="Open draft" onPress={() => openCompose({
          accountId: ACCOUNT,
          draftId: "d1",
          from: ACCOUNT,
          to: "Ann Lee <ann@example.net>",
          subject: "Windowed",
          body: "Sent from the compose window.",
        })} />
      }>
        <ComposeSurface />
      </If>
      <Toaster />
    </View>
  );
}

mount(() => {
  Omarchy.applyTheme("tokyo-night");
  return <Window id="main" title="Omamail">{() => <Harness />}</Window>;
});
