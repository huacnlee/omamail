#include "hyprland_window.h"

#include <QCoreApplication>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QProcess>
#include <QStringList>

namespace HyprlandWindow {

QString parkedAddress(const QByteArray &clientsJson, qint64 pid)
{
    const QJsonArray clients = QJsonDocument::fromJson(clientsJson).array();
    for (const QJsonValue &value : clients) {
        const QJsonObject client = value.toObject();
        if (client.value(QStringLiteral("pid")).toInteger() != pid) continue;
        const QJsonObject workspace = client.value(QStringLiteral("workspace")).toObject();
        const QString name = workspace.value(QStringLiteral("name")).toString();
        if (!name.startsWith(QStringLiteral("special:"))) continue;
        const QString address = client.value(QStringLiteral("address")).toString();
        if (address.startsWith(QStringLiteral("0x"))) return address;
    }
    return {};
}

QString windowAddress(const QByteArray &clientsJson, qint64 pid)
{
    const QJsonArray clients = QJsonDocument::fromJson(clientsJson).array();
    for (const QJsonValue &value : clients) {
        const QJsonObject client = value.toObject();
        if (client.value(QStringLiteral("pid")).toInteger() != pid) continue;
        const QString address = client.value(QStringLiteral("address")).toString();
        if (address.startsWith(QStringLiteral("0x"))) return address;
    }
    return {};
}

QString luaFocus(const QString &address)
{
    return QStringLiteral("hl.dsp.focus({ window = \"address:%1\" })").arg(address);
}

QString classicFocus(const QString &address)
{
    return QStringLiteral("focuswindow address:%1").arg(address);
}

QStringList luaDispatches(const QString &address, const QString &workspace)
{
    const QString target = QStringLiteral("window = \"address:%1\"").arg(address);
    return {QStringLiteral("hl.dsp.window.move({ workspace = \"%1\", %2 })").arg(workspace).arg(target),
            luaFocus(address)};
}

QStringList classicDispatches(const QString &address, const QString &workspace)
{
    return {QStringLiteral("movetoworkspace %1,address:%2").arg(workspace).arg(address),
            classicFocus(address)};
}

namespace {
QByteArray runHyprctl(const QStringList &arguments, bool *ok)
{
    QProcess process;
    process.start(QStringLiteral("hyprctl"), arguments);
    const bool done = process.waitForFinished(1500) && process.exitStatus() == QProcess::NormalExit
        && process.exitCode() == 0;
    if (ok) *ok = done;
    return done ? process.readAllStandardOutput() : QByteArray();
}

bool dispatchAll(const Hyprctl &hyprctl, const QStringList &steps)
{
    for (const QString &step : steps) {
        bool ok = false;
        const QByteArray answer = hyprctl({QStringLiteral("dispatch"), step}, &ok).trimmed();
        if (!ok || answer != "ok") return false;
    }
    return true;
}
}

bool bringWindowBack(const Hyprctl &hyprctl, qint64 pid)
{
    bool ok = false;
    const QByteArray clients = hyprctl({QStringLiteral("clients"), QStringLiteral("-j")}, &ok);
    const QString address = parkedAddress(clients, pid);
    if (address.isEmpty()) {
        const QString window = windowAddress(clients, pid);
        if (window.isEmpty()) return false;
        return dispatchAll(hyprctl, {luaFocus(window)}) || dispatchAll(hyprctl, {classicFocus(window)});
    }
    const QJsonObject active = QJsonDocument::fromJson(
        hyprctl({QStringLiteral("activeworkspace"), QStringLiteral("-j")}, &ok)).object();
    // A named workspace has a negative id, so it goes by its name.
    const int id = active.value(QStringLiteral("id")).toInt(-1);
    const QString name = active.value(QStringLiteral("name")).toString();
    if (id < 1 && name.isEmpty()) return false;
    const QString workspace = id >= 1 ? QString::number(id) : QStringLiteral("name:") + name;
    return dispatchAll(hyprctl, luaDispatches(address, workspace))
        || dispatchAll(hyprctl, classicDispatches(address, workspace));
}

bool bringWindowBack()
{
    if (qEnvironmentVariableIsEmpty("HYPRLAND_INSTANCE_SIGNATURE")) return false;
    return bringWindowBack(runHyprctl, QCoreApplication::applicationPid());
}

}
