// A test entry for typing Chinese: a new message on a synthetic mailbox with
// the shell's key router (Enter, Cmd/Ctrl+Enter, Escape and the single-letter
// keys behave as in the app), a contact book with CJK names, and probes for
// the draft, the outbox and what recovery saved. Synthetic backend only.
import "./syntheticBackend";
import { mount, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { app } from "../../../app/store";
import { registerCommand } from "../../../keys/commands";
import { useKeyRouter } from "../../../keys/router";
import { setComposeHost, defaultHost } from "../../../mail/compose/host";
import { Button, imeComposing, Omarchy, setOmarchyFont, Toaster } from "../../../ui";
import { syntheticOutbox, syntheticRecovery } from "./syntheticBackend";
import { compose, ComposeSurface, openCompose } from "..";

const ACCOUNT = "jane@example.com";

setComposeHost({
  ...defaultHost,
  providerFor: () => "gmail",
  ownAddressFor: () => ACCOUNT,
  aliasesFor: () => [{ email: ACCOUNT, displayName: "简 · Jane", isPrimary: true }],
  signatureFor: () => ({ text: "", html: "" }),
  identities: async () => [{ accountId: ACCOUNT, email: ACCOUNT, displayName: "简 · Jane", isPrimary: true }],
  saveDraft: async () => ({}),
  attachment: async () => "",
  undoSendSeconds: () => 10,
});

// A single-letter command a pinyin letter must never run while typing.
const stray = signal(0);
registerCommand("archive", () => stray.update((n) => n + 1));

function Harness() {
  useKeyRouter();
  app.setAccounts([{ id: ACCOUNT, email: ACCOUNT, provider: "gmail", label: "Jane" }]);
  const d = () => compose.draft();
  return (
    <View class="flex-1 bg-background gap-1">
      <Text testID="probe-to">{`to=${d().to}`}</Text>
      <Text testID="probe-subject" class="line-clamp-1">{`subject=${d().subject}`}</Text>
      <Text testID="probe-body" class="line-clamp-1">{`body=${JSON.stringify(d().body)}`}</Text>
      <Text testID="probe-outbox">{`outbox=${syntheticOutbox().length}`}</Text>
      <Text testID="probe-recovery" class="line-clamp-1">{`recovery=${JSON.stringify([syntheticRecovery()?.draft?.subject ?? "", syntheticRecovery()?.draft?.body ?? ""])}`}</Text>
      <Text testID="probe-stray">{`stray=${stray()}`}</Text>
      <Text testID="probe-ime">{`ime=${imeComposing()}`}</Text>
      <Text testID="probe-opened">{`opened=${compose.opened()}`}</Text>
      <If when={app.composing()} else={<Button testID="new" label="New message" onPress={() => openCompose()} />}>
        <ComposeSurface />
      </If>
      <Toaster />
    </View>
  );
}

/** Mounts at Omarchy base size `base` (14 by default). */
export function mountCjk(base = 14) {
  mount(() => {
    Omarchy.applyTheme("tokyo-night");
    if (base !== 14) setOmarchyFont({ family: null, baseSize: base });
    return <Window id="main" title="Omamail">{() => <Harness />}</Window>;
  });
}
