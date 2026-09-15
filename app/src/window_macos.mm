#include "window.h"

#include <QWindow>

#import <AppKit/AppKit.h>

void prepareNativeWindow(QWindow *window)
{
    if (!window) return;
    auto *view = reinterpret_cast<NSView *>(window->winId());
    if (!view) return;
    NSWindow *nativeWindow = view.window;
    if (!nativeWindow) return;
    nativeWindow.preservesContentDuringLiveResize = YES;
}
