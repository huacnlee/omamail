// The AI settings and the dock's width, kept in NSH Storage. The settings
// page reads and writes them through `aiSettings` (Settings → AI); the dock
// reads them. The Qt client kept the first three in the plugin's settings
// (`aiAgent`, `aiModel`, `aiChatResetAt`); the standalone app starts from
// OpenCode, as the plugin's standalone path did, rather than "System
// default", which needs Omarchy's own choice.
import { Storage, signal } from "nsh";
import { agent, validModel, type AgentChoice } from "../../mail/agent";

const KEY = "assistant.settings.v1";

export interface AiSettings {
  agent: AgentChoice;
  model: string;
  /** When the owner last asked for fresh chats: chats from before cannot continue. */
  chatResetAt: number;
  /** The dock's width in points; 0 is the proportional default. */
  dockWidth: number;
}

export const AI_DEFAULTS: AiSettings = { agent: "OpenCode", model: "", chatResetAt: 0, dockWidth: 0 };

/** Reads what a stored value says, ignoring anything malformed. */
export function parseAiSettings(text: string | null): AiSettings {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    data = {};
  }
  const model = typeof data.model === "string" && validModel(data.model.trim()) ? data.model.trim() : "";
  const number = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return {
    agent: data.agent === undefined ? AI_DEFAULTS.agent : agent(data.agent),
    model,
    chatResetAt: number(data.chatResetAt),
    dockWidth: Math.round(number(data.dockWidth)),
  };
}

const state = signal<AiSettings>({ ...AI_DEFAULTS });
const ready = signal(false);
let loading = false;
/** Changes made before the stored value arrived: they win over it. */
let early: Partial<AiSettings> = {};

function save() {
  Storage.setItem(KEY, JSON.stringify(state())).catch(() => {
    // A full store keeps the session's settings; nothing else to do.
  });
}

/** Reads the stored settings once (on first use, from any caller). */
function load() {
  if (loading) return;
  loading = true;
  Storage.getItem(KEY)
    .then((text) => state.set({ ...parseAiSettings(text), ...early }))
    .catch(() => {
      // Unreadable storage: start from the defaults.
    })
    .finally(() => {
      ready.set(true);
      if (Object.keys(early).length > 0) save();
      early = {};
    });
}

/** Applies a change and stores it: the settings page needs no dock mounted. */
function change(patch: Partial<AiSettings>) {
  load();
  state.update((s) => ({ ...s, ...patch }));
  if (ready()) save();
  else early = { ...early, ...patch };
}

export const aiSettings = {
  agent: () => (load(), state().agent),
  model: () => (load(), state().model),
  chatResetAt: () => (load(), state().chatResetAt),
  dockWidth: () => (load(), state().dockWidth),
  ready: () => (load(), ready()),
  setAgent(value: string) {
    change({ agent: agent(value) });
  },
  /** False (and nothing saved) for a model id that could be read as a flag. */
  setModel(value: string): boolean {
    const model = String(value || "").trim();
    if (!validModel(model)) return false;
    change({ model });
    return true;
  },
  /** Starts fresh chats: the open ones become read-only history. */
  resetChats() {
    change({ chatResetAt: Date.now() });
  },
  setDockWidth(width: number) {
    change({ dockWidth: Math.max(0, Math.round(width)) });
  },
};

/** Starts reading the stored settings. Every setter saves by itself, so this
 * only gets the load going early (the dock calls it when it mounts). */
export function persistAiSettings(): void {
  load();
}
