// IMAP setup: an address, a password, and the servers a preset or the domain
// suggests. Port of components/ImapSetupPage.qml and ImapAuth.qml's sign-in.
// The password is verified by reading the folders with it, then stored in the
// keyring; it is never kept in the registry or shown again.
import { cleanup, signal, Text, untracked, View } from "nsh";
import * as Accounts from "../../mail/accounts";
import * as Aliases from "../../mail/aliases";
import * as Imap from "../../mail/providers/imap";
import { Button, cx, Disclosure, RADIUS, TEXT, toast } from "../../ui";
import type { SetupContext } from "./context";
import { Abort, credentialPresent, deleteCredential, imapSignIn, openExternal } from "./flows";
import { AccountFooter, ErrorLine, Hero, NameField, Note, TextField } from "./parts";

export function ImapSetup(props: { context: SetupContext }) {
  const initial = untracked(() => props.context.account());
  const saved = initial?.imap;
  const address = signal(initial?.email ?? "");
  const password = signal("");
  const name = signal(initial?.label ?? "");
  const sender = signal(initial?.senderName ?? "");
  const configured = !!saved && saved.imapHost !== "";
  const imapHost = signal(configured ? saved!.imapHost : "");
  const imapPort = signal(configured ? String(saved!.imapPort) : String(Imap.DEFAULT_IMAP_PORT));
  const smtpHost = signal(configured ? saved!.smtpHost : "");
  const smtpPort = signal(configured ? String(saved!.smtpPort) : String(Imap.DEFAULT_SMTP_PORT));
  const username = signal(saved?.username ?? "");
  const aliases = signal(saved ? Aliases.format(saved.aliases) : "");
  // Servers typed by hand are never overwritten by a suggestion.
  let serversTouched = configured;
  const serversOpen = signal(false);
  const error = signal("");
  const busy = signal(false);
  const signedIn = signal(false);
  const abort = new Abort();
  cleanup(() => abort.stop());

  const suggestion = () => Imap.suggestedSettings(address());

  if (initial?.id) {
    void credentialPresent("imap-password", initial.id)
      .then((found) => !abort.stopped && signedIn.set(found))
      .catch(() => {});
  }

  function applySuggestion() {
    if (serversTouched) return;
    const next = Imap.suggestedSettings(address());
    imapHost.set(next.imapHost);
    imapPort.set(String(next.imapPort));
    smtpHost.set(next.smtpHost);
    smtpPort.set(String(next.smtpPort));
  }

  function currentSettings() {
    return Imap.setupSettings({
      address: address(),
      imapHost: imapHost().trim(),
      imapPort: imapPort(),
      smtpHost: smtpHost().trim(),
      smtpPort: smtpPort(),
      username: username(),
      aliases: aliases(),
    });
  }

  function validatedAddress(): string {
    const value = address().trim();
    if (Accounts.isValidEmail(value)) return value;
    error.set(value === "" ? "Add the email address for this mailbox" : "That is not a full email address");
    return "";
  }

  function values(email: string, settings: Imap.Settings): Partial<Accounts.Account> {
    return { provider: "imap", email, imap: { ...settings, tenant: "" }, label: name().trim(), senderName: sender() };
  }

  async function connect() {
    if (busy()) return;
    const email = validatedAddress();
    if (!email) return;
    const check = Imap.validateSettings(currentSettings());
    if (!check.ok) {
      error.set(check.error);
      return;
    }
    error.set("");
    // Written before the password is tried: a refused mailbox keeps its settings to correct.
    if (!props.context.configure(values(email, check.settings))) return;
    busy.set(true);
    const id = Accounts.accountId(email, "imap");
    const problem = await imapSignIn(id, check.settings, password());
    if (abort.stopped) return;
    busy.set(false);
    if (problem) {
      error.set(problem);
      return;
    }
    // Stored means done with: left in the field, the next save would verify it again.
    password.set("");
    signedIn.set(true);
    props.context.reportSignedIn(true);
    if (props.context.adding) props.context.finish();
    else toast({ title: "Signed in", kind: "success" });
  }

  function save() {
    if (password() !== "") {
      void connect();
      return;
    }
    const email = validatedAddress();
    if (!email) return;
    const check = Imap.validateSettings(currentSettings());
    if (!check.ok) {
      error.set(check.error);
      return;
    }
    error.set("");
    if (props.context.configure(values(email, check.settings))) toast({ title: "Saved", kind: "success" });
  }

  async function signOut() {
    const account = props.context.account();
    if (!account?.id) return;
    if (await deleteCredential("imap-password", account.id)) {
      signedIn.set(false);
      props.context.reportSignedIn(false);
    }
    else error.set("The saved password could not be removed");
  }

  return (
    <View class="gap-5">
      <Hero
        provider="imap"
        title="Add a mailbox"
        detail="Any mailbox that speaks IMAP — Fastmail, iCloud, Zoho, a server of your own. The address is usually all it takes."
      />
      <View class="gap-3">
        <NameField value={name()} onChange={(v) => name.set(v)} />
        <TextField
          testID="setup-sender-name"
          value={sender()}
          label="Your name"
          placeholder="Your name (optional) — shown to recipients as the sender"
          onChange={(v) => sender.set(v)}
        />
        <TextField
          testID="setup-address"
          value={address()}
          label="Email address"
          placeholder="Email address — you@example.com"
          onChange={(v) => {
            address.set(v);
            applySuggestion();
          }}
        />
        <If when={suggestion().note !== ""}>
          <View class={cx("gap-2 p-3 border border-border bg-inset", RADIUS)}>
            <Text class={cx(TEXT.caption, "leading-relaxed")}>{suggestion().note}</Text>
            <If when={suggestion().guideUrl !== ""}>
              <View class="flex-row">
                <Button
                  size="small"
                  variant="ghost"
                  icon="external-link"
                  label={suggestion().guideLabel + "..."}
                  onPress={() => void openExternal(suggestion().guideUrl)}
                />
              </View>
            </If>
          </View>
        </If>
        <TextField
          testID="setup-password"
          value={password()}
          label="Password"
          placeholder="Password, or app password"
          masked
          onChange={(v) => password.set(v)}
          onSubmit={() => (signedIn() ? save() : void connect())}
        />
      </View>
      <ErrorLine text={error()} />
      <Disclosure
        testID="imap-server-disclosure"
        open={serversOpen()}
        label="Server settings"
        openLabel="Hide the server settings"
        onToggle={() => serversOpen.set(!serversOpen())}
      />
      <If when={serversOpen()}>
        <View class="gap-3">
          <View class="flex-row gap-2">
            <View class="flex-1">
              <TextField
                testID="setup-imap-host"
                value={imapHost()}
                label="IMAP server"
                placeholder="IMAP server"
                onChange={(v) => {
                  serversTouched = true;
                  imapHost.set(v);
                }}
              />
            </View>
            <View class="w-28">
              <TextField
                testID="setup-imap-port"
                value={imapPort()}
                label="IMAP port"
                placeholder="IMAP port"
                onChange={(v) => {
                  serversTouched = true;
                  imapPort.set(v.replace(/[^0-9]/g, ""));
                }}
              />
            </View>
          </View>
          <View class="flex-row gap-2">
            <View class="flex-1">
              <TextField
                testID="setup-smtp-host"
                value={smtpHost()}
                label="SMTP server"
                placeholder="SMTP server — leave empty to read only"
                onChange={(v) => {
                  serversTouched = true;
                  smtpHost.set(v);
                }}
              />
            </View>
            <View class="w-28">
              <TextField
                testID="setup-smtp-port"
                value={smtpPort()}
                label="SMTP port"
                placeholder="SMTP port"
                onChange={(v) => {
                  serversTouched = true;
                  smtpPort.set(v.replace(/[^0-9]/g, ""));
                }}
              />
            </View>
          </View>
          <TextField
            testID="setup-username"
            value={username()}
            label="Username"
            placeholder="Username — only if it is not the address"
            onChange={(v) => username.set(v)}
          />
          <TextField
            testID="setup-aliases"
            value={aliases()}
            label="Send-as aliases"
            placeholder="Send-as aliases — comma-separated (e.g. alias@icloud.com (default))"
            onChange={(v) => aliases.set(v)}
          />
          <Note text="TLS on connect, or a required STARTTLS upgrade on ports 143, 25 and 587. Plain text is refused unless the server is on this machine." />
        </View>
      </If>
      <View class="flex-row gap-2">
        <If
          when={signedIn()}
          else={
            <Button
              testID="setup-connect"
              variant="primary"
              label={busy() ? "Checking" : "Connect the mailbox"}
              loading={busy()}
              disabled={busy() || address().trim() === "" || password() === ""}
              onPress={() => void connect()}
            />
          }
        >
          <Button
            testID="setup-save"
            variant="primary"
            label={busy() ? "Checking" : "Save changes"}
            loading={busy()}
            disabled={busy()}
            onPress={() => save()}
          />
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
