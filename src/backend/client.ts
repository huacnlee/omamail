// The TSX side of the mail backend: the same JSON-RPC 2.0 the Qt client spoke
// over a pipe, carried in process by `omamail-native`. One owner per state:
// the backend owns mail; this module only routes requests and notifications.
//
// Port of ui/backend/Backend.qml: request budgets, the unreleased-method
// refusal and the shutdown barrier keep their meaning; frame chunking and
// uploads are gone because nothing crosses a pipe.
import { Backend } from "omamail-native";

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** A rejected call: `code` -32010 means the backend cannot take requests. */
export class BackendError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(error: RpcError) {
    super(error.message);
    this.code = error.code;
    this.data = error.data;
  }
}

type Listener = (params: any) => void;
type ErrorListener = (method: string, error: BackendError) => void;
const listeners = new Map<string, Set<Listener>>();
const errorListeners = new Set<ErrorListener>();
let stopping = false;

type PreviewAnswer = (method: string, params: any) => unknown;
let preview: PreviewAnswer | null = null;

/**
 * Fixtures only (screenshot entries on a real platform, where native
 * stand-ins are not available): every call is answered by `answer` instead
 * of the backend, which is then never asked anything and sends no events.
 * A throw from it rejects the call as a BackendError.
 */
export function usePreviewBackend(answer: PreviewAnswer): void {
  preview = answer;
}
let pumping = false;

/** Calls `method` and resolves with its `result`; rejects with BackendError. */
export async function call<T = any>(method: string, params: object = {}): Promise<T> {
  if (stopping && method !== "system.quit") {
    throw new BackendError({ code: -32010, message: "Backend is shutting down" });
  }
  if (preview) {
    try {
      return (await preview(method, params)) as T;
    } catch (error) {
      throw failed(
        method,
        error instanceof BackendError ? error : new BackendError({ code: -32000, message: String((error as Error)?.message ?? error) }),
      );
    }
  }
  startEvents();
  let reply: any;
  try {
    reply = await Backend.request(method, params as any);
  } catch {
    throw failed(method, new BackendError({ code: -32010, message: "Backend unavailable" }));
  }
  if (reply && reply.error) throw failed(method, new BackendError(reply.error as RpcError));
  return (reply ? reply.result : null) as T;
}

function failed(method: string, error: BackendError): BackendError {
  for (const listener of [...errorListeners]) {
    try {
      listener(method, error);
    } catch {
      // A diagnostics listener never changes the caller's outcome.
    }
  }
  return error;
}

/** Hears every failed call (the Qt client's `requestFailed`), for diagnostics. */
export function onError(listener: ErrorListener): () => void {
  errorListeners.add(listener);
  return () => errorListeners.delete(listener);
}

/** Hears notifications named `method` (`mail.updated`, `outbox.*`, ...). */
export function on(method: string, listener: Listener): () => void {
  let set = listeners.get(method);
  if (!set) listeners.set(method, (set = new Set()));
  set.add(listener);
  startEvents();
  return () => set!.delete(listener);
}

function startEvents() {
  if (pumping || preview) return;
  pumping = true;
  (async () => {
    for (;;) {
      const event: any = await Backend.nextEvent();
      if (event == null) break;
      const set = listeners.get(String(event.method));
      if (!set) continue;
      for (const listener of [...set]) {
        try {
          listener(event.params);
        } catch (error) {
          console.error(`omamail: ${event.method} listener failed`, error);
        }
      }
    }
    pumping = false;
  })();
}

/** Drains the backend once, at quit, after the app's own requests. */
export async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await Backend.shutdown();
}

/** True for an error the user can retry later (offline, busy, timeout). */
export function transient(error: unknown): boolean {
  return error instanceof BackendError && (error.code === -32010 || /timeout|offline|unavailable/i.test(error.message));
}
