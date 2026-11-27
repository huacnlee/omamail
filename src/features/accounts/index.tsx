// Feature entry: the shell imports only what this file exports.
//
// Adding and editing a mailbox: the provider chooser (the `picker` history
// entry) and each provider's setup form (the `setup` entry, which carries the
// provider and, when editing, the account id). Port of components/
// SetupPages.qml, ProviderPicker.qml and App.qml's setup navigation.
//
// A new mailbox is a working row in the registry (`accountsStore.addDraft`)
// until its form saves an address; leaving the form any way (Back, Escape,
// the chooser) drops a row that never got one, so a cancelled Add leaves
// nothing behind.
import { batch, cleanup, signal, Text, untracked, View } from "nsh";
import { app } from "../../app/store";
import * as Accounts from "../../mail/accounts";
import * as AccountCache from "../../mail/accounts-cache";
import { accountsStore } from "../../mail/accounts-store";
import * as Registry from "../../mail/providers/registry";
import { Button, confirm, cx, PickerRow, RADIUS, TEXT } from "../../ui";
import { settings } from "../settings/store";
import type { SetupContext } from "./context";
import { forgetBeforeRemoval } from "./flows";
import { startAccounts } from "./startup";
import { GmailSetup } from "./GmailSetup";
import { HeySetup } from "./HeySetup";
import { ImapSetup } from "./ImapSetup";
import { JmapSetup } from "./JmapSetup";
import { M365Setup } from "./M365Setup";
import { OutlookSetup } from "./OutlookSetup";
import { ProviderMark, SetupFrame } from "./parts";

export { startAccounts } from "./startup";

export function AccountSetup() {
  startAccounts();
  void settings.load();
  return (
    <If when={app.navPage().kind === "setup"} else={<ProviderPicker />}>
      <SetupForm />
    </If>
  );
}

/** Back, when there is somewhere to go back to: not on a first run, where the chooser is the root. */
function BackButton() {
  return (
    <If when={app.nav().length > 1}>
      <View class="flex-row">
        <Button testID="setup-back" size="small" variant="ghost" icon="arrow-left" label="Back" onPress={() => app.back()} />
      </View>
    </If>
  );
}

function ProviderPicker() {
  function choose(provider: Accounts.ProviderId) {
    if (!Registry.isConnectable(provider)) return;
    accountsStore.addDraft(provider);
    app.push("setup", { provider, draft: true });
  }
  return (
    <SetupFrame testID="provider-picker">
      <BackButton />
      <View class="gap-1">
        <Text role="header" class={TEXT.title}>
          Add a mailbox
        </Text>
        <Text class={TEXT.caption}>Which kind?</Text>
      </View>
      <View class={cx("border border-border bg-surface p-1 gap-0.5", RADIUS)}>
        <Each of={Registry.PROVIDERS} key={(p) => p.id}>
          {(provider) => <ProviderRow provider={provider()} onChoose={() => choose(provider().id)} />}
        </Each>
      </View>
    </SetupFrame>
  );
}

function ProviderRow(props: { provider: Registry.Provider; onChoose: () => void }) {
  const connectable = () => props.provider.unavailable === "";
  const line = () => (connectable() ? props.provider.summary : props.provider.unavailable);
  return (
    // A provider that cannot be added is dimmed and unpressable, and says why in words.
    <PickerRow
        testID={"provider-" + props.provider.id}
        accessibilityLabel={props.provider.name + ". " + line()}
        lead={<ProviderMark provider={props.provider.id} size={28} />}
        label={props.provider.name}
        detail={line()}
        disabled={!connectable()}
        onPress={() => props.onChoose()}
      />
  );
}

function SetupForm() {
  const entry = untracked(() => app.navPage());
  const provider = Accounts.normalizeProvider(entry.provider);
  const accountId = String(entry.accountId ?? "");
  const adding = entry.draft === true;
  // A draft entry without its row (the registry reloaded under the form) gets one again.
  if (adding && untracked(() => accountsStore.draftIndex()) < 0) accountsStore.addDraft(provider);
  // The address the draft was saved under: its first save names it, and the
  // form follows the row by that id from then on.
  const savedEmail = signal(String(untracked(() => (accountId ? accountsStore.find(accountId)?.email : "")) ?? ""));

  const index = () => {
    if (accountId) {
      const at = accountsStore.indexOf(accountId);
      if (at >= 0) return at;
    } else {
      const draft = accountsStore.draftIndex();
      if (draft >= 0) return draft;
    }
    return savedEmail() ? accountsStore.indexOf(Accounts.accountId(savedEmail(), provider)) : -1;
  };
  const account = () => {
    const at = index();
    return at >= 0 ? accountsStore.accounts()[at] ?? null : null;
  };

  // Leaving drops a row that never got an address.
  cleanup(() => {
    const draft = untracked(() => accountsStore.draft());
    if (draft && draft.pending && draft.email === "") accountsStore.discardDraft();
  });

  const context: SetupContext = {
    provider,
    adding,
    index,
    account,
    canRemove: () => {
      const at = index();
      return at >= 0 && Accounts.removalRequest(accountsStore.list(), at) !== null;
    },
    configure(values) {
      const at = index();
      if (at < 0) return false;
      // Named before the write, so the form follows the row through it.
      const before = untracked(() => savedEmail());
      if (values.email !== undefined) savedEmail.set(String(values.email).trim());
      const ok = accountsStore.configure(at, values);
      if (!ok) savedEmail.set(before);
      return ok;
    },
    name(email) {
      const at = index();
      if (at < 0) return;
      savedEmail.set(email.trim());
      accountsStore.name(at, email);
    },
    finish() {
      const id = Accounts.accountId(untracked(() => savedEmail()) || account()?.email || "", provider);
      batch(() => {
        // Out of the chooser and the form: back where Add was asked for, or to the mail.
        const stack = app.nav().filter((e) => e.kind !== "picker" && e.kind !== "setup");
        app.resetNav(stack.length > 0 ? stack : [{ kind: "list" }]);
        if (adding && id) app.openAccount(id);
      });
    },
    reportSignedIn(signedIn) {
      const id = untracked(() => account()?.id) || Accounts.accountId(untracked(() => savedEmail()), provider);
      if (!id) return;
      // A sign-in from this page clears the session's last error; a sign-out ends its check.
      app.setAccountStatus(id, signedIn ? { signedIn: true, error: "" } : { signedIn: false, busy: false });
      // Signed out, its cached mail is not painted again (Qt's cacheStore.clear()).
      if (!signedIn) AccountCache.forget(id);
    },
    async remove() {
      const request = Accounts.removalRequest(accountsStore.list(), index());
      if (!request) {
        // The form's own working row has nothing to confirm: cancel it, as Back does.
        if (accountsStore.discardDraft()) app.back();
        return "";
      }
      const yes = await confirm({
        title: "Remove " + request.email + "?",
        description: "This mailbox will be removed from Omamail.",
        actionLabel: "Remove",
        cancelLabel: "Cancel",
        tone: "danger",
      });
      if (!yes) return "";
      const row = accountsStore.list().accounts[Accounts.confirmRemoval(accountsStore.list(), request)];
      if (!row) return "";
      // The saved sign-in goes first: a keyring that cannot be reached keeps the mailbox, to try again.
      const problem = await forgetBeforeRemoval(row);
      if (problem) return problem;
      const now = Accounts.confirmRemoval(accountsStore.list(), request);
      if (now < 0) return "";
      // Its cache empties as it leaves the registry (accounts-cache).
      batch(() => {
        accountsStore.removeAt(now);
        const stack = app.nav().filter((e) => e.kind !== "picker" && e.kind !== "setup" && e.kind !== "settings");
        app.resetNav([...(stack.length > 0 ? stack : [{ kind: "list" as const }]), { kind: "settings" }]);
      });
      return "";
    },
  };

  return (
    <SetupFrame testID={"setup-" + provider}>
      <BackButton />
      <ProviderForm context={context} />
    </SetupFrame>
  );
}

function ProviderForm(props: { context: SetupContext }) {
  switch (props.context.provider) {
    case "gmail":
      return <GmailSetup context={props.context} />;
    case "outlook":
      return <OutlookSetup context={props.context} />;
    case "m365":
      return <M365Setup context={props.context} />;
    case "hey":
      return <HeySetup context={props.context} />;
    case "jmap":
      return <JmapSetup context={props.context} />;
    default:
      return <ImapSetup context={props.context} />;
  }
}
