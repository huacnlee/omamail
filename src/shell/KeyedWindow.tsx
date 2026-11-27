// A window's keys: NSH binds a keystroke in the window that bound it, so a
// window of its own (a draft moved out of the mail window, anything opened
// with `Window.open`) answers no key until the router runs inside it.
// Every secondary window wraps its content in `KeyedWindow`:
//
//   Window.open(() => <KeyedWindow><ComposeWindow /></KeyedWindow>, { id: "compose", ... })
//
// The main window gets its router from the shell.
import { View, type JSX } from "nsh";
import { useKeyRouter } from "../keys/router";

export function KeyedWindow(props: { children?: JSX.Element }) {
  useKeyRouter();
  return <View class="flex-1">{props.children}</View>;
}
