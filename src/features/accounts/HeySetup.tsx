// HEY setup: the HEY CLI does the signing in and keeps the token; this page
// checks it is installed, starts its browser sign-in and learns the address.
// Port of components/HeySetupPage.qml and providers/HeyAuth.qml.
import { cleanup, Clipboard, signal, Text, untracked, View } from "nsh";
import * as Accounts from "../../mail/accounts";
import { Button, cx, RADIUS, TEXT, toast } from "../../ui";
import { listStore } from "../list/store";
import type { SetupContext } from "./context";
import { Abort, heyProfileEmail, heyProgram, heySignedIn, heySignIn, heySignOut, openExternal } from "./flows";
import { ErrorLine, Hero, NameField, Note, Progress } from "./parts";

const INSTALL = "curl -fsSL https://hey.com/install-cli | bash";
const CLI_URL = "https://github.com/basecamp/hey-cli";

export function HeySetup(props: { context: SetupContext }) {
  const initial = untracked(() => props.context.account());
  const name = signal(initial?.label ?? "");
  const checked = signal(false);
  const program = signal("");
  const signedIn = signal(false);
  const busy = signal(false);
  const error = signal("");
  let flow = new Abort();
  cleanup(() => flow.stop());

  const address = () => props.context.account()?.email ?? "";

  async function probe() {
    checked.set(false);
    const found = await heyProgram();
    if (flow.stopped) return;
    program.set(found);
    checked.set(true);
    if (!found) return;
    const ok = await heySignedIn();
    if (flow.stopped) return;
    signedIn.set(ok);
    // A CLI already signed in is the mailbox: it is named and opened, as the Qt client did.
    if (ok && props.context.adding && (await learnAddress()) && !flow.stopped) props.context.finish();
  }
  void probe();

  async function learnAddress() {
    const email = await heyProfileEmail();
    if (!email) {
      error.set("HEY could not complete this request");
      return false;
    }
    if (name().trim() !== "") props.context.configure({ label: name().trim() });
    props.context.name(email);
    const id = Accounts.accountId(email, "hey");
    if (id) listStore.setProviderContext(id, { heyProgram: program() });
    return true;
  }

  async function signIn() {
    if (busy()) return;
    error.set("");
    busy.set(true);
    flow = new Abort();
    const problem = await heySignIn(flow);
    if (flow.stopped) return;
    busy.set(false);
    if (problem) {
      error.set(problem);
      return;
    }
    const ok = await heySignedIn();
    signedIn.set(ok);
    if (!ok) return;
    props.context.reportSignedIn(true);
    if (!(await learnAddress())) return;
    if (props.context.adding) props.context.finish();
  }

  function cancel() {
    flow.stop();
    flow = new Abort();
    busy.set(false);
  }

  async function signOut() {
    const problem = await heySignOut();
    if (problem) error.set(problem);
    else {
      signedIn.set(false);
      props.context.reportSignedIn(false);
    }
  }

  async function copyInstall() {
    const outcome = await Clipboard.writeText(INSTALL).catch(() => "failed");
    toast({ title: outcome === "failed" ? "The command could not be copied" : "Command copied", kind: outcome === "failed" ? "error" : "success" });
  }

  return (
    <View class="gap-5">
      <Hero
        provider="hey"
        title="Add a HEY mailbox"
        detail="HEY does not speak IMAP or POP. Omamail reads it through the HEY CLI, the client 37signals publish for exactly this — install it once, then sign in here."
      />
      <NameField value={name()} onChange={(v) => name.set(v)} />
      <If when={!checked()}>
        <Progress text="Checking for the HEY CLI…" />
      </If>
      <If when={checked() && program() === ""}>
        <View class={cx("gap-3 p-4 border border-border bg-surface", RADIUS)}>
          <View class="flex-row items-center gap-1">
            <Text class={cx(TEXT.body, "font-semibold")}>Install the</Text>
            <Button size="small" variant="ghost" label="HEY CLI..." onPress={() => void openExternal(CLI_URL)} />
          </View>
          <Text class={TEXT.caption}>Run this in a terminal:</Text>
          <View class={cx("flex-row items-center gap-2 px-3 py-2 border border-border bg-inset", RADIUS)}>
            <View selectable class="flex-1">
              <Text class={cx(TEXT.body, TEXT.mono)}>
                {INSTALL}
              </Text>
            </View>
            <Button size="small" icon="copy" label="Copy" onPress={() => void copyInstall()} />
          </View>
          <Note text="Recent versions of Omarchy install it for you — omarchy-mise-install github:basecamp/hey-cli hey does the same thing. Either way it lands in ~/.local/bin." />
          <View class="flex-row">
            <Button testID="hey-check-again" label="Check again" onPress={() => void probe()} />
          </View>
        </View>
      </If>
      <If when={checked() && program() !== "" && !signedIn()}>
        <View class={cx("gap-3 p-4 border border-border bg-surface", RADIUS)}>
          <Text class={cx(TEXT.body, "font-semibold")}>Sign in to HEY</Text>
          <Note text="This opens HEY in your browser. The token comes back to the HEY CLI, which keeps it in your keyring and refreshes it — Omamail never holds it and never asks for your HEY password." />
          <View class="flex-row items-center gap-3">
            <If
              when={busy()}
              else={<Button testID="hey-sign-in" variant="primary" label="Sign in to HEY..." onPress={() => void signIn()} />}
            >
              <Button testID="hey-cancel" label="Cancel" onPress={() => cancel()} />
              <Progress text="Waiting for the browser" />
            </If>
          </View>
        </View>
      </If>
      <If when={signedIn()}>
        <View class={cx("gap-1 p-4 border border-border bg-surface", RADIUS)}>
          <Text class={cx(TEXT.body, "font-semibold")}>Connected</Text>
          <Text class={TEXT.caption}>
            {address() !== "" ? address() + " — signed in through the HEY CLI." : "Signed in through the HEY CLI."}
          </Text>
        </View>
      </If>
      <ErrorLine text={error()} />
      <View class="gap-1.5">
        <Text class={cx(TEXT.body, "font-semibold")}>What is different about HEY</Text>
        <Note text="No star and no archive — HEY has neither. A thread is moved to Set Aside, Reply Later or Paper Trail instead, and those are mailboxes in the rail. No Sent either: the HEY CLI does not serve one yet. Reading, marking read, replying, searching, labels and reporting spam all work. A row here is one conversation rather than one message, and attachments and the Screener stay in HEY's own app." />
      </View>
      <If when={signedIn() || props.context.canRemove()}>
        <View class="gap-2 pt-2 border-t border-border">
          <View class="flex-row gap-2">
            <If when={signedIn()}>
              <Button testID="setup-sign-out" variant="ghost" label="Sign out of HEY" onPress={() => void signOut()} />
            </If>
            <If when={props.context.canRemove()}>
              <Button
                testID="setup-remove"
                variant="danger"
                icon="trash"
                label="Remove account"
                onPress={() => void props.context.remove().then((p) => p && error.set(p))}
              />
            </If>
          </View>
          <If when={signedIn()}>
            <Note text="Signing out signs the HEY CLI out, so anything else on this machine that uses it — the HEY terminal app, the bar plugin — is signed out too." />
          </If>
        </View>
      </If>
    </View>
  );
}
