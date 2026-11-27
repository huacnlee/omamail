// The dock's rules that do not need a window: widths, stored settings, the
// runner's start gates, and the send boundary (a proposal reaches the outbox
// only as the app routed it, for the job's own account, on the owner's press).
import { expect, test } from "nsh/test";
import { clampDock, dockWidths } from "./AssistantDock";
import { registerAssistantHost } from "./host";
import { AgentRunner } from "./runner";
import { diagnose, runner, sendProposal } from "./service";
import { Storage } from "nsh";
import { aiSettings, parseAiSettings } from "./settings";
import { DiagnosticLog, diagnosticPrompt, diagnosticReport } from "./diagnostics";

const A = "imap:ada@example.com";
const B = "imap:bob@example.com";
const JOB = "0123456789abcdef0123456789abcdef";

test("the dock's widths follow the window as App.qml set them", () => {
  expect(dockWidths(1600)).toEqual({ min: 280, max: 1040, preferred: 420 });
  expect(clampDock(0, 1600)).toBe(420);
  expect(clampDock(5000, 1600)).toBe(1040);
  expect(clampDock(100, 1600)).toBe(280);
  // A small window clamps the stored width without forgetting it.
  expect(clampDock(900, 800)).toBe(480);
  expect(dockWidths(500).min).toBe(180);
  // At base-size 16 (8/7 of 14) the floor, default and reserved room grow.
  const big = (n: number) => Math.round(n * (16 / 14) * 2) / 2;
  expect(dockWidths(1600, big)).toEqual({ min: 320, max: 1040, preferred: 480 });
  expect(dockWidths(800, big).max).toBe(434.5);
});

test("stored AI settings are read defensively", () => {
  expect(parseAiSettings(null)).toEqual({ agent: "OpenCode", model: "", chatResetAt: 0, dockWidth: 0 });
  expect(parseAiSettings("not json").agent).toBe("OpenCode");
  expect(parseAiSettings(JSON.stringify({ agent: "Codex", model: "gpt-5", chatResetAt: 7, dockWidth: 512.4 })))
    .toEqual({ agent: "Codex", model: "gpt-5", chatResetAt: 7, dockWidth: 512 });
  expect(parseAiSettings(JSON.stringify({ agent: "rm -rf", model: "--auto" }))).toEqual({ agent: "System default", model: "", chatResetAt: 0, dockWidth: 0 });
});

function fakeRunner(replies: Record<string, (params: any) => any>) {
  const calls: { method: string; params: any }[] = [];
  const r = new AgentRunner(async (method, params) => {
    calls.push({ method, params });
    const reply = replies[method];
    if (!reply) throw new Error("unknown_method");
    return reply(params);
  });
  return { r, calls };
}

test("a start needs an available agent, and a selection change refuses the old one", async () => {
  const { r, calls } = fakeRunner({
    "agent.providerStatus": () => ({ available: true, provider: "opencode" }),
    "agent.jobsList": () => ({ jobs: [], hasMore: false }),
    "agent.jobsProjection": () => ({}),
    "agent.jobStart": () => ({ id: JOB }),
  });
  r.setSelection("OpenCode", "", 0);
  expect(r.start({ messageId: "m", prompt: "Hi" }, false)).toBe(false);
  expect(r.lastError()).toBe("Mail backend is unavailable");
  r.attach(10);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(r.providerAvailable()).toBe(true);
  const captured = r.selection();
  r.setSelection("Codex", "", 0);
  expect(r.start({ messageId: "m", prompt: "Hi" }, false, captured)).toBe(false);
  // Refused either as a changed selection or while the new one is checked.
  expect(r.lastError() !== "").toBe(true);
  expect(calls.some((c) => c.method === "agent.jobStart")).toBe(false);
});

test("a chosen model that could be read as a flag never reaches jobStart", async () => {
  const { r, calls } = fakeRunner({
    "agent.providerStatus": () => ({ available: true, provider: "claude" }),
    "agent.jobsList": () => [],
    "agent.jobsProjection": () => ({}),
    "agent.jobStart": () => ({ id: JOB }),
  });
  r.attach(10);
  r.setSelection("Claude", "--dangerously-skip-permissions", 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(r.start({ messageId: "m", prompt: "Hi" }, false)).toBe(false);
  expect(calls.some((c) => c.method === "agent.jobStart")).toBe(false);
});

test("a proposal is sent only for its own job and account, with the app's routing", async () => {
  const sent: { envelope: any; sendId: string }[] = [];
  let routingChanged = false;
  const restore = registerAssistantHost({
    hasAccount: (id) => id === A || id === B,
    composer: {
      routingChanged: () => routingChanged,
      sendProposal: async (envelope, sendId) => {
        sent.push({ envelope, sendId });
        return { ok: true };
      },
    },
  });
  runner.jobs.set([{ id: JOB, accountId: A, state: "done" }]);
  const envelope = { accountId: A, from: "ada@example.com", to: "bob@example.com", subject: "Re: Hi", body: "Text", attachments: [] };
  try {
    // Not a proposal id, another job's proposal, another account's envelope.
    expect(await sendProposal("not-an-id", envelope, JOB)).toBe(false);
    expect(await sendProposal("ffffffffffffffffffffffffffffffff-0", envelope, JOB)).toBe(false);
    expect(await sendProposal(JOB + "-0", { ...envelope, accountId: B }, JOB)).toBe(false);
    routingChanged = true;
    expect(await sendProposal(JOB + "-0", envelope, JOB)).toBe(false);
    // The forbidden effect did not happen: nothing reached the outbox.
    expect(sent.length).toBe(0);
    routingChanged = false;
    expect(await sendProposal(JOB + "-0", envelope, JOB)).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0].sendId).toBe("agent-" + JOB + "-0");
    expect(sent[0].envelope.to).toBe("bob@example.com");
    expect(sent[0].envelope.exactBody).toBe(true);
  } finally {
    restore();
    runner.jobs.set([]);
  }
});

test("without a host, nothing can be sent", async () => {
  runner.jobs.set([{ id: JOB, accountId: A, state: "done" }]);
  try {
    const envelope = { accountId: A, to: "x@example.com", subject: "S", body: "B", attachments: [] };
    expect(await sendProposal(JOB + "-0", envelope, JOB)).toBe(false);
  } finally {
    runner.jobs.set([]);
  }
});

test("diagnostics keep known identifiers only, never server text", () => {
  const log = new DiagnosticLog();
  const at = new Date("2026-11-27T10:00:00.123Z");
  log.record("mail.send", { code: -32000, message: "smtp_delivery_unknown" }, at);
  log.record("mail.send", { code: -32000, message: "smtp_delivery_unknown" }, new Date(at.getTime() + 1000));
  log.record("mail.send", { code: -32000, message: "550 bob@example.com: user unknown, password hunter2" }, at);
  log.record("evil method; rm -rf", { code: 1.5, message: "auth_timeout" }, at);
  const entries = log.entries();
  expect(entries.length).toBe(3);
  expect(entries[0]).toEqual({ time: "2026-11-27T10:00:00Z", method: "mail.send", code: -32000, message: "smtp_delivery_unknown" });
  expect(entries[1].message).toBe("unknown_error");
  expect(entries[2]).toEqual({ time: "2026-11-27T10:00:00Z", method: "backend.request", code: null, message: "auth_timeout" });
  const prompt = diagnosticPrompt(diagnosticReport({ appVersion: "0.12.0", apiVersion: 10, os: "macos" }, entries));
  expect(prompt.includes("example.com")).toBe(false);
  expect(prompt.includes("hunter2")).toBe(false);
  expect(prompt.includes("smtp_delivery_unknown")).toBe(true);
  expect(prompt.includes("read-only investigation")).toBe(true);
});

test("when the system agent refuses or fails, Diagnose copies the report instead", async () => {
  for (const failure of ["report_invalid", "storage_unavailable", "agent_failed"]) {
    const copied: string[] = [];
    const notice = await diagnose({
      openAgent: () => Promise.reject(new Error(failure)),
      copy: (text) => {
        copied.push(text);
        return Promise.resolve("written");
      },
    });
    expect(notice).toBe("Diagnosis copied. Paste it into your AI agent.");
    expect(copied.length).toBe(1);
    expect(copied[0].includes("Omamail diagnostics")).toBe(true);
    expect(copied[0].includes("read-only investigation")).toBe(true);
  }
  // Absent: copied too; opened: nothing copied; a failed copy says so.
  const copies: string[] = [];
  const copy = (text: string) => {
    copies.push(text);
    return Promise.resolve("written" as const);
  };
  expect(await diagnose({ openAgent: () => Promise.resolve("absent"), copy })).toBe("Diagnosis copied. Paste it into your AI agent.");
  expect(await diagnose({ openAgent: () => Promise.resolve("opened"), copy })).toBe("Opened the diagnosis in your AI agent.");
  expect(copies.length).toBe(1);
  expect(
    await diagnose({ openAgent: () => Promise.reject(new Error("agent_failed")), copy: () => Promise.resolve("failed" as const) }),
  ).toBe("Could not copy the diagnosis. Try again.");
  expect(
    await diagnose({ openAgent: () => Promise.reject(new Error("agent_failed")), copy: () => Promise.reject(new Error("x")) }),
  ).toBe("Could not copy the diagnosis. Try again.");
});

test("without omarchy-agent, Diagnose falls back to the clipboard", async () => {
  const notice = await diagnose();
  expect(["Diagnosis copied. Paste it into your AI agent.", "Could not copy the diagnosis. Try again."].includes(notice)).toBe(true);
});

test("AI settings save themselves, with no dock mounted", async () => {
  aiSettings.setAgent("Codex");
  expect(aiSettings.setModel("gpt-5")).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stored = parseAiSettings(await Storage.getItem("assistant.settings.v1"));
  expect(stored.agent).toBe("Codex");
  expect(stored.model).toBe("gpt-5");
  expect(aiSettings.agent()).toBe("Codex");
});
