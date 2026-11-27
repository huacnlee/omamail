// Questions before an action that cannot be undone, asked in the window with
// the ui AlertDialog, as the Qt app asked in its own dialogs, so they follow
// the theme and Omarchy's base size. `ConfirmHost` is where they show: the
// main window mounts one. With no host mounted (a preview, another window
// only) the platform's alert asks instead, so a question is never lost.
//
// Questions asked while one is open wait their turn, first asked first.
import { cleanup, signal } from "nsh";
import { confirm as platformConfirm, type ConfirmOptions } from "nsh-omarchy";
import { AlertDialog } from "./Dialog";

export type { ConfirmOptions };

interface Asked {
  options: ConfirmOptions;
  resolve: (yes: boolean) => void;
}

const queue = signal<Asked[]>([]);
let hosts = 0;

/**
 * Asks `options.title` with one action and Cancel; true when the user chose
 * the action. Same options as nsh-omarchy's `confirm`.
 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  if (hosts === 0) return platformConfirm(options);
  return new Promise<boolean>((resolve) => queue.update((q) => [...q, { options, resolve }]));
}

/** Answers the question showing and moves to the next. */
function answer(yes: boolean): void {
  const [first, ...rest] = queue();
  if (!first) return;
  queue.set(rest);
  first.resolve(yes);
}

/** Where `confirm` asks: mount one in the main window, after its content. */
export function ConfirmHost(props: { testID?: string }) {
  hosts += 1;
  cleanup(() => {
    hosts -= 1;
    // Nothing is left to ask in: the waiting questions are declined.
    if (hosts === 0) while (queue().length > 0) answer(false);
  });
  const current = () => queue()[0]?.options;
  let acted = false;
  return (
    <AlertDialog
      testID={props.testID ?? "confirm"}
      open={current() !== undefined}
      title={current()?.title ?? ""}
      description={current()?.description ?? null}
      actionLabel={current()?.actionLabel ?? "OK"}
      cancelLabel={current()?.cancelLabel ?? null}
      tone={current()?.tone ?? "accent"}
      onAction={() => {
        acted = true;
        answer(true);
      }}
      onOpenChange={(e) => {
        // The action's own close: that question is answered, and the next may be showing.
        if (acted) acted = false;
        else if (!e.open) answer(false);
      }}
    />
  );
}
