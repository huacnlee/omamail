// @ts-check

// Where the keyboard lives, and the one mechanism that moves it.
//
// This is `App.qml`'s `keyboardHome` / `parkKeyboard()` pair, ported. In the
// QML the window is a focus scope with a one-by-one `Item` in it, and every
// context change either hands the keyboard to what that context types into or
// parks it on that `Item` — so a field that has been dismissed cannot go on
// eating `j` and `k`.
//
// gpui needs the same thing for a second reason the QML does not have. A key
// event travels the path from the tree root to the **focused** node, and
// `key_context` only counts where it sits on that path: with nothing focused,
// `Window::focus_node_id_in_rendered_frame` falls back to the root, the
// window's own context elements are not on the path, and *no* binding fires.
// The port had no `track_focus` anywhere, so that is exactly where it stood.
//
// The park is also what keeps the keyboard through a click. `ShellRoot` blurs
// the window on any press that is not on a focus-tracking element, and a
// message row is a plain `div` — so clicking a message used to unfocus the
// window and kill the keyboard for good. A focusable element takes the press
// first and calls `prevent_default`, which is the flag the root's own listener
// reads, so parking the home handle on the element that carries the context
// means every press inside the window lands on something focusable.
//
// Two homes, because there are two layers. The window's own context element
// holds the first; the shortcut sheet holds the second, and taking the keyboard
// is how the sheet stands the mailbox's keys down — see `OVERLAY_CONTEXT`.

/**
 * The pair, made once. `cx.focus_handle()` is refused during render — a handle
 * built there would be a new one every frame — so this belongs in `init`.
 * @param {import("gpui").Context} cx
 */
export function createFocusHomes(cx) {
  return { home: cx.focus_handle(), overlay: cx.focus_handle() };
}

/**
 * Park the keyboard on the window, which is what every context that types into
 * nothing does.
 *
 * Nothing here hands the focus to a field. gpui's `InputState` carries no focus
 * handle a script can move the keyboard onto, so `applyContextFocus`'s compose
 * and search arms have no port: those two contexts are reached by clicking the
 * field, and what makes them safe is that they bind no bare key rather than
 * that the focus was placed by hand.
 * @param {any} app
 */
export function parkKeyboard(app) {
  app.keyboardHome?.focus();
}

/**
 * Hand the keyboard to the layer standing over the window. The sheet is not a
 * screen you were sent to, so this is the whole of what makes it own the
 * keyboard while it is up.
 * @param {any} app
 */
export function focusOverlay(app) {
  app.overlayFocus?.focus();
}
