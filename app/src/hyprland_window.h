#pragma once

#include <QByteArray>
#include <QString>
#include <QStringList>

#include <functional>

// Hyprland parks a minimized window on a special workspace (Omarchy's dock
// uses special:minimized, a Super+M binding may use another), and a regular
// window may sit on another workspace. Qt counts both shown, so show() and
// raise() leave them out of sight. Launching Omamail again has to reach the
// window: a parked one comes onto the workspace in front of the user, the way
// the dock does it, and any other is focused where it is.
namespace HyprlandWindow {

// The address of this process's window when it sits on a special workspace,
// read from `hyprctl clients -j`; empty when it is on a regular one or absent.
// A named workspace has a negative id too, so only the name tells them apart.
QString parkedAddress(const QByteArray &clientsJson, qint64 pid);

// The address of this process's window, wherever it is.
QString windowAddress(const QByteArray &clientsJson, qint64 pid);

// The dispatches that move `address` to `workspace` and focus it, in the Lua
// syntax Hyprland 0.55+ reads and in the classic one, tried in that order.
QStringList luaDispatches(const QString &address, const QString &workspace);
QStringList classicDispatches(const QString &address, const QString &workspace);
QString luaFocus(const QString &address);
QString classicFocus(const QString &address);

// Runs `hyprctl <arguments>`: its output, and whether it succeeded.
using Hyprctl = std::function<QByteArray(const QStringList &arguments, bool *ok)>;

// Brings the window of process `pid` back, trying the Lua dispatches and then
// the classic ones. False when there is no window or nothing was accepted.
bool bringWindowBack(const Hyprctl &hyprctl, qint64 pid);

// Does it, when running under Hyprland; false when there was nothing to do.
bool bringWindowBack();

}
