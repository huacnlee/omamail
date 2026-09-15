#pragma once

class QWindow;

// Platform window setup that QML cannot reach. On macOS this keeps the
// existing backing store during live move/resize so the window server does
// not wait on a full Qt Quick frame for every pointer event.
void prepareNativeWindow(QWindow *window);
