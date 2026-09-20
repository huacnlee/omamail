#pragma once

#include <functional>

class QWindow;

// Platform window setup that QML cannot reach. On macOS this keeps the
// existing backing store during live move/resize so the window server does
// not wait on a full Qt Quick frame for every pointer event.
void prepareNativeWindow(QWindow *window);

// Watch for the platform close chord on `window` at the native layer and call
// `onClose` in its place. On macOS Cocoa hands Cmd+W to Qt through keyDown:,
// after the key window's performKeyEquivalent: (which Qt answers only for
// Ctrl+Tab) and the main menu. Qt then tries it as a shortcut only while no
// input method composition is pending; otherwise the chord goes to the input
// method and is dropped or delivered as plain text. A native app's Close is a
// menu key equivalent and wins before any of that, which is what this
// restores. Elsewhere this is a no-op: the QML Shortcut is enough.
void watchNativeCloseChord(QWindow *window, std::function<void()> onClose);
