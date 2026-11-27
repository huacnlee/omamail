// Feature entry: the shell imports only what this file exports.
// The AI dock and what other features call to use it:
// - `registerAssistantHost` (host.ts): the mail features supply message
//   summaries, reply envelopes and the composer's proposal and outbox hooks.
// - `assistant` (store.ts): openFor / openForSelection / openForDraft / close.
// - `askAboutCurrent`: the Alt+G action (also bound by the dock itself).
// - `aiSettings` (settings.ts): Settings → AI reads and writes the agent,
//   the model and the "start fresh chats" cutoff.
// - `runner` (service.ts): job state for the list's glyphs and the reader's
//   event suggestions (`jobFor`, `eventLooks`, `wantsAttention`).
export { AssistantDock, askAboutCurrent, clampDock, dockWidths } from "./AssistantDock";
export { registerAssistantHost, type AssistantHost, type AssistantComposer, type DeliveryState, type MessageSummary } from "./host";
export { assistant } from "./store";
export { aiSettings, AI_DEFAULTS, parseAiSettings, type AiSettings } from "./settings";
export { runner, agentAvailable, agentCapable, diagnose, recordBackendError, sendProposal } from "./service";
