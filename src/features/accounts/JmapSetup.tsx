// JMAP setup: an address and an app password or API token; the server is
// discovered from the domain unless typed. Port of components/
// JmapSetupPage.qml and JmapAuth.qml's sign-in. The secret is verified by
// using it (jmap.verify), then stored in the keyring.
import { cleanup, signal, Text, untracked, View } from "nsh";
import * as Accounts from "../../mail/accounts";
import * as Jmap from "../../mail/providers/jmap";
import { Button, cx, Disclosure, RADIUS, TEXT, toast, Icon } from "../../ui";
import type { SetupContext } from "./context";
import { Abort, credentialPresent, deleteCredential, jmapVerify, readCredential, storeCredential } from "./flows";
import { AccountFooter, ErrorLine, Hero, NameField, Note, TextField } from "./parts";

const STEPS = ["Finding the server", "Checking the app password", "Reading your mailboxes"];

export function JmapSetup(props: { context: SetupContext }) {
  const initial = untracked(() => props.context.account());
  const address = signal(initial?.email ?? "");
  const secret = signal("");
  const name = signal(initial?.label ?? "");
  const server = signal(initial?.jmap.sessionUrl ?? "");
  const username = signal(initial?.jmap.username ?? "");
  const serversOpen = signal(false);
  const error = signal("");
  const busy = signal(false);
  const signedIn = signal(false);
  const rejected = signal(false);
  const sendingRefused = signal(false);
  const abort = new Abort();
  cleanup(() => abort.stop());

  const account = () => props.context.account();
  const host = () => Jmap.sessionHost(account()?.jmap.sessionUrl ?? "");
  const scheme = () => Jmap.schemeLabel(account()?.jmap.authScheme ?? "");

  if (initial?.id) {
    void credentialPresent("jmap-secret", initial.id)
      .then((found) => !abort.stopped && signedIn.set(found))
      .catch(() => {});
  }

  function validatedAddress(): string {
    const value = address().trim();
    if (Accounts.isValidEmail(value)) return value;
    error.set(value === "" ? "Add the email address for this mailbox" : "That is not a full email address");
    return "";
  }

  /** The typed server's session URL, "" for discovery, null when it is not HTTPS. */
  function plannedServer(email: string): string | null {
    const plan = Jmap.discoveryPlan(email, server());
    if (plan.error !== "") {
      error.set(plan.error);
      serversOpen.set(true);
      return null;
    }
    const first = plan.steps[0];
    return first && first.kind === Jmap.STEP_TYPED ? first.url : "";
  }

  async function signIn() {
    if (busy()) return;
    const email = validatedAddress();
    if (!email) return;
    const typed = plannedServer(email);
    if (typed === null) return;
    // "Save changes" re-verifies with the saved secret: nothing writes it back into the field.
    let typedSecret = secret();
    if (typedSecret === "" && signedIn() && account()?.id) typedSecret = await readCredential("jmap-secret", account()!.id);
    if (abort.stopped) return;
    if (typedSecret === "") {
      error.set("Enter the app password or API token for this mailbox");
      return;
    }
    error.set("");
    const current = account()?.jmap;
    const settings = {
      sessionUrl: typed,
      username: username().trim(),
      authScheme: current?.authScheme ?? "",
      accountId: current?.accountId ?? "",
    };
    // Written before the secret is tried, so a refused mailbox still has its address and server.
    if (!props.context.configure({ provider: "jmap", email, jmap: settings as any, label: name().trim() })) return;
    busy.set(true);
    const verified = await jmapVerify(settings, email, typedSecret);
    if (abort.stopped) return;
    busy.set(false);
    if (verified.error) {
      error.set(verified.error);
      rejected.set(verified.rejected);
      if (verified.needsServer) serversOpen.set(true);
      return;
    }
    rejected.set(false);
    sendingRefused.set(verified.result?.canSend === false);
    // What actually answered is written down, so it is not discovered again.
    props.context.configure({ jmap: Accounts.jmapSettingsAfterSignIn(settings, verified.result) });
    const url = String(verified.result?.sessionUrl ?? "");
    if (url) server.set(url);
    const id = Accounts.accountId(email, "jmap");
    if (!(await storeCredential("jmap-secret", id, typedSecret))) {
      error.set("Signed in, but the app password could not be saved. You may need to enter it again after a restart");
    }
    secret.set("");
    signedIn.set(true);
    props.context.reportSignedIn(true);
    if (props.context.adding) props.context.finish();
    else toast({ title: "Signed in", kind: "success" });
  }

  async function signOut() {
    const id = account()?.id;
    if (!id) return;
    if (await deleteCredential("jmap-secret", id)) {
      signedIn.set(false);
      props.context.reportSignedIn(false);
    }
    else error.set("The saved app password could not be removed");
  }

  return (
    <View class="gap-5">
      <Hero
        provider="jmap"
        title="Add a JMAP mailbox"
        detail="Any mailbox on a server that speaks JMAP. It signs in with an app password or an API token, never your account password."
      />
      <View class="gap-3">
        <NameField value={name()} onChange={(v) => name.set(v)} />
        <TextField
          testID="setup-address"
          value={address()}
          label="Email address"
          placeholder="Email address — you@example.com"
          onChange={(v) => address.set(v)}
        />
        <Note text="Most servers want an app password or an API token made for this client, not the password you sign in to the website with. Your provider's security settings are where to create one." />
        <TextField
          testID="setup-secret"
          value={secret()}
          label="App password, or API token"
          placeholder="App password, or API token"
          masked
          invalid={rejected()}
          onChange={(v) => secret.set(v)}
          onSubmit={() => void signIn()}
        />
      </View>
      <If when={busy()}>
        <View class="gap-1.5" accessibilityLiveRegion="polite">
          <Each of={STEPS} key="index">
            {(step, index) => (
              <View class="flex-row items-center gap-2">
                <If when={index() === 0} else={<Text class={cx(TEXT.caption, "w-3.5 text-center")}>·</Text>}>
                  <Icon name="loading" size={14} class="text-text-secondary animate-spin motion-reduce:animate-none" />
                </If>
                <Text class={index() === 0 ? TEXT.body : TEXT.caption}>{step()}</Text>
              </View>
            )}
          </Each>
        </View>
      </If>
      <If when={signedIn() && !rejected()}>
        <View class="gap-1">
          <Text class={TEXT.body}>{host() !== "" ? "Signed in · " + host() + " · " + scheme() : "Signed in"}</Text>
          <If when={sendingRefused()}>
            <Note tone="warning" text="Sending is not offered: this credential cannot submit mail." />
          </If>
        </View>
      </If>
      <If when={rejected()}>
        <View class={cx("p-3 border border-warning bg-inset", RADIUS)}>
          <Text class={cx(TEXT.caption, "leading-relaxed")}>
            The server rejected that app password or API token. Enter it again — it may have expired or been revoked.
          </Text>
        </View>
      </If>
      <ErrorLine text={rejected() ? "" : error()} />
      <Disclosure
        testID="jmap-server-disclosure"
        open={serversOpen()}
        label={host() !== "" ? "Server settings — " + host() : "Server settings"}
        openLabel="Hide the server settings"
        onToggle={() => serversOpen.set(!serversOpen())}
      />
      <If when={serversOpen()}>
        <View class="gap-3">
          <TextField
            testID="setup-server"
            value={server()}
            label="Server"
            placeholder="Server — mail.example.org, or the full session URL"
            onChange={(v) => server.set(v)}
          />
          <TextField
            testID="setup-username"
            value={username()}
            label="Username"
            placeholder="Username — only if it is not the address"
            onChange={(v) => username.set(v)}
          />
          <Note text="Left empty, the server is looked up from the address's domain. HTTPS only, and the credential goes to the server that answered and to the addresses inside its own session object." />
        </View>
      </If>
      <View class="flex-row gap-2">
        <If when={!signedIn() && !rejected()}>
          <Button
            testID="setup-connect"
            variant="primary"
            label={busy() ? "Checking" : "Connect the mailbox"}
            loading={busy()}
            disabled={busy() || address().trim() === "" || secret() === ""}
            onPress={() => void signIn()}
          />
        </If>
        <If when={rejected()}>
          <Button
            testID="setup-sign-in-again"
            variant="primary"
            label={busy() ? "Checking" : "Sign in again"}
            loading={busy()}
            disabled={busy() || secret() === ""}
            onPress={() => void signIn()}
          />
        </If>
        <If when={signedIn() && !rejected()}>
          <Button
            testID="setup-save"
            variant="primary"
            label={busy() ? "Checking" : "Save changes"}
            loading={busy()}
            disabled={busy()}
            onPress={() => void signIn()}
          />
        </If>
      </View>
      <AccountFooter
        signedIn={signedIn() && !rejected()}
        canRemove={props.context.canRemove()}
        busy={busy()}
        onSignOut={() => void signOut()}
        onRemove={() => void props.context.remove().then((p) => p && error.set(p))}
      />
    </View>
  );
}
