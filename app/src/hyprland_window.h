#pragma once

#include <QByteArray>
#include <QString>

// Hyprland parks a minimized window on a special workspace (Omarchy's dock
// uses special:minimized, a Super+M binding may use another). Qt still counts
// it shown, so show() and raise() leave it out of sight. Launching Omamail
// again has to bring it back the way the dock does: onto the workspace in
// front of the user, focused.
namespace HyprlandWindow {

// The address of this process's window when it sits on a special workspace,
// read from `hyprctl clients -j`; empty when it is on a regular one or absent.
QString parkedAddress(const QByteArray &clientsJson, qint64 pid);

// The dispatches that move `address` to `workspace` and focus it, in the Lua
// syntax Hyprland 0.55+ reads and in the classic one, tried in that order.
QStringList luaDispatches(const QString &address, int workspace);
QStringList classicDispatches(const QString &address, int workspace);

// Does it, when running under Hyprland; false when there was nothing to do.
bool restoreParkedWindow();

}
