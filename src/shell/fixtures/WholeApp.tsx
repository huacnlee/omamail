// Whole-app acceptance entry: the real Shell with every feature mounted, on
// synthetic accounts and data only. Every backend call is answered here
// (usePreviewBackend), window.json, settings, calendars.json and credentials
// stay in memory, compose and the assistant have their own synthetic callers,
// and launch links are off. Nothing reads or writes this machine's accounts,
// configuration or mail. Shot by wholeApp.test.tsx under --target macos.
//
// Screenshot keys (fixture only): mod+shift+l light (flexoki-light),
// mod+shift+d dark (tokyo-night), mod+shift+b base size 16, mod+shift+n 14,
// mod+shift+o shows m1's content in the reader, mod+shift+h back to the inbox,
// mod+shift+i / mod+shift+p switch to Ink / Paper, mod+shift+l / mod+shift+d to
// Omarchy's flexoki-light / tokyo-night, mod+shift+k asks a synthetic question through ui confirm().
import "../../features/compose/fixtures/syntheticBackend";
import "../../features/reader/fixtures/memory";
import { batch, keymap, mount } from "nsh";
import { Window } from "nsh/desktop";
import { prefs } from "../../app/prefs";
import { usePreviewBackend } from "../../backend/client";
import { previewMode } from "../../features/accounts/flows";
import { registerAssistantHost } from "../../features/assistant/host";
import { assistant } from "../../features/assistant/store";
import { compose, discard } from "../../features/compose/store";
import { app } from "../../app/store";
import { agentCapable, runner } from "../../features/assistant/service";
import { useMemoryCalendarConfig } from "../../features/calendar/controller";
import { FIXTURE_CALENDARS, FIXTURE_EVENTS } from "../../features/calendar/testing/fixture";
import { listStore } from "../../features/list/store";
import { seedMailboxPreview } from "../../features/mailbox/store";
import { ICS, previewResource } from "../../features/reader/fixtures/sample";
import { previewMessage } from "../../features/reader/store";
import { settings } from "../../features/settings/store";
import * as Calendar from "../../mail/message/calendar";
import { hydrateSummary, type Summary } from "../../mail/listModel";
import { defaultHost, setComposeHost } from "../../mail/compose/host";
import { confirm, Omarchy, setOmarchyFont, setThemeMode } from "../../ui";
import { startTheme } from "../../ui/theme";
import { Shell } from "../Shell";

const JANE = "jane@example.com";
const SAM = "imap:sam@example.org";

const REGISTRY = {
  version: 1,
  activeId: JANE,
  accounts: [
    { id: JANE, provider: "gmail", email: JANE, label: "Jane", senderName: "Jane Doe" },
    { id: SAM, provider: "imap", email: "sam@example.org", label: "",
      imap: { host: "imap.example.org", port: 993, smtpHost: "smtp.example.org", smtpPort: 465, username: "sam@example.org" } },
  ],
};

const NOW = Date.now();
const MIN = 60000;
function row(id: string, fields: Record<string, unknown>): Summary {
  return hydrateSummary({ id, labelIds: ["INBOX"], ...fields }, new Date(NOW));
}
// Read and unread, starred, a thread, a long subject, a bare address.
const ROWS: Summary[] = [
  row("m1", { from: { name: "Ada Lovelace", email: "ada@example.com" }, subject: "Notes on the analytical engine", snippet: "I have attached the corrected tables for the second section.", dateMs: NOW - 4 * MIN, unread: true }),
  row("m2", { from: { name: "Grace Hopper" }, subject: "Compiler review on Thursday", snippet: "Can we move the review to the afternoon?", dateMs: NOW - 52 * MIN, starred: true,
    thread: { id: "t2", count: 3, unread: false, flagged: true, memberIds: ["m2", "m2b", "m2c"] } }),
  row("m3", { from: { name: "Katherine Johnson" }, subject: "Trajectory figures, a very long subject line that has to elide before the time", snippet: "", dateMs: NOW - 3 * 60 * MIN, unread: true }),
  row("m4", { from: { email: "billing@example.com" }, subject: "Your invoice is ready", snippet: "Invoice 2026-11 for the period ending November 30.", dateMs: NOW - 26 * 60 * MIN }),
  row("m5", { from: { name: "Margaret Hamilton" }, subject: "Re: priority display", snippet: "The alarms behaved exactly as designed.", dateMs: NOW - 4 * 24 * 60 * MIN, starred: true }),
  row("m6", { from: { name: "Radia Perlman" }, subject: "Spanning tree poem", snippet: "I think that I shall never see a graph more lovely than a tree.", dateMs: NOW - 40 * 24 * 60 * MIN }),
];

function answer(method: string, params: any): unknown {
  switch (method) {
    case "system.info":
      return { name: "omamail", version: "0.13.0", protocol: 1, apiVersion: 10, methods: [], capabilities: { agent: true } };
    case "accounts.read":
      return { revision: "whole-app", registry: REGISTRY };
    case "credentials.get":
      return { found: false };
    case "calendar.request":
      if (params?.operation === "list") return { status: 200, body: JSON.stringify({ items: FIXTURE_EVENTS }) };
      return { status: 200, body: JSON.stringify(FIXTURE_EVENTS.find((e) => e.id === params?.eventId) ?? FIXTURE_EVENTS[0]) };
    case "calendar.reminders":
      return { records: [], due: [] };
    case "contacts.suggest":
      return [{ name: "Ann Lee", email: "ann@example.net" }];
    default:
      return null;
  }
}

// Cut off before anything mounts.
prefs.useMemory();
useMemoryCalendarConfig(FIXTURE_CALENDARS);
previewMode();
settings.preview();
usePreviewBackend(answer);
listStore.preview({ [JANE]: ROWS, [SAM]: [] });
seedMailboxPreview({
  labels: {
    [JANE]: [
      { id: "INBOX", name: "INBOX", system: true, unread: 2 },
      { id: "L1", name: "Clients", unread: 3 },
      { id: "L2", name: "Clients/Northwind", unread: 1 },
      { id: "L3", name: "Receipts", unread: 0 },
      { id: "L4", name: "Travel", unread: 2 },
    ],
    [SAM]: [],
  },
});
setComposeHost({
  ...defaultHost,
  providerFor: () => "gmail",
  ownAddressFor: () => JANE,
  aliasesFor: () => [{ email: JANE, displayName: "Jane Doe", isPrimary: true }],
  signatureFor: () => ({ text: "", html: "" }),
  identities: async () => [{ accountId: JANE, email: JANE, displayName: "Jane Doe", isPrimary: true }],
  saveDraft: async () => ({}),
  attachment: async () => "",
});

// The assistant: one finished job on m1, answered by a fixed caller.
const JOB = "0123456789abcdef0123456789abcdef";
const now = Math.floor(Date.now() / 1000);
const job = {
  id: JOB, conversationId: JOB, accountId: JANE, messageId: "m1", state: "done", resultReady: true, canContinue: true,
  provider: "opencode", model: "", created: now, createdOrder: now * 1000000, subject: "Notes on the analytical engine", requestPreview: "Summarize",
};
const projection = {
  byMessage: { m1: job },
  byAccount: { [JANE]: { m1: job } },
  scopesByAccount: { [JANE]: { [JSON.stringify(["m1"])]: { job, history: [job], jobs: [job] } } },
};
runner.useCaller(async (method) => {
  if (method === "agent.jobsProjection") return projection;
  throw new Error("preview_offline");
});
runner.refresh = () => {};
runner.refreshAvailability = () => {
  batch(() => {
    runner.providerAvailable.set(true);
    runner.resolvedProvider.set("opencode");
  });
};
runner.show = (id: string) => {
  batch(() => {
    runner.shownId.set(id);
    runner.shownTranscript.set([
      { role: "user", text: "Summarize this message." },
      { role: "assistant", text: "**Summary.** Ada sends corrected tables for section two and asks for a review by Friday." },
    ] as any);
    runner.shownProposals.set([]);
  });
};
batch(() => {
  runner.apiVersion.set(10);
  runner.ready.set(true);
  runner.accountId.set(JANE);
  runner.jobs.set([job] as any);
  runner.byMessage.set(projection.byMessage as any);
  runner.byAccount.set(projection.byAccount as any);
  runner.scopesByAccount.set(projection.scopesByAccount as any);
  agentCapable.set(true);
});
registerAssistantHost({ hasAccount: (id) => id === JANE, composer: { routingChanged: () => false } });

/** Opens m1 (an HTML message with an invitation) in the reader. */
export function showMessage(): void {
  previewMessage("m1", previewResource(Calendar.invitationFrom(ICS, "REQUEST")));
}

/** The Omarchy mode with one of its palettes, applied once the mode has
 * switched (the mode's own effect runs first). */
function omarchyPalette(name: Parameters<typeof Omarchy.applyTheme>[0]): void {
  setThemeMode("omarchy");
  setTimeout(() => Omarchy.applyTheme(name), 0);
}

mount(() => {
  startTheme();
  omarchyPalette("tokyo-night");
  // Omarchy palettes, and Omamail's own Ink (dark) and Paper (light).
  keymap.bind("mod+shift+l", () => omarchyPalette("flexoki-light"), { when: "always" });
  keymap.bind("mod+shift+d", () => omarchyPalette("tokyo-night"), { when: "always" });
  keymap.bind("mod+shift+i", () => setThemeMode("dark"), { when: "always" });
  keymap.bind("mod+shift+p", () => setThemeMode("light"), { when: "always" });
  keymap.bind("mod+shift+b", () => setOmarchyFont({ family: null, baseSize: 16 }), { when: "always" });
  keymap.bind("mod+shift+n", () => setOmarchyFont({ family: null, baseSize: 14 }), { when: "always" });
  keymap.bind("mod+shift+o", () => showMessage(), { when: "always" });
  // A synthetic question through ui's confirm(), to see where it asks.
  keymap.bind("mod+shift+k", () => {
    void confirm({ title: "Delete the synthetic draft?", actionLabel: "Delete", tone: "danger" });
  }, { when: "always" });
  // Back to the inbox from any scene, without Escape's "close the window".
  keymap.bind("mod+shift+h", () => {
    if (compose.opened()) discard();
    assistant.close();
    app.resetNav([{ kind: "list" } as any]);
  }, { when: "always" });
  return (
    <Window id="main" title="Omamail" defaultSize={{ width: 1280, height: 800 }}>
      {() => <Shell launchLinks={false} />}
    </Window>
  );
});
