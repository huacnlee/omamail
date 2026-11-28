// Toasts with nsh-omarchy's look and API on nsh/base, so their text, icons
// and padding follow Omarchy's base size (nsh-omarchy draws them at Rust
// constants). `Toaster`, `toast()` and `dismissToast()` take what
// nsh-omarchy's do, so features compile unchanged.
//
// nsh/base owns the behavior: `ToastManager` keeps each toast's lifecycle and
// timeout on the engine's clock, `ToastStack` stacks them at the bottom
// right, expands under the pointer (which pauses every timeout) and hears
// Escape, and `Toast` swipes away and is read to screen readers as it shows.
// This file keeps the store and draws each notice (Visual language v2): a
// 340pt card (surface, one border, 2pt corners, a shadow), the kind's icon in
// its color, the title 13pt semibold bright, the description 12pt muted, a
// bordered action in primary text, and a close button.
import { Overlay, Text, View, cleanup, signal, untracked, type Signal } from "nsh";
import { Button as BaseButton, Toast as BaseToast, ToastManager, ToastStack, type ToastEntry, type ToastMotion } from "nsh/base";
import { scaled } from "./font";
import { Icon, type IconKey } from "./Icon";
import { cx } from "./tokens";

/** Milliseconds a toast stays unless it sets its own `timeout` (an error stays until dismissed). */
export const TOAST_TIMEOUT = 6000;

/** What a toast is about: its icon and color. */
export type ToastKind = "info" | "success" | "warning" | "error";

/** A notice for `toast`. */
export interface Toast {
  /** The notice ("Settings saved"). */
  title: string;
  /** Secondary text under the title. */
  description?: string;
  /** What it is about: its icon and color (default `info`). */
  kind?: ToastKind;
  /** A button that runs `onAction`, then dismisses the toast. */
  action?: { label: string; onAction: () => void };
  /** Milliseconds it stays (default `TOAST_TIMEOUT`; an error stays); `null` stays until dismissed. */
  timeout?: number | null;
  /** Names it: toasting an id that is shown replaces that toast. */
  id?: string;
}

/** nsh-omarchy's name for the same shape. */
export type ToastOptions = Toast;

const VISIBLE = 3;
const WIDTH = 340;
const TICK_MS = 50;
const DURATION = 140; // nsh-omarchy DURATION_BASE
const FAST = "duration-[90ms]"; // DURATION_FAST

const KIND: Record<ToastKind, { icon: IconKey; color: string }> = {
  info: { icon: "info", color: "text-primary" },
  success: { icon: "success", color: "text-success" },
  warning: { icon: "warning", color: "text-warning" },
  error: { icon: "error", color: "text-danger" },
};

/** A toast as the store keeps it: the app's id and the notice. */
interface Shown {
  id: string;
  toast: Toast;
}

// ---- The store --------------------------------------------------------------
// One mounted Toaster at a time, as in nsh-omarchy. Timed replacements get
// a new key and timeout; a persistent notice updates in place so its
// countdown does not replay the entrance motion.

interface Store {
  manager: ToastManager;
  /** The stack's entries to draw, oldest first. */
  shown: ReturnType<typeof signal<ToastEntry[]>>;
  /** The stack is expanded: timeouts stand still. */
  paused: boolean;
  timer: number | null;
}

let store: Store | null = null;
/** The key shown for each app id. */
const keys = new Map<string, string>();
/** Each key's toast: the manager keeps plain data, not the action's function. */
const notices = new Map<string, Signal<Shown>>();
/** Toasts shown before a Toaster mounted. */
let pending: Shown[] = [];
let count = 0;

function nextKey(): string {
  count += 1;
  return `toast-${count}`;
}

function timeoutOf(t: Toast): number | null {
  if (t.timeout !== undefined) return t.timeout === null ? null : Math.max(0, t.timeout);
  return t.kind === "error" ? null : TOAST_TIMEOUT;
}

function sync(s: Store): void {
  s.shown.set(s.manager.visible(VISIBLE));
}

/** Advances the lifecycle every tick while any toast is mounted, then stops. */
function tick(s: Store): void {
  if (s.timer !== null) return;
  s.timer = setInterval(() => {
    const advanced = s.manager.advance(s.paused);
    for (const gone of advanced.removed) {
      forget(gone.id);
      notices.delete(gone.id);
    }
    if (advanced.changed) sync(s);
    if (s.manager.isEmpty()) stop(s);
  }, TICK_MS);
}

function stop(s: Store): void {
  if (s.timer !== null) clearInterval(s.timer);
  s.timer = null;
}

function place(s: Store, shown: Shown): void {
  const old = keys.get(shown.id);
  if (old !== undefined) {
    const notice = notices.get(old);
    const active = s.manager.entries().some((e) => e.id === old && e.status !== "ending");
    if (active && notice && timeoutOf(notice().toast) === null && timeoutOf(shown.toast) === null) {
      notice.set(shown);
      return;
    }
    s.manager.dismiss(old);
  }
  const key = nextKey();
  keys.set(shown.id, key);
  notices.set(key, signal(shown));
  s.manager.push(key, null, { timeout: timeoutOf(shown.toast) });
  sync(s);
  tick(s);
}

/** Shows `toast` in the app's `Toaster` (or once one mounts): its id, for `dismissToast`. */
export function toast(t: Toast): string {
  const id = t.id ?? nextKey();
  const shown = { id, toast: t };
  if (store) place(store, shown);
  else pending = [...pending.filter((p) => p.id !== id), shown];
  return id;
}

/** Dismisses the toast `id` (nothing when it is not shown). */
export function dismissToast(id: string): void {
  if (!store) {
    pending = pending.filter((p) => p.id !== id);
    return;
  }
  const key = keys.get(id);
  if (key === undefined) return;
  keys.delete(id);
  if (store.manager.dismiss(key)) sync(store);
}

/** Drops the app id that points at `key`. */
function forget(key: string): void {
  for (const [id, k] of keys) if (k === key) keys.delete(id);
}

function dismissKey(key: string): void {
  if (!store) return;
  forget(key);
  if (store.manager.dismiss(key)) sync(store);
}

function dismissNewest(): void {
  if (!store) return;
  const newest = store.manager.entries().filter((e) => e.status !== "ending").pop();
  if (newest) dismissKey(newest.id);
}

// ---- The view ---------------------------------------------------------------

function motion(): ToastMotion {
  return { duration: DURATION, exitDuration: DURATION, collapsedPeek: scaled(8), expandedGap: scaled(8) };
}

export interface ToasterProps {
  testID?: string;
}

/**
 * Where toasts show: the window's bottom right. Place it once, at the root,
 * after the content. The pointer on the stack expands it and pauses every
 * timeout; Escape dismisses the newest, a swipe right or its close button
 * one; screen readers read each as it shows.
 */
export function Toaster(props: ToasterProps) {
  const s: Store = { manager: new ToastManager(motion()), shown: signal<ToastEntry[]>([]), paused: false, timer: null };
  store = s;
  const early = pending;
  pending = [];
  for (const shown of early) place(s, shown);
  cleanup(() => {
    stop(s);
    if (store === s) store = null;
    keys.clear();
    notices.clear();
    s.manager.dispose();
  });
  return (
    <Overlay
      testID={props.testID}
      style={{ right: scaled(16), bottom: scaled(16), width: scaled(WIDTH), maxWidth: "100%" }}
    >
      <ToastStack
        placement="bottomRight"
        motion={motion()}
        class="w-full"
        onExpandedChange={(e) => (s.paused = e.expanded)}
        onCancel={dismissNewest}
      >
        <Each of={s.shown()} key={(e) => e.id}>
          {(entry) => <Notice entry={entry} />}
        </Each>
      </ToastStack>
    </Overlay>
  );
}

function Notice(props: { entry: () => ToastEntry }) {
  const key = untracked(() => props.entry().id);
  const notice = notices.get(key)!;
  const id = untracked(() => notice().id);
  const t = () => notice().toast;
  const kind = () => KIND[t().kind ?? "info"];
  const spoken = () => t().description ? `${t().title}. ${t().description}` : t().title;
  return (
    <BaseToast
      testID={`toast-${id}`}
      transitionStatus={props.entry().status}
      accessibilityLabel={spoken()}
      onDismissRequest={() => dismissKey(key)}
      class={cx("flex-row w-full border border-border rounded-(--radius) bg-surface shadow-md text-foreground transition-all duration-[140ms]")}
      startingClass={cx("opacity-0 translate-y-2")}
      endingClass={cx("opacity-0 translate-x-4")}
      swipingClass="transition-none"
    >
      <View style={{ paddingLeft: scaled(12), paddingTop: scaled(14) }}>
        <Icon name={kind().icon} size={16} class={kind().color} />
      </View>
      <View
        class="flex-1"
        style={{ minWidth: 0, gap: scaled(4), paddingVertical: scaled(12), paddingLeft: scaled(8) }}
      >
        <Text class={`text-[${scaled(13)}px] font-semibold text-bright`}>{t().title}</Text>
        <If when={t().description}>
          <Text class={`text-[${scaled(12)}px] text-text-secondary`}>{t().description}</Text>
        </If>
        <If when={t().action}>
          <View class="flex-row" style={{ paddingTop: scaled(4) }}>
            <BaseButton
              testID={`toast-${id}-action`}
              accessibilityLabel={t().action!.label}
              onPress={() => {
                t().action!.onAction();
                dismissKey(key);
              }}
              class={cx(
                "flex-row items-center justify-center rounded-(--radius) border border-border",
                `transition-colors ${FAST} hover:bg-surface-raised active:bg-selection`,
                "focus-visible:border-primary",
              )}
              style={{ height: scaled(26), paddingHorizontal: scaled(12) }}
            >
              <Text class={`text-[${scaled(13)}px] text-primary`}>{t().action!.label}</Text>
            </BaseButton>
          </View>
        </If>
      </View>
      <View style={{ padding: scaled(4) }}>
        <BaseButton
          testID={`toast-${id}-close`}
          accessibilityLabel="Dismiss notification"
          onPress={() => dismissKey(key)}
          class={cx(
            "items-center justify-center rounded-(--radius) border border-transparent",
            `transition-colors ${FAST} hover:bg-surface-raised active:bg-selection`,
            "focus-visible:border-primary",
          )}
          style={{ width: scaled(24), height: scaled(24) }}
        >
          <Icon name="close" size={16} class="text-text-secondary" />
        </BaseButton>
      </View>
    </BaseToast>
  );
}
