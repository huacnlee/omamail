import { appInfo, cleanup, platform, Storage } from "nsh";
import { createNsMetry, describePlatform, useNsMetry, useScreenTracking, type WireEvent } from "nsmetry";
import { app } from "../../app/store";
import { sendAnalyticsBatch } from "../../backend/client";
import { AlertDialog, Checkbox, SettingRow, toast } from "../../ui";
import { analyticsConsent } from "./consent";

const ENDPOINT = "https://nsmetry.huacnlee-account.workers.dev";
const BATCH_URL = ENDPOINT + "/api/events/batch";
const SITE = "omamail";
const SCREENS = {
  list: "/mail",
  reader: "/message",
  compose: "/compose",
  calendar: "/calendar",
  calendarDetail: "/calendar",
  eventComposer: "/calendar",
  settings: "/settings",
  picker: "/accounts",
  setup: "/accounts",
} as const;
const paths = new Set<string>(Object.values(SCREENS));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function saveChoice(allowed: boolean) {
  if (analyticsConsent.saving()) return;
  void analyticsConsent.save(allowed).catch(() => {
    toast({
      title: "Could not save the analytics preference",
      kind: "error",
      action: allowed ? undefined : { label: "Retry", onAction: () => saveChoice(false) },
    });
  });
}

export function Analytics() {
  void analyticsConsent.load();
  return (
    <>
      <AlertDialog
        testID="analytics-consent"
        open={analyticsConsent.choice() === null && !analyticsConsent.saving()}
        title="Share anonymous usage statistics?"
        description="Help improve Omamail by sharing which features you open, your app and operating system versions, and your country. Statistics use a random installation ID. Your email address, messages, and account details stay out of statistics. Change your choice in Settings → Privacy."
        actionLabel="Allow"
        cancelLabel="Don’t allow"
        onAction={() => saveChoice(true)}
        onOpenChange={(e) => {
          if (!e.open && analyticsConsent.choice() === null) saveChoice(false);
        }}
      />
      <If when={analyticsConsent.choice() === true}>
        <ScreenTracking />
      </If>
    </>
  );
}

export function AnalyticsSetting() {
  return (
    <SettingRow
      title="Anonymous usage statistics"
      description="Share feature usage, app and operating system versions, and country. Omamail uses a random installation ID for statistics."
    >
      <Checkbox
        testID="analytics-setting"
        label=""
        accessibilityLabel="Anonymous usage statistics"
        checked={analyticsConsent.choice() === true}
        disabled={analyticsConsent.choice() === undefined || analyticsConsent.saving()}
        onChange={(e) => saveChoice(e.checked)}
      />
    </SettingRow>
  );
}

function ScreenTracking() {
  const appVersion = appInfo().version ?? "0.0.0";
  const ua = describePlatform(platform)?.replace(/^\S+/, `Omamail/${appVersion}`);
  const client = createNsMetry({
    endpoint: ENDPOINT,
    site: SITE,
    persistUserId: true,
    flushInterval: 30_000,
    appVersion,
    ua,
    storage: {
      async getItem(key) {
        const stored = await Storage.getItem(key);
        return stored && uuid.test(stored) ? stored : null;
      },
      setItem: (key, value) => Storage.setItem(key, value),
    },
    fetch: async (url, init) => {
      if (analyticsConsent.choice() !== true || url !== BATCH_URL || typeof init.body !== "string") {
        return new Response(null, { status: 400 });
      }
      const batch: { events: WireEvent[] } = JSON.parse(init.body);
      // The only analytics payload fields Omamail allows. This also omits
      // the SDK's exact window width, custom properties and referrer. Require a
      // random ID so NsMetry never falls back to an IP/user-agent hash.
      const events = batch.events
        .filter((event) => event.name === "screen_view" && paths.has(event.url) && uuid.test(event.user_id ?? ""))
        .map(({ url, ts, user_id }) => ({
          name: "screen_view",
          url,
          ts,
          user_id,
          app_version: appVersion,
          ua,
        }));
      if (events.length === 0) return new Response(null, { status: 400 });
      const status = await sendAnalyticsBatch(JSON.stringify({ site: SITE, events }));
      return new Response(null, { status });
    },
  });
  useNsMetry(client);
  useScreenTracking(client, () => {
    const kind = app.navOverlay()?.kind;
    if (kind === "compose" || kind === "eventComposer") return SCREENS[kind];
    const page = app.navPage().kind;
    return page === "help" ? null : SCREENS[page];
  });
  cleanup(() => client.setEnabled(false));
  return null;
}
