// The AI agent and model the owner picked, and what `agent.jobStart` takes
// for them. Port of ui/agent/Options.js.

export const AGENTS = ["System default", "OpenCode", "Codex", "Claude"] as const;
export type AgentChoice = (typeof AGENTS)[number];

/** The choice as the settings hold it, or System default for anything else. */
export function agent(value: unknown): AgentChoice {
  const text = String(value || "System default");
  return (AGENTS as readonly string[]).includes(text) ? (text as AgentChoice) : "System default";
}

/** The provider id Rust takes (`opencode`, `codex`, `claude`); "" follows Omarchy. */
export function provider(value: unknown): string {
  const selected = agent(value);
  return selected === "System default" ? "" : selected.toLowerCase();
}

/** A model id that cannot be read as a flag, a space or a control character. */
export function validModel(value: string): boolean {
  return value === "" || (value.length <= 200 && /^[a-zA-Z0-9][a-zA-Z0-9._\/:#@+\-]*$/.test(value));
}

export type StartPayload = string | Record<string, unknown>;
export type StartOptions =
  | { params: { payload: StartPayload; provider?: string; model?: string }; error?: undefined }
  | { error: string; params?: undefined };

export function startOptions(payload: StartPayload, selectedAgent: unknown, selectedModel: unknown, apiVersion: unknown): StartOptions {
  let parsed: any = payload;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { params: { payload } };
    }
  }
  // Follow-ups belong to the provider and model saved with their parent.
  if (parsed && parsed.parent) return { params: { payload } };
  const model = String(selectedModel || "").trim();
  const selected = provider(selectedAgent);
  if (!validModel(model)) return { error: "Enter a model ID without spaces or control characters (up to 200 characters)." };
  if ((selected !== "" || model !== "") && !(Number(apiVersion) >= 6))
    return { error: "Update the mail backend to choose an AI agent or model (API 6 required)." };
  const params: { payload: StartPayload; provider?: string; model?: string } = { payload };
  if (selected !== "") params.provider = selected;
  if (model !== "") params.model = model;
  return { params };
}
