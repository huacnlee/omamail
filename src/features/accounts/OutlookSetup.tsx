// Outlook setup: IMAP and SMTP over Microsoft sign-in (XOAUTH2), a device
// code entered on Microsoft's own page. Port of components/
// OutlookSetupPage.qml and providers/OutlookAuth.qml's mail sign-in.
import { cleanup, signal, Text, untracked, View } from "nsh";
import * as Accounts from "../../mail/accounts";
import * as Microsoft from "../../mail/providers/microsoft";
import { Button, cx, RADIUS, Switch, TEXT, toast } from "../../ui";
import type { SetupContext } from "./context";
import {
  Abort,
  openExternal,
  outlookGraphProbe,
  outlookGraphSignIn,
  outlookSignedIn,
  outlookSignIn,
  outlookSignOut,
  type DeviceCode,
} from "./flows";
import { AccountFooter, DeviceCodeBox, ErrorLine, Hero, Note, Progress, TextField } from "./parts";

const TENANT_ERROR = "That is not a Microsoft Entra Directory (tenant) ID or domain";

export function OutlookSetup(props: { context: SetupContext }) {
  const initial = untracked(() => props.context.account());
  const savedTenant = Microsoft.normalizeTenant(initial?.imap.tenant);
  const address = signal(initial?.email ?? "");
  const clientId = signal(initial?.clientId ?? "");
  const sender = signal(initial?.senderName ?? "");
  const work = signal(savedTenant !== "consumers");
  const tenant = signal(savedTenant !== "consumers" && savedTenant !== "organizations" ? savedTenant : "");
  const graph = signal(initial?.imap.send === "graph");
  const error = signal("");
  const busy = signal(false);
  const stage = signal("");
  const code = signal<DeviceCode | null>(null);
  const signedIn = signal(false);
  // Graph's own consent, for a tenant that sends through Graph (OutlookAuth.qml graphConsentNeeded).
  const graphNeeded = signal(false);
  const graphNote = signal("");
  const codePurpose = signal<"mail" | "graph">("mail");
  const builtin = Microsoft.hasBuiltinClient();
  let flow = new Abort();
  cleanup(() => flow.stop());

  if (initial?.id) {
    void outlookSignedIn(initial.id).then(async (state) => {
      if (flow.stopped) return;
      signedIn.set(state === "signedIn");
      if (state !== "signedIn" || initial.imap.send !== "graph") return;
      const probe = await outlookGraphProbe(initial.id);
      if (flow.stopped) return;
      graphNeeded.set(probe === "needed");
      if (probe !== "needed" && probe !== "granted") graphNote.set(probe);
    });
  }

  async function allowGraph() {
    const account = props.context.account();
    if (busy() || !account?.id) return;
    error.set("");
    graphNote.set("");
    busy.set(true);
    flow = new Abort();
    codePurpose.set("graph");
    const problem = await outlookGraphSignIn(
      { accountId: account.id, clientId: account.clientId, tenant: account.imap.tenant, email: account.email },
      (next) => code.set(next),
      (text) => stage.set(text),
      flow,
    );
    if (flow.stopped) return;
    busy.set(false);
    stage.set("");
    code.set(null);
    if (problem) graphNote.set(problem);
    else {
      graphNeeded.set(false);
      toast({ title: "Microsoft Graph allowed", kind: "success" });
    }
  }

  function validatedAddress(): string {
    const value = address().trim();
    if (Accounts.isValidEmail(value)) return value;
    error.set(value === "" ? "Add the Outlook or Hotmail address" : "That is not a full email address");
    return "";
  }

  function validatedClientId(): string {
    const value = builtin && clientId().trim() === "" ? Microsoft.effectiveClientId("") : clientId().trim();
    if (Microsoft.isValidClientId(value)) return value;
    error.set(value === "" ? "Add the Application (client) ID from Microsoft Entra" : "That is not a Microsoft Application (client) ID");
    return "";
  }

  function validatedTenant(): string {
    if (!work()) return "";
    const value = Microsoft.workTenant(tenant());
    if (value !== "") return value;
    error.set(TENANT_ERROR);
    return "";
  }

  function accountValues(): Partial<Accounts.Account> | null {
    const email = validatedAddress();
    if (!email) return null;
    const client = validatedClientId();
    if (!client) return null;
    const workTenant = validatedTenant();
    if (work() && workTenant === "") return null;
    const send = work() && graph() ? "graph" : "";
    const imap = { ...Microsoft.outlookSettings(email, workTenant, send), tenant: workTenant };
    return { provider: "outlook", email, clientId: client, clientSecret: "", imap, senderName: sender() };
  }

  function save() {
    const values = accountValues();
    if (!values) return;
    error.set("");
    if (props.context.configure(values)) toast({ title: "Saved", kind: "success" });
  }

  async function signIn() {
    if (busy()) return;
    const values = accountValues();
    if (!values) return;
    error.set("");
    if (!props.context.configure(values)) return;
    busy.set(true);
    flow = new Abort();
    const result = await outlookSignIn(
      {
        accountId: Accounts.accountId(values.email, "outlook"),
        clientId: String(values.clientId),
        tenant: values.imap!.tenant,
        settings: values.imap as any,
        email: values.email,
      },
      (next, purpose) => {
        codePurpose.set(purpose ?? "mail");
        code.set(next);
      },
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
    if (result.graphError) {
      // The mailbox is signed in: only Graph waits, and the page says how to ask again.
      graphNeeded.set(true);
      graphNote.set(result.graphError);
      return;
    }
    graphNeeded.set(false);
    if (props.context.adding) props.context.finish();
    else toast({ title: "Signed in", kind: "success" });
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
    if (await outlookSignOut(account.id, account.clientId)) {
      signedIn.set(false);
      props.context.reportSignedIn(false);
    }
    else error.set("Could not update the saved Microsoft session");
  }

  return (
    <View class="gap-5">
      <Hero
        provider="outlook"
        title="Add an Outlook mailbox"
        detail="Outlook.com and Hotmail use Microsoft sign-in. Omamail never sees your password."
      />
      <View class="gap-3">
        <TextField
          testID="setup-address"
          value={address()}
          label="Outlook address"
          placeholder="Outlook, Hotmail or Microsoft 365 address"
          disabled={busy()}
          onChange={(v) => address.set(v)}
        />
        <If when={!builtin}>
          <TextField
            testID="setup-client-id"
            value={clientId()}
            label="Microsoft Application (client) ID"
            placeholder="Microsoft Application (client) ID"
            disabled={busy()}
            onChange={(v) => clientId.set(v)}
          />
        </If>
        <TextField
          testID="setup-sender-name"
          value={sender()}
          label="Your name"
          placeholder="Your name (optional) — shown to recipients as the sender"
          onChange={(v) => sender.set(v)}
        />
        <Switch
          testID="outlook-work"
          label="Work or school account (Microsoft 365)"
          checked={work()}
          disabled={busy()}
          onChange={(e) => work.set(e.checked)}
        />
        <If when={work()}>
          <View class="gap-3 pl-6">
            <TextField
              testID="setup-tenant"
              value={tenant()}
              label="Directory (tenant) ID or domain"
              placeholder="Directory (tenant) ID or domain — blank for multitenant"
              invalid={error() === TENANT_ERROR}
              disabled={busy()}
              onChange={(v) => {
                tenant.set(v);
                if (error() === TENANT_ERROR) error.set("");
              }}
            />
            <Switch
              testID="outlook-graph"
              label="Send through Microsoft Graph (the tenant has SMTP switched off)"
              checked={graph()}
              disabled={busy()}
              onChange={(e) => graph.set(e.checked)}
            />
          </View>
        </If>
      </View>
      <ErrorLine text={error()} />
      <If when={graphNote() !== ""}>
        <Note tone="warning" text={graphNote()} />
      </If>
      <If when={!signedIn()}>
        <View class={cx("gap-2 p-3 border border-border bg-inset", RADIUS)}>
          <Note text="Enable IMAP in Outlook.com before signing in. Under Settings > Mail > Forwarding and IMAP, turn on Let devices and apps use IMAP, then save." />
          <View class="flex-row">
            <Button
              size="small"
              variant="ghost"
              icon="external-link"
              label="Open Outlook IMAP help..."
              onPress={() => void openExternal(Microsoft.OUTLOOK_IMAP_HELP_URL)}
            />
          </View>
        </View>
      </If>
      <If when={!builtin && !signedIn()}>
        <View class={cx("gap-2 p-4 border border-border bg-surface", RADIUS)}>
          <Text class={cx(TEXT.body, "font-semibold")}>One-time Microsoft app setup</Text>
          <Note
            text={
              work()
                ? "1. Register the app in this Microsoft Entra tenant, or as multitenant. 2. Under Authentication, enable public client flows. 3. For a single-tenant app, copy its Directory (tenant) ID above; leave it blank for a multitenant app. 4. Copy its Application (client) ID above. Omamail requests only IMAP, SMTP and offline access when you sign in."
                : "1. Register an app for personal Microsoft accounts. 2. Under Authentication, enable public client flows. 3. Copy its Application (client) ID above. Omamail requests only IMAP, SMTP and offline access when you sign in."
            }
          />
          <View class="flex-row">
            <Button
              size="small"
              variant="ghost"
              icon="external-link"
              label="Open Microsoft Entra app registrations..."
              onPress={() => void openExternal(Microsoft.ENTRA_APPS_URL)}
            />
          </View>
        </View>
      </If>
      <If when={busy() && code()}>
        <DeviceCodeBox
          code={code()!.userCode}
          uri={code()!.verificationUri}
          instructions={
            codePurpose() === "graph"
              ? "One more code, to allow Microsoft Graph (sending and the calendar). Enter it on the Microsoft page opened in your browser:"
              : "Enter this code on the Microsoft page opened in your browser:"
          }
          reopenLabel="Open Microsoft sign-in again..."
        />
      </If>
      <Progress text={busy() && !code() ? stage() || "Finish the sign-in in your browser…" : ""} />
      <View class="flex-row gap-2">
        <If when={!signedIn()}>
          <Button
            testID="setup-sign-in"
            variant="primary"
            label="Sign in with Microsoft..."
            loading={busy()}
            disabled={busy() || address().trim() === "" || (!builtin && clientId().trim() === "")}
            onPress={() => void signIn()}
          />
        </If>
        <If when={busy()}>
          <Button testID="setup-cancel" label="Cancel" onPress={() => cancel()} />
        </If>
        <If when={signedIn() && graphNeeded()}>
          <Button
            testID="setup-allow-graph"
            variant="primary"
            label="Allow Microsoft Graph..."
            loading={busy()}
            disabled={busy()}
            onPress={() => void allowGraph()}
          />
        </If>
        <If when={signedIn()}>
          <Button testID="setup-save" variant="primary" label="Save changes" disabled={busy()} onPress={() => save()} />
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
