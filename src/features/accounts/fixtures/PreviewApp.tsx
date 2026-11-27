// A screenshot entry for the provider picker, the setup forms and Settings,
// drawn on a real platform (`nsh test --target macos`) with no backend: every
// call is answered here (usePreviewBackend), so nothing reads this machine's
// accounts, keychain, configuration or settings, and no browser is opened.
// Synthetic addresses only. Opened by preview.test.tsx.
import { useMemoryCalendarConfig } from "../../calendar";
import { mount, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { prefs } from "../../../app/prefs";
import { app } from "../../../app/store";
import { usePreviewBackend } from "../../../backend/client";
import { useKeyRouter } from "../../../keys/router";
import { Button, Omarchy, setOmarchyFont } from "../../../ui";
import { startTheme } from "../../../ui/theme";
import { SettingsPage } from "../../settings";
import { settings } from "../../settings/store";
import { AccountSetup } from "..";
import { previewMode } from "../flows";

const REGISTRY = {
  version: 1,
  activeId: "imap:jane@example.org",
  accounts: [
    {
      id: "imap:jane@example.org",
      provider: "imap",
      email: "jane@example.org",
      label: "",
      senderName: "Jane Doe",
      imap: { host: "imap.example.org", port: 993, smtpHost: "smtp.example.org", smtpPort: 465, username: "jane@example.org" },
    },
    {
      id: "m365:ops@example.net",
      provider: "m365",
      email: "ops@example.net",
      label: "Work",
      clientId: "00000000-0000-4000-8000-000000000001",
    },
  ],
};

/** The registry the last `accounts.save` wrote, and how many sign-ins began: the CJK fixture shows them as probes. */
const saved = signal<any>(null);
const signIns = signal(0);
let revision = 0;

function answer(method: string, params?: any): unknown {
  switch (method) {
    case "system.info":
      return { name: "omamail", version: "0.12.0", protocol: 1, apiVersion: 10, methods: [], capabilities: { agent: true } };
    case "accounts.read":
      return { revision: "preview-" + revision, registry: saved() ?? REGISTRY };
    case "accounts.save":
      // Through JSON, as the backend's pipe carries it: what reads back is what a reload would see.
      saved.set(JSON.parse(JSON.stringify(params?.registry ?? null)));
      revision += 1;
      return { revision: "preview-" + revision };
    case "credentials.get":
      return { found: false };
    case "m365.signInBegin":
      signIns.update((n) => n + 1);
      return { requestId: "preview-request", userCode: "WDJB-MJHT", verificationUri: "https://microsoft.com/devicelogin", interval: 30 };
    case "m365.signInPoll":
      return { state: "pending" };
    case "m365.verify":
      return { ok: true, roles: {} };
    default:
      throw new Error("preview");
  }
}

/** `name=value` texts a test reads (the CJK fixture only). */
function Probes() {
  const field = (key: string) => {
    const list = saved()?.accounts;
    const row = Array.isArray(list) ? list.find((a: any) => a.id === "imap:jane@example.org") : null;
    return row ? String(row[key] ?? "") : "";
  };
  return (
    <View class="absolute bottom-0 left-0 opacity-0">
      <Text>{"page=" + app.navPage().kind}</Text>
      <Text>{"signins=" + signIns()}</Text>
      <Text>{"label=" + field("label")}</Text>
      <Text>{"sender=" + field("senderName")}</Text>
      <Text>{"signature=" + JSON.stringify(field("signature"))}</Text>
    </View>
  );
}

function Harness(props: { probes?: boolean }) {
  useKeyRouter();
  const kind = () => app.navPage().kind;
  return (
    <View class="flex-1 bg-background">
      <If when={kind() === "settings"}>
        <SettingsPage />
      </If>
      <If when={kind() === "picker" || kind() === "setup"}>
        <AccountSetup />
      </If>
      <If when={kind() !== "settings" && kind() !== "picker" && kind() !== "setup"}>
        <View class="flex-1 items-center justify-center gap-3">
          <Text class="text-sm text-text-secondary">Accounts preview</Text>
          <Button testID="preview-picker" label="Add a mailbox..." onPress={() => app.push("picker")} />
          <Button testID="preview-settings" label="Settings..." onPress={() => app.openPage("settings")} />
        </View>
      </If>
      <If when={props.probes}>
        <Probes />
      </If>
    </View>
  );
}

/** The three palettes of Visual language v2: Omamail's own ink (dark) and paper (light), and Omarchy's (tokyo-night). */
export type PreviewLook = "ink" | "paper" | "omarchy";

const APPEARANCE = { ink: "Dark", paper: "Light", omarchy: "Omarchy" } as const;

/** Mounts the preview in one palette, through the Theme setting, at Omarchy's base size or `baseSize`. */
export function mountPreview(look: PreviewLook, baseSize?: number, probes = false) {
  if (baseSize) setOmarchyFont({ family: null, baseSize });
  usePreviewBackend((method, params) => answer(method, params));
  previewMode();
  prefs.useMemory();
  useMemoryCalendarConfig();
  settings.preview({ appearance: APPEARANCE[look] });
  mount(() => {
    startTheme();
    // The Omarchy mode follows the desktop; a preview draws a fixed Omarchy theme instead.
    if (look === "omarchy") Omarchy.applyTheme("tokyo-night");
    return (
      <Window id="main" title="Omamail" defaultSize={{ width: 1180, height: 800 }}>
        {() => <Harness probes={probes} />}
      </Window>
    );
  });
}
