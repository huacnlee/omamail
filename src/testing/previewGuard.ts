// Keeps previews and fixtures off the real backend in tests. Headless,
// `open(entry, { modules: guard.modules })` replaces every export of
// `omamail-native` with a stand-in that records the call and fails; the test
// ends with `assertGuarded(guard)`. Calls a test means to allow are given
// as `answers` (recorded apart, in `answered`).
//
//   const { app, guard } = await openGuarded("./PreviewApp.tsx", { width: 1100, height: 760 });
//   ...
//   assertGuarded(guard);
//
// The guard fails closed. With `--target` the runtime takes no stand-ins
// (ERR_NSH_TEST_UNSUPPORTED); `openGuarded` then opens unguarded and accepts
// that only once the run proves it is on a real platform (`app.screenshot()`,
// which rejects headless). Any other refusal throws, so a headless run can
// never pass the leak check without stand-ins in place.
import { expect, open } from "nsh/test";

type OpenOptions = NonNullable<Parameters<typeof open>[1]>;
type Modules = NonNullable<OpenOptions["modules"]>;
type StandIn = (...args: any[]) => unknown;

/** Every export of omamail-native (see .nsh/types/omamail-native.d.ts). A
 * member added there must be added here, or the guard lets it through;
 * `node scripts/check-native-members.ts` fails until it is. */
export const NATIVE_MEMBERS = [
  "Backend.request",
  "Backend.sendAnalyticsBatch",
  "Backend.writeAnalyticsConsent",
  "Backend.nextEvent",
  "Backend.shutdown",
  "Backend.readConfig",
  "Backend.writeConfig",
  "Backend.openDownload",
  "Backend.os",
  "Backend.omarchyFont",
  "Backend.isOmarchy",
  "Backend.launchMailto",
  "Diagnostics.openAgent",
  "MailClient.status",
  "MailClient.setDefault",
  "MailClient.migrateLegacy",
] as const;

export interface NativeGuard {
  /** Pass as `open(entry, { modules })`. */
  modules: Modules;
  /** Unexpected calls, as "Backend.request system.info" or "Backend.readConfig". */
  calls: string[];
  /** Calls the test allowed through `answers`, in the same form. */
  answered: string[];
  /** Fails the test when anything reached the native module unasked. */
  assertNoCalls(): void;
}

export interface GuardOptions {
  /** Stand-ins the test allows, by member ("Backend.request"): their result
   * is what the app gets (a function's result, as a promise). */
  answers?: Partial<Record<(typeof NATIVE_MEMBERS)[number], StandIn>>;
  /** What `Backend.os()` returns (default "macos"); a value, so the app's
   * synchronous call stays synchronous and is not counted. */
  os?: string;
  /** What `Backend.omarchyFont()` returns (default null: the ui layer's
   * default family and size, never the machine's shell.toml). */
  omarchyFont?: unknown;
  /** What `Backend.isOmarchy()` returns (default false: never the machine's desktop). */
  isOmarchy?: boolean;
  /** What `MailClient.status()` returns (default "unsupported", which hides
   * the setting; `setDefault` stays a recorded, failing call). */
  mailClientStatus?: string;
  /** What `Backend.launchMailto()` returns (default null: launched without a
   * `mailto:` link, never this test runner's own arguments). */
  launchMailto?: string | null;
}

function describe(member: string, args: unknown[]): string {
  return member === "Backend.request" ? member + " " + String(args[0]) : member;
}

export function guardNative(options: GuardOptions = {}): NativeGuard {
  const calls: string[] = [];
  const answered: string[] = [];
  const native: Record<string, {} | null | StandIn> = {};
  for (const member of NATIVE_MEMBERS) {
    // Synchronous reads take a value, so the app's call stays synchronous
    // and is not counted: they change nothing and reach no account.
    if (member === "Backend.os") {
      native[member] = options.os ?? "macos";
      continue;
    }
    if (member === "Backend.omarchyFont") {
      native[member] = (options.omarchyFont ?? null) as {} | null;
      continue;
    }
    if (member === "Backend.isOmarchy") {
      native[member] = options.isOmarchy ?? false;
      continue;
    }
    if (member === "Backend.launchMailto") {
      native[member] = options.launchMailto ?? null;
      continue;
    }
    // Never the machine's bindings or mailto default: nothing to move.
    if (member === "MailClient.migrateLegacy") {
      native[member] = false;
      continue;
    }
    if (member === "MailClient.status") {
      native[member] = options.mailClientStatus ?? "unsupported";
      continue;
    }
    const answer = options.answers?.[member];
    native[member] = (...args: unknown[]) => {
      if (answer) {
        answered.push(describe(member, args));
        return answer(...args);
      }
      calls.push(describe(member, args));
      throw new Error("preview_guard: " + describe(member, args));
    };
  }
  return {
    modules: { "omamail-native": native },
    calls,
    answered,
    assertNoCalls() {
      expect(calls).toEqual([]);
    },
  };
}

export type GuardedApp = Awaited<ReturnType<typeof open>>;

/** The guard of an `openGuarded` run. `guarded` is false only on a run the
 * runtime refused stand-ins and that proved to be on a real platform
 * (`--target`): there `assertNoCalls` checks nothing, and the headless run of
 * the same test is the leak check. */
export interface OpenedGuard extends NativeGuard {
  guarded: boolean;
}

const REFUSED = "ERR_NSH_TEST_UNSUPPORTED";

/** True when the app runs on a real platform: `screenshot` rejects headless
 * (it needs a real platform), and nsh/test names no target otherwise. */
async function onRealPlatform(app: Pick<GuardedApp, "screenshot">): Promise<boolean> {
  try {
    await app.screenshot();
    return true;
  } catch {
    return false;
  }
}

/** `openGuarded` with the opener given; exported for its own tests. */
export async function openGuardedWith<App extends Pick<GuardedApp, "screenshot">>(
  opener: (entry: string, options: OpenOptions) => Promise<App>,
  entry: string,
  options: Omit<OpenOptions, "modules"> = {},
  guardOptions: GuardOptions = {},
): Promise<{ app: App; guard: OpenedGuard }> {
  const guard = guardNative(guardOptions);
  let refusal: unknown;
  try {
    return { app: await opener(entry, { ...options, modules: guard.modules }), guard: { ...guard, guarded: true } };
  } catch (error) {
    if ((error as { code?: string }).code !== REFUSED) throw error;
    refusal = error;
  }
  const app = await opener(entry, options);
  if (!(await onRealPlatform(app)))
    throw new Error(
      "preview_guard: the runtime refused native stand-ins on a headless run, so this test cannot check for leaks: " +
        String((refusal as Error).message ?? refusal),
    );
  return { app, guard: { ...guard, guarded: false, assertNoCalls() {} } };
}

/** Opens `entry` with the guard in place. Headless it always is; under
 * `--target` it is not, and the returned guard says so (`guarded: false`).
 * Throws when stand-ins were refused anywhere else. */
export function openGuarded(
  entry: string,
  options: Omit<OpenOptions, "modules"> = {},
  guardOptions: GuardOptions = {},
): Promise<{ app: GuardedApp; guard: OpenedGuard }> {
  return openGuardedWith(open as (entry: string, options: OpenOptions) => Promise<GuardedApp>, entry, options, guardOptions);
}

/** Ends a guarded test: fails when anything reached the native module
 * unasked, or when there is no guard at all. A run without stand-ins passes
 * only when `openGuarded` proved it to be on a real platform. */
export function assertGuarded(guard: OpenedGuard | null | undefined): void {
  if (!guard) throw new Error("preview_guard: no guard; open the app with openGuarded");
  guard.assertNoCalls();
}
