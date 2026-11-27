// Microsoft 365 setup: a work address and the Application (client) ID of the
// organization's own Entra app, then one device-code sign-in that the backend
// holds (m365.signInBegin / signInPoll). Port of components/M365SetupPage.qml
// and providers/M365Auth.qml. Tokens never reach this page.
import { cleanup, signal, Text, untracked, View } from "nsh";
import * as Accounts from "../../mail/accounts";
import * as M365 from "../../mail/providers/m365";
import { Button, cx, RADIUS, TEXT } from "../../ui";
import type { SetupContext } from "./context";
import { Abort, m365SignedIn, m365SignIn, m365SignOut, openExternal, type DeviceCode } from "./flows";
import { AccountFooter, DeviceCodeBox, ErrorLine, Hero, Note, NumberedList, Progress, TextField } from "./parts";

export function M365Setup(props: { context: SetupContext }) {
  const initial = untracked(() => props.context.account());
  const address = signal(initial?.email ?? "");
  const clientId = signal(initial?.clientId ?? "");
  const error = signal("");
  const busy = signal(false);
  const stage = signal("");
  const code = signal<DeviceCode | null>(null);
  const signedIn = signal(false);
  let flow = new Abort();
  cleanup(() => flow.stop());

  if (initial?.id) {
    stage.set("Checking the saved Microsoft sign-in");
    void m365SignedIn(initial.id).then((state) => {
      if (flow.stopped) return;
      stage.set("");
      signedIn.set(state === "signedIn");
    });
  }

  function validatedAddress(): string {
    const value = address().trim();
    if (Accounts.isValidEmail(value)) return value;
    error.set(value === "" ? "Add your work email address" : "That is not a full email address");
    return "";
  }

  function validatedClientId(): string {
    const value = clientId().trim();
    if (M365.clientId(value) !== "") return M365.clientId(value);
    error.set(
      value === "" ? "Add the Application (client) ID from Microsoft Entra" : "That is not a Microsoft Application (client) ID",
    );
    return "";
  }

  async function signIn() {
    if (busy() || signedIn()) return;
    const email = validatedAddress();
    const client = email === "" ? "" : validatedClientId();
    if (client === "") return;
    error.set("");
    // The address and the ID are written down first, so a failed sign-in keeps them.
    if (!props.context.configure({ provider: "m365", email, clientId: client })) return;
    busy.set(true);
    flow = new Abort();
    const result = await m365SignIn(
      { accountId: Accounts.accountId(email, "m365"), address: email, clientId: client },
      (next) => code.set(next),
      (text) => stage.set(text),
      flow,
    );
    if (flow.stopped) return;
    busy.set(false);
    stage.set("");
    code.set(null);
    if (!result.ok) {
      error.set(result.error);
      return;
    }
    signedIn.set(true);
    props.context.reportSignedIn(true);
    if (props.context.adding) props.context.finish();
  }

  function cancel() {
    flow.stop();
    flow = new Abort();
    busy.set(false);
    stage.set("");
    code.set(null);
  }

  async function signOut() {
    const account = props.context.account();
    if (!account?.id) return;
    stage.set("Removing the saved Microsoft sign-in");
    const problem = await m365SignOut(account.id, account.clientId);
    stage.set("");
    if (problem) error.set(problem);
    else {
      signedIn.set(false);
      props.context.reportSignedIn(false);
    }
  }

  return (
    <View class="gap-5">
      <Hero
        provider="m365"
        title="Add a Microsoft 365 mailbox"
        detail="Your work or school mailbox, signed in with Microsoft, with your calendar. Folders of your own are not shown."
      />
      <If when={!signedIn()}>
        <View class="gap-3">
          <TextField
            testID="setup-address"
            value={address()}
            label="Work email address"
            placeholder="Work email address — you@example.org"
            disabled={busy()}
            onChange={(v) => address.set(v)}
          />
          <TextField
            testID="setup-client-id"
            value={clientId()}
            label="Microsoft Application (client) ID"
            placeholder="Microsoft Application (client) ID"
            disabled={busy()}
            onChange={(v) => clientId.set(v)}
            onSubmit={() => void signIn()}
          />
          <If when={!busy()}>
            <Note text="Omamail asks Microsoft to sign you in, and for this: read and write mail, send mail, read and write your calendar. That is one sign-in on Microsoft's own page: there is no second code, and Omamail never sees your password." />
          </If>
        </View>
      </If>
      <ErrorLine text={error()} />
      <If when={!signedIn() && !busy()}>
        <View class={cx("gap-3 p-4 border border-border bg-surface", RADIUS)}>
          <Text class={cx(TEXT.body, "font-semibold")}>One-time Microsoft app setup</Text>
          <NumberedList items={M365.SETUP_STEPS} />
          <Note text="If your organization does not let people approve apps themselves, an administrator has to approve this one before the sign-in works." />
          <View class="flex-row">
            <Button
              size="small"
              variant="ghost"
              icon="external-link"
              label="Open Microsoft Entra app registrations..."
              onPress={() => void openExternal(M365.ENTRA_APPS_URL)}
            />
          </View>
        </View>
      </If>
      <Progress text={stage()} />
      <If when={busy() && code()}>
        <DeviceCodeBox
          code={code()!.userCode}
          uri={code()!.verificationUri}
          showUri
          instructions="Enter this code on the Microsoft page opened in your browser, then sign in with your work account. If it offers another account, paste the page address below into a private window:"
          reopenLabel="Open the Microsoft sign-in page again..."
        />
      </If>
      <If when={signedIn()}>
        <View class={cx("gap-1 p-4 border border-border bg-surface", RADIUS)}>
          <Text class={cx(TEXT.body, "font-semibold")}>{"Signed in · " + (props.context.account()?.email ?? "")}</Text>
          <Note text="Mail and calendar use this one sign-in. Signing out removes it from this computer." />
        </View>
      </If>
      <View class="flex-row gap-2">
        <If when={!signedIn()}>
          <Button
            testID="setup-sign-in"
            variant="primary"
            label={busy() ? "Waiting for Microsoft" : "Sign in with Microsoft..."}
            loading={busy()}
            disabled={busy() || address().trim() === "" || clientId().trim() === ""}
            onPress={() => void signIn()}
          />
        </If>
        <If when={busy()}>
          <Button testID="setup-cancel" label="Cancel" onPress={() => cancel()} />
        </If>
      </View>
      <AccountFooter
        signedIn={signedIn()}
        canRemove={props.context.canRemove()}
        busy={busy()}
        onSignOut={() => void signOut()}
        onRemove={() => void props.context.remove().then((p) => p && error.set(p))}
      />
    </View>
  );
}
