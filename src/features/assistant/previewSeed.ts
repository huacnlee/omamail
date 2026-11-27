// The preview's fixed chat: a done job, its transcript and a proposed reply
// for a synthetic account. Shared by PreviewApp and the CJK input fixture.
import { batch } from "nsh";
import { usePreviewBackend } from "../../backend/client";
import { registerAssistantHost } from "./host";
import { agentCapable, runner } from "./service";
import { assistant } from "./store";

const ACCOUNT = "imap:ada@example.com";
const JOB = "0123456789abcdef0123456789abcdef";
const now = Math.floor(Date.now() / 1000);

const job = {
  id: JOB, conversationId: JOB, accountId: ACCOUNT, messageId: "m1", state: "done", resultReady: true, canContinue: true,
  provider: "opencode", model: "", created: now, createdOrder: now * 1000000, subject: "Quarterly review", requestPreview: "Draft a reply",
};

const transcript = [
  { role: "user", text: "Summarize this and draft a short reply accepting Thursday." },
  {
    role: "assistant",
    text:
      "**Summary.** Bob asks to move the quarterly review to Thursday at 15:00 and wants the slides by Wednesday.\n\n" +
      "I drafted a reply that accepts the time and promises the slides. The deck is `q3-review.key`.\n\n```\nThu 15:00 – 16:00\nRoom 4B\n```",
  },
];

const proposals = [
  {
    id: JOB + "-0", jobId: JOB, applicable: true, afterTurn: 2,
    subject: "Re: Quarterly review",
    body: "Hi Bob,\n\nThursday at 15:00 works for me. I'll send the slides by Wednesday.\n\nThanks,\nAda",
    envelope: {
      accountId: ACCOUNT, from: "Ada <ada@example.com>", to: "Bob <bob@example.com>", cc: "", bcc: "", replyTo: "",
      subject: "Re: Quarterly review", body: "", replyMessageId: "m1", replyQuote: "On Mon, Bob wrote:\n> Can we move the quarterly review to Thursday?", attachments: [],
    },
  },
];

const projection = {
  byMessage: { m1: job },
  byAccount: { [ACCOUNT]: { m1: job } },
  scopesByAccount: { [ACCOUNT]: { [JSON.stringify(["m1"])]: { job, history: [job], jobs: [job] } } },
};

/** Seeds the dock with the fixed chat. `asked` hears every other runner
 * request before it fails offline (the CJK fixture shows them). */
export function seed(asked: (method: string) => void = () => {}) {
  // Every runner request is answered here: the preview never reaches the
  // backend (preview.test.tsx stubs omamail-native and asserts no calls).
  // The rest of the dock's calls (agent.context before a request) too.
  usePreviewBackend((method) => {
    asked(method);
    throw new Error("preview_offline");
  });
  runner.useCaller(async (method) => {
    if (method === "agent.jobsProjection") return projection;
    asked(method);
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
      runner.shownTranscript.set(transcript as any);
      runner.shownProposals.set(proposals as any);
    });
  };
  batch(() => {
    runner.apiVersion.set(10);
    runner.ready.set(true);
    runner.accountId.set(ACCOUNT);
    runner.jobs.set([job] as any);
    runner.byMessage.set(projection.byMessage as any);
    runner.byAccount.set(projection.byAccount as any);
    runner.scopesByAccount.set(projection.scopesByAccount as any);
    agentCapable.set(true);
  });
  runner.refreshAvailability();
  // Routing as saved; sending stays refused (the default host's sendProposal).
  registerAssistantHost({ hasAccount: (id) => id === ACCOUNT, composer: { routingChanged: () => false } });
  assistant.openFor("m1", "Quarterly review", ACCOUNT);
}
