#include "window.h"

#include <QPointer>
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

void watchNativeCloseChord(QWindow *window, std::function<void()> onClose)
{
    if (!window || !onClose) return;
    QPointer<QWindow> watched(window);
    [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown
                                          handler:^NSEvent *(NSEvent *event) {
        if (!watched) return event;
        // Cmd+W and nothing else held; Caps Lock does not change a chord.
        const NSEventModifierFlags flags = event.modifierFlags
            & NSEventModifierFlagDeviceIndependentFlagsMask
            & ~NSEventModifierFlagCapsLock;
        if (flags != NSEventModifierFlagCommand) return event;
        if (![[event.charactersIgnoringModifiers lowercaseString] isEqualToString:@"w"])
            return event;
        // Only the watched window's own chord: a panel or another window that
        // is key keeps its Cmd+W, the way a menu's Close is validated against
        // the responder chain.
        auto *view = reinterpret_cast<NSView *>(watched->winId());
        if (!view || !view.window || NSApp.keyWindow != view.window) return event;
        onClose();
        return nil;
    }];
}
