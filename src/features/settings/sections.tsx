// The general sections of Settings: the mail backend, appearance, reading,
// notifications, writing's undo window, AI, keyboard and the Google client.
// Port of components/SettingsPage.qml, BackendSetup.qml and AiSettings.qml.
import { appInfo, cleanup, signal, Text, View } from "nsh";
import { MailClient } from "omamail-native";
import { app } from "../../app/store";
import { call } from "../../backend/client";
import { AGENTS } from "../../mail/agent/options";
import * as Google from "../../mail/providers/google";
import { Button, Checkbox, cx, Hint, SettingRow, Input, SegmentedControl, Select, Stepper, TEXT, toast } from "../../ui";
import { diagnose } from "../assistant";
import { googleClient } from "../accounts/flows";
import { checkForUpdates } from "../../shell/updates";
import { accountsStore } from "../../mail/accounts-store";
import * as Model from "./model";
import { settings } from "./store";

// ---------------------------------------------------------------- backend

export function BackendSection() {
  const state = signal<"checking" | "ready" | "failed">("checking");
  const version = signal("");
  const apiVersion = signal(0);
  const diagnosing = signal(false);
  let live = true;
  cleanup(() => (live = false));

  async function check() {
    state.set("checking");
    try {
      const info = await call<any>("system.info", {});
      if (!live) return;
      version.set(String(info?.version ?? ""));
      apiVersion.set(Number(info?.apiVersion) || 0);
      state.set("ready");
    } catch {
      if (live) state.set("failed");
    }
  }
  void check();

  async function runDiagnosis() {
    diagnosing.set(true);
    const notice = await diagnose();
    diagnosing.set(false);
    toast({ title: notice });
  }

  const status = () =>
    state() === "checking"
      ? "Checking the mail backend"
      : state() === "ready"
        ? "Bundled backend " + version() + " is ready."
        : "The bundled mail backend could not start.";

  return (
    <View>
      <SettingRow
        testID="backend-status"
        title={status()}
        description="Included with this app. Reinstall this version if the bundled backend is missing or damaged."
      >
        <Button
          testID="backend-refresh"
          size="small"
          label="Retry"
          disabled={state() === "checking"}
          onPress={() => void check()}
        />
      </SettingRow>
      <SettingRow title="Version" description="Omamail checks for a new version at launch and asks before it updates.">
        <Text testID="backend-version-label" class={cx(TEXT.caption, TEXT.mono)} accessibilityLiveRegion="polite">
          {"Omamail " + (appInfo().version ?? "unknown") + (apiVersion() > 0 ? " · backend API " + apiVersion() : "")}
        </Text>
        <Button testID="settings-check-updates" size="small" label="Check for Updates..." onPress={() => checkForUpdates()} />
      </SettingRow>
      <SettingRow
        title="Diagnose"
        description="Writes a report without addresses, subjects or message text, and opens it in your AI agent — or copies it, to paste there."
      >
        <Button
          testID="settings-diagnose"
          size="small"
          label="Diagnose with AI..."
          loading={diagnosing()}
          disabled={diagnosing()}
          onPress={() => void runDiagnosis()}
        />
      </SettingRow>
    </View>
  );
}

// ---------------------------------------------------------------- appearance

export function AppearanceSection() {
  return (
    <SettingRow
      title="Theme"
      description="System follows the desktop's light or dark setting. Omarchy follows the desktop's theme."
      testID="settings-theme"
    >
      <SegmentedControl
        label="Theme"
        options={Model.APPEARANCE.map((value) => ({ value, label: value }))}
        value={settings.appearance()}
        onChange={(value) => settings.setAppearance(value)}
      />
    </SettingRow>
  );
}

// ---------------------------------------------------------------- reading

/**
 * An on / off setting as a row like every other: its name and what it means
 * on the left, the box on the right, so labels and controls keep the page's
 * two spines. The box is named by the title.
 */
function CheckRow(props: {
  testID: string;
  title: string;
  description: string;
  checked: boolean;
  onChange: (event: { checked: boolean }) => void;
}) {
  return (
    <SettingRow title={props.title} description={props.description} testID={props.testID + "-row"}>
      <Checkbox
        testID={props.testID}
        label=""
        accessibilityLabel={props.title}
        checked={props.checked}
        onChange={(e) => props.onChange(e)}
      />
    </SettingRow>
  );
}

const BODY_MODES = [
  { value: "reader" as const, label: "Reader" },
  { value: "original" as const, label: "Original" },
  { value: "plain" as const, label: "Plain text" },
];

export function ReadingSection() {
  const zoomPercent = () => Math.round(settings.bodyZoom() * 100);
  return (
    <View>
      <SettingRow
        title="Show messages as"
        description="Reader keeps the words and pictures in one quiet column; Original draws the sender's layout. A message can still be switched in the reader."
      >
        <SegmentedControl
          label="Show messages as"
          options={BODY_MODES}
          value={settings.bodyMode()}
          onChange={(value) => settings.setBodyMode(value)}
        />
      </SettingRow>
      <SettingRow title="Text size" description="How large message bodies are drawn. The interface is unaffected.">
        <View class="flex-row items-center gap-2">
          <Stepper
            testID="settings-body-zoom"
            name="Text size"
            value={zoomPercent() + "%"}
            onStep={(dir) => settings.setBodyZoom(Model.zoomAfterStep(settings.bodyZoom(), dir * 0.1))}
          />
          <Button
            size="small"
            variant="ghost"
            label="Reset"
            disabled={zoomPercent() === 100}
            onPress={() => settings.resetBodyZoom()}
          />
        </View>
      </SettingRow>
      <CheckRow
        testID="settings-always-show-images"
        title="Always show remote images"
        description="Loading an image tells its host that this address opened the message, and when"
        checked={settings.alwaysShowImages()}
        onChange={(e) => settings.setAlwaysShowImages(e.checked)}
      />
      <CheckRow
        testID="settings-always-render-heavy"
        title="Always render heavy messages"
        description="Renders without falling back first; layout can stall the shell while it works"
        checked={settings.alwaysRenderHeavyMessages()}
        onChange={(e) => settings.setAlwaysRenderHeavy(e.checked)}
      />
      <SettingRow title="Message direction" description="Auto reads it from the message's own text. The interface is unaffected.">
        <SegmentedControl
          label="Message direction"
          options={Model.DIRECTION.map((value) => ({ value, label: value }))}
          value={settings.contentDirection()}
          onChange={(value) => settings.set("contentDirection", value)}
        />
      </SettingRow>
      <CheckRow
        testID="settings-suggest-events"
        title="Suggest calendar events from mail"
        description="Uses the selected AI agent and model: a message from a person that names a time is sent to it once when opened, which spends tokens. Notifications, newsletters and lists are skipped. Nothing is written until you Add."
        checked={settings.suggestEvents()}
        onChange={(e) => settings.set("suggestEvents", e.checked)}
      />
    </View>
  );
}

// ---------------------------------------------------------------- notifications

export function NotificationsSection() {
  return (
    <CheckRow
      testID="settings-notify-new-mail"
      title="New mail notifications"
      description="Send a desktop notification when new mail arrives in your inbox"
      checked={settings.notifyNewMail()}
      onChange={(e) => settings.setNotifyNewMail(e.checked)}
    />
  );
}

// ---------------------------------------------------------------- writing: undo send

export function UndoSendRow() {
  return (
    <SettingRow
      title="Undo send window"
      description="Omamail waits before delivery. Press alt+z or select Undo to cancel. Set 0 to send now."
    >
      <View>
        <Stepper
          testID="settings-undo-send"
          name="Undo send window, seconds"
          value={settings.undoSendSeconds() + " s"}
          onStep={(dir) => settings.set("undoSendSeconds", Model.normalizeUndoSend(settings.undoSendSeconds() + dir))}
        />
      </View>
    </SettingRow>
  );
}

// ---------------------------------------------------------------- AI

export function AiSection() {
  const model = signal(settings.aiModel());
  const error = signal("");
  function saveModel() {
    if (settings.setModel(model())) error.set("");
    else error.set("Use a model ID without spaces or control characters (up to 200 characters).");
  }
  return (
    <View>
      <SettingRow title="Agent">
        <Select
          testID="settings-ai-agent"
          accessibilityLabel="Agent"
          items={AGENTS.map((label) => ({ value: label, label }))}
          value={settings.aiAgent()}
          onChange={(e) => settings.setAgent(e.value)}
        />
      </SettingRow>
      <SettingRow title="Model (optional)" stacked>
        <Input
          testID="settings-ai-model"
          value={model()}
          placeholder="Agent default"
          accessibilityLabel="Model"
          invalid={error() !== ""}
          onChange={(e) => model.set(e.value)}
          onSubmit={() => saveModel()}
        />
        <View class="flex-row">
          <Button size="small" label="Save model" disabled={model().trim() === settings.aiModel()} onPress={() => saveModel()} />
        </View>
        <Hint
          tone={error() !== "" ? "danger" : "default"}
          text={
            error() ||
            "System default follows Omarchy. Leave the model blank to use the agent's default. OpenCode takes provider/model or provider/model#variant; Codex and Claude take model names. Changing the agent or model starts fresh chats. Previous chats remain read-only in History."
          }
        />
      </SettingRow>
    </View>
  );
}

// ---------------------------------------------------------- default mail client

/** Linux only (omamail-native MailClient): elsewhere the desktop owns the choice, and the section is not shown. */
export function mailClientSupported(): boolean {
  try {
    return MailClient.status() !== "unsupported";
  } catch {
    return false;
  }
}

const MAIL_CLIENT_ERRORS: Record<string, string> = {
  mailto_entry_failed: "Omamail's mailto: entry could not be written to the applications folder",
  mailto_default_failed: "xdg-mime could not make Omamail the mailto: handler",
  bindings_unreadable: "The Hyprland bindings file could not be read",
  bindings_unwritable: "The Hyprland bindings file could not be changed",
  bindings_too_large: "The Hyprland bindings file is too large to change",
};

/**
 * Whether mailto: links and SUPER+SHIFT+E open Omamail (SettingsPage.qml's
 * default mail client row). Asked when the section opens, because either
 * half can change behind the window's back.
 */
export function MailClientSection() {
  const state = signal("");
  const busy = signal(false);
  const error = signal("");
  function refresh() {
    try {
      state.set(MailClient.status());
    } catch {
      state.set("not-default");
    }
  }
  refresh();
  const isDefault = () => state() === "default";
  function toggle() {
    if (busy() || state() === "") return;
    busy.set(true);
    error.set("");
    try {
      const said = MailClient.setDefault(!isDefault());
      toast({ title: said, kind: "success" });
    } catch (failure) {
      const code = failure instanceof Error ? failure.message : String(failure);
      error.set(MAIL_CLIENT_ERRORS[code] ?? "Could not change the default mail client");
    }
    busy.set(false);
    refresh();
  }
  return (
    <View class="gap-2">
      <SettingRow
        testID="settings-mail-client"
        title={isDefault() ? "Omamail is the default mail client" : "Set up Omamail as the default mail client"}
        description="Opens mailto: links, SUPER+SHIFT+E, and SUPER+SHIFT+ALT+E for a new message."
      >
        <Button
          testID="settings-mail-client-toggle"
          size="small"
          label={isDefault() ? "Undo" : "Set as default"}
          accessibilityLabel={
            isDefault()
              ? "Give SUPER+SHIFT+E back to Omarchy's own email binding"
              : "Make Omamail open mailto: links and SUPER+SHIFT+E"
          }
          loading={busy()}
          disabled={busy() || state() === ""}
          onPress={toggle}
        />
      </SettingRow>
      <If when={error() !== ""}>
        <Hint tone="danger" text={error()} />
      </If>
    </View>
  );
}

// ---------------------------------------------------------------- keyboard

export function KeyboardSection() {
  return (
    <SettingRow title="Keyboard shortcuts" description="Every action has a key. Press ? anywhere to see them.">
      <Button testID="settings-shortcuts" size="small" label="Show shortcuts..." onPress={() => app.push("help")} />
    </SettingRow>
  );
}

// ---------------------------------------------------------------- the Google client

/**
 * The Google client's setup: on the Gmail mailbox's setup page, or a new
 * Gmail draft's when there is none. Opened from the OAuth client section and,
 * as in Qt's openClientSetup, from the calendars' "Advanced Google setup...".
 */
export function openGoogleClientSetup() {
  const gmail = accountsStore.accounts().find((a) => a.provider === "gmail" && a.id);
  if (gmail) {
    app.push("setup", { provider: "gmail", accountId: gmail.id });
    return;
  }
  accountsStore.addDraft("gmail");
  app.push("setup", { provider: "gmail", draft: true });
}

export function GoogleClientSection() {
  const configured = signal(false);
  let live = true;
  cleanup(() => (live = false));
  void googleClient("").then((found) => live && configured.set(Google.isConfigured(found.client)));

  return (
    <SettingRow
      title={configured() ? "Google client configured" : "Google client setup required"}
      description="Advanced setup · shared by Gmail and Google Calendar accounts"
    >
      <Button testID="settings-google-client" size="small" label={configured() ? "Change..." : "Set up..."} onPress={() => openGoogleClientSetup()} />
    </SettingRow>
  );
}
