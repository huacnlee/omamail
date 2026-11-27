// Gmail setup: an OAuth client the user owns (or the one a release backend
// ships), then a browser sign-in whose grant the backend exchanges. Port of
// components/SetupPage.qml and providers/AuthManager.qml's sign-in.
//
// The client is written owner-only (credentials.json through the native
// config); the refresh token goes to the keyring only once the profile has
// named the mailbox, so it is never stored under an ambiguous key.
import { cleanup, signal, Text, untracked, View } from "nsh";
import * as Accounts from "../../mail/accounts";
import * as Google from "../../mail/providers/google";
import { Button, TEXT, cx, toast } from "../../ui";
import { settings } from "../settings/store";
import type { SetupContext } from "./context";
import {
  Abort,
  gmailSignedIn,
  gmailSignIn,
  gmailSignOut,
  gmailStoreGrant,
  googleClient,
  openExternal,
  writeClientFile,
} from "./flows";
import { AccountFooter, ErrorLine, Hero, NameField, Note, Progress, Step, TextField } from "./parts";

const DETAIL =
  "In Google Cloud, pick or create a project. Under APIs and Services, enable the Gmail API. " +
  "On the consent screen add the Gmail address you want to read as a test user, then press Publish app. " +
  "Under Credentials, create an OAuth client with application type Desktop app, and paste its client ID above.\n\n" +
  "Steps one and two have a CLI: run scripts/google-cloud-project.sh if you have gcloud. " +
  "The consent screen and the client itself are console-only.\n\n" +
  "The client is saved to Omamail's credentials.json, readable only by you. " +
  "The refresh token goes to the keyring; the access token never leaves memory.";

export function GmailSetup(props: { context: SetupContext }) {
  const initial = untracked(() => props.context.account());
  const name = signal(initial?.label ?? "");
  const client = signal<Google.Client>(Google.emptyClient());
  const builtin = signal(false);
  const clientIdText = signal("");
  const clientSecretText = signal("");
  const clientReopened = signal(false);
  const detailOpen = signal(false);
  const error = signal("");
  const busy = signal(false);
  const signedIn = signal(false);
  let flow = new Abort();
  cleanup(() => flow.stop());

  const account = () => props.context.account();
  const clientReady = () => Google.isConfigured(client());
  const clientDone = () => clientReady() && !clientReopened();

  async function loadClient() {
    const found = await googleClient(untracked(() => account()?.id ?? ""));
    if (flow.stopped) return;
    client.set(found.client);
    builtin.set(found.builtin);
    // The fields show what is on disk, so the page says what the app actually uses.
    clientIdText.set(found.builtin ? "" : found.client.clientId);
    clientSecretText.set(found.builtin ? "" : found.client.clientSecret);
  }
  void loadClient();

  if (initial?.id) {
    void gmailSignedIn(initial.id).then((state) => !flow.stopped && signedIn.set(state === "signedIn"));
  }

  // The name goes on the entry whenever the page acts: either button may be the only one pressed.
  function saveName() {
    const label = name().trim();
    if (label !== (account()?.label ?? "")) props.context.configure({ label });
  }

  function saveClient() {
    saveName();
    const secret = clientSecretText().trim();
    const parsed = Google.parse(clientIdText().trim() + (secret === "" ? "" : "\n" + secret));
    if (!parsed.ok) {
      error.set(parsed.error);
      return;
    }
    // One installed client, as the Qt client writes it.
    const text = Google.serialize(parsed.client);
    if (!writeClientFile(text)) {
      error.set("Could not save the OAuth client to credentials.json");
      return;
    }
    error.set("");
    clientReopened.set(false);
    toast({ title: "OAuth client saved", kind: "success" });
    void loadClient();
  }

  async function signIn() {
    if (busy()) return;
    saveName();
    error.set("");
    busy.set(true);
    flow = new Abort();
    const current = untracked(() => client());
    const hint = untracked(() => account()?.email ?? "");
    const result = await gmailSignIn(current, settings.oauthPort(), hint, flow);
    if (flow.stopped) return;
    busy.set(false);
    if (!result.ok) {
      if (result.error) error.set(result.error);
      return;
    }
    // An existing mailbox stays the address it is: a different Google account is not swapped in under it.
    if (!props.context.adding && hint !== "" && result.email.toLowerCase() !== hint.toLowerCase()) {
      error.set("Signed in as " + result.email + ", not " + hint + ". Sign in with " + hint);
      return;
    }
    props.context.name(result.email);
    const id = Accounts.accountId(result.email, "gmail");
    const problem = await gmailStoreGrant(id, current.clientId, result.refreshToken);
    if (problem) error.set(problem);
    signedIn.set(true);
    props.context.reportSignedIn(true);
    if (props.context.adding) props.context.finish();
    else toast({ title: "Signed in as " + result.email, kind: "success" });
  }

  function cancel() {
    flow.stop();
    flow = new Abort();
    busy.set(false);
  }

  async function signOut() {
    const row = account();
    if (!row?.id) return;
    if (await gmailSignOut(row.id, client().clientId)) {
      signedIn.set(false);
      props.context.reportSignedIn(false);
    }
    else error.set("The saved Google sign-in could not be removed");
  }

  return (
    <View class="gap-5">
      <Hero
        provider="gmail"
        title={props.context.adding ? "Add a Gmail mailbox" : "Connect your Gmail mailbox"}
        detail="Google issues Gmail API access per project, so this app signs in with an OAuth client you own. About two minutes, once."
      />
      <NameField value={name()} onChange={(v) => name.set(v)} />
      <If when={!builtin()}>
        <Step
          testID="gmail-client-step"
          number="1"
          title="Create a client in Google Cloud"
          done={clientDone()}
          doneSummary={"Client connected · " + Google.describe(client())}
          onReopen={() => clientReopened.set(true)}
        >
          <Note text="Create an OAuth client with application type Desktop app, and enable the Gmail API on the same project." />
          <View class="flex-row flex-wrap gap-2">
            <Button
              size="small"
              icon="external-link"
              label="Open Google Cloud..."
              onPress={() => void openExternal(Google.CLOUD_CLIENT_URL)}
            />
            <Button
              size="small"
              icon="external-link"
              label="Enable Gmail API..."
              onPress={() => void openExternal(Google.GMAIL_API_URL)}
            />
          </View>
          <TextField
            testID="gmail-client-id"
            value={clientIdText()}
            label="Client ID"
            placeholder="Client ID — 000000-xxxx.apps.googleusercontent.com"
            onChange={(v) => clientIdText.set(v)}
            onSubmit={() => saveClient()}
          />
          <TextField
            testID="gmail-client-secret"
            value={clientSecretText()}
            label="Client secret"
            placeholder="Client secret — optional"
            masked
            onChange={(v) => clientSecretText.set(v)}
            onSubmit={() => saveClient()}
          />
          <View class="flex-row">
            <Button
              testID="gmail-save-client"
              variant="primary"
              label="Save client"
              disabled={clientIdText().trim() === ""}
              onPress={() => saveClient()}
            />
          </View>
        </Step>
      </If>
      <Step
        testID="gmail-sign-in-step"
        number={builtin() ? "1" : "2"}
        title="Sign in"
        done={signedIn() && !busy()}
        doneSummary={"Signed in as " + (account()?.email ?? "")}
      >
        <If when={!builtin()}>
          <Note text={'Press "Publish app" on your project first, or Google expires the session every seven days. An "unverified app" warning is expected — you are the developer.'} />
        </If>
        <View class="flex-row flex-wrap items-center gap-2">
          <Button
            testID="gmail-sign-in"
            variant="primary"
            label="Sign in with Google..."
            loading={busy()}
            disabled={busy() || !clientReady()}
            onPress={() => void signIn()}
          />
          <If when={!builtin()}>
            <Button
              size="small"
              variant="ghost"
              icon="external-link"
              label="Consent screen..."
              onPress={() => void openExternal(Google.CONSENT_SCREEN_URL)}
            />
          </If>
          <If when={busy()}>
            <Button testID="gmail-cancel" label="Cancel" onPress={() => cancel()} />
          </If>
        </View>
        <Progress text={busy() ? "Finish the sign-in in your browser…" : ""} />
      </Step>
      <ErrorLine text={error()} />
      <If when={!builtin()}>
        <View class="gap-2">
          <View class="flex-row">
            <Button
              size="small"
              variant="ghost"
              label={detailOpen() ? "Hide the details" : "Need more detail?"}
              onPress={() => detailOpen.set(!detailOpen())}
            />
          </View>
          <If when={detailOpen()}>
            <View selectable>
              <Text class={cx(TEXT.caption, "leading-relaxed")}>
                {DETAIL}
              </Text>
            </View>
          </If>
        </View>
      </If>
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

