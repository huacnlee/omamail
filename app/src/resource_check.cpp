#include "resource_check.h"

#include <QCoreApplication>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLibraryInfo>
#include <QQmlComponent>
#include <QQmlEngine>
#include <QProcess>
#include <QSaveFile>
#include <memory>

namespace {
QString firstExisting(const QStringList &candidates)
{
    for (const QString &candidate : candidates) {
        if (!candidate.isEmpty() && QFileInfo::exists(candidate)) return candidate;
    }
    return candidates.isEmpty() ? QString() : candidates.first();
}

QString platformPluginName()
{
#ifdef Q_OS_WIN
    return QStringLiteral("qwindows.dll");
#elif defined(Q_OS_MACOS)
    return QStringLiteral("libqcocoa.dylib");
#else
    return QStringLiteral("libqxcb.so");
#endif
}

bool readable(const QString &path)
{
    QFile file(path);
    return file.open(QIODevice::ReadOnly);
}

bool waitForLine(QProcess &process, QByteArray &buffer, QByteArray *line,
                 int timeoutMilliseconds)
{
    QElapsedTimer timer;
    timer.start();
    while (timer.elapsed() < timeoutMilliseconds) {
        const qsizetype newline = buffer.indexOf('\n');
        if (newline >= 0) {
            *line = buffer.left(newline);
            buffer.remove(0, newline + 1);
            return true;
        }
        if (buffer.size() >= 1024 * 1024) return false;
        const int remaining = timeoutMilliseconds - static_cast<int>(timer.elapsed());
        if (!process.waitForReadyRead(qMin(remaining, 100))) {
            if (process.state() == QProcess::NotRunning) break;
            QCoreApplication::processEvents();
            continue;
        }
        buffer.append(process.readAllStandardOutput());
    }
    return false;
}

bool request(QProcess &process, QByteArray &buffer, const QByteArray &id,
             const QByteArray &method, QJsonObject *result, QString *error)
{
    const QByteArray frame = QByteArrayLiteral("{\"jsonrpc\":\"2.0\",\"id\":\"")
        + id + QByteArrayLiteral("\",\"method\":\"") + method
        + QByteArrayLiteral("\",\"params\":{}}\n");
    if (process.write(frame) != frame.size() || !process.waitForBytesWritten(1000)) {
        if (error) *error = QStringLiteral("Could not write backend request");
        return false;
    }
    QByteArray line;
    if (!waitForLine(process, buffer, &line, 5000)) {
        if (error) *error = QStringLiteral("Backend response timed out");
        return false;
    }
    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(line, &parseError);
    const QJsonObject reply = document.object();
    if (parseError.error != QJsonParseError::NoError || !document.isObject()
        || reply.value(QStringLiteral("jsonrpc")).toString() != QStringLiteral("2.0")
        || reply.value(QStringLiteral("id")).toString() != QString::fromUtf8(id)
        || !reply.value(QStringLiteral("result")).isObject()) {
        if (error) *error = QStringLiteral("Backend returned an invalid response");
        return false;
    }
    *result = reply.value(QStringLiteral("result")).toObject();
    return true;
}

void stopProcess(QProcess &process)
{
    if (process.state() == QProcess::NotRunning) return;
    process.kill();
    process.waitForFinished(1000);
}
}

ResourcePaths defaultResourcePaths(const QString &executablePath)
{
    const QString executable = executablePath.isEmpty()
        ? QCoreApplication::applicationFilePath() : executablePath;
    const QDir executableDir(QFileInfo(executable).absolutePath());
    const QDir sourceRoot(QStringLiteral(OMAMAIL_SOURCE_ROOT));
    const QString pluginName = platformPluginName();
    ResourcePaths paths;
    paths.standaloneQml = firstExisting({
        QStringLiteral(":/omamail/app/Main.qml"),
        executableDir.filePath(QStringLiteral("qml/Main.qml")),
        executableDir.filePath(QStringLiteral("../Resources/qml/Main.qml")),
        sourceRoot.filePath(QStringLiteral("app/qml/Main.qml"))});
    paths.sharedUi = firstExisting({
        executableDir.filePath(QStringLiteral("ui/Service.qml")),
        executableDir.filePath(QStringLiteral("../Resources/ui/Service.qml")),
        sourceRoot.filePath(QStringLiteral("ui/Service.qml"))});
    QStringList platformCandidates{
        executableDir.filePath(QStringLiteral("plugins/platforms/%1").arg(pluginName)),
        executableDir.filePath(QStringLiteral("../PlugIns/platforms/%1").arg(pluginName))};
    const bool developmentLayout = QFileInfo(paths.sharedUi).absoluteFilePath()
        == QFileInfo(sourceRoot.filePath(QStringLiteral("ui/Service.qml"))).absoluteFilePath();
    if (developmentLayout)
        platformCandidates.append(QDir(QLibraryInfo::path(QLibraryInfo::PluginsPath))
            .filePath(QStringLiteral("platforms/%1").arg(pluginName)));
    paths.platformPlugin = firstExisting(platformCandidates);
    const QString configuredBackend = QStringLiteral(OMAMAIL_BACKEND_PATH);
    QStringList backendCandidates{
#ifdef Q_OS_WIN
        executableDir.filePath(QStringLiteral("omamail.exe")),
#else
        executableDir.filePath(QStringLiteral("omamail")),
#endif
    };
    if (developmentLayout) {
        backendCandidates.prepend(configuredBackend);
        backendCandidates.prepend(QString::fromLocal8Bit(qgetenv("OMAMAIL_BIN")));
    }
    paths.backend = firstExisting(backendCandidates);
    paths.manifest = firstExisting({
        executableDir.filePath(QStringLiteral("manifest.json")),
        executableDir.filePath(QStringLiteral("../Resources/manifest.json")),
        sourceRoot.filePath(QStringLiteral("manifest.json"))});
    return paths;
}

ResourceCheck checkResources(const ResourcePaths &paths)
{
    ResourceCheck result;
    if (!readable(paths.standaloneQml))
        result.errors.append(QStringLiteral("Missing or unreadable standalone QML: %1")
                                 .arg(paths.standaloneQml));
    if (!readable(paths.sharedUi))
        result.errors.append(QStringLiteral("Missing or unreadable shared UI: %1")
                                 .arg(paths.sharedUi));
    if (!readable(paths.platformPlugin))
        result.errors.append(QStringLiteral("Missing or unreadable Qt platform plugin: %1")
                                 .arg(paths.platformPlugin));
    QFileInfo backend(paths.backend);
    if (!backend.isFile() || !backend.isReadable())
        result.errors.append(QStringLiteral("Missing or unreadable backend: %1").arg(paths.backend));
    else if (!backend.isExecutable())
        result.errors.append(QStringLiteral("Backend is not executable: %1").arg(paths.backend));
    result.ok = result.errors.isEmpty();
    return result;
}

bool runSmokeTest(const ResourcePaths &paths, const QString &readyFile, QString *error)
{
    const ResourceCheck resources = checkResources(paths);
    if (!resources.ok) {
        if (error) *error = resources.errors.join(QStringLiteral("\n"));
        return false;
    }

    QQmlEngine engine;
    const QFileInfo sharedEntry(paths.sharedUi);
    engine.addImportPath(sharedEntry.absolutePath());
    const QString standaloneImports = paths.standaloneQml.startsWith(QStringLiteral(":"))
        ? QStringLiteral("qrc:/omamail/app/imports")
        : QFileInfo(paths.standaloneQml).dir().filePath(QStringLiteral("imports"));
    engine.addImportPath(standaloneImports);
    const QUrl componentUrl = paths.standaloneQml.startsWith(QStringLiteral(":"))
        ? QUrl(QStringLiteral("qrc") + paths.standaloneQml)
        : QUrl::fromLocalFile(paths.standaloneQml);
    QQmlComponent component(&engine, componentUrl);
    if (component.status() != QQmlComponent::Ready) {
        if (error) *error = component.errorString();
        return false;
    }
    std::unique_ptr<QObject> root(component.create());
    if (!root) {
        if (error) *error = component.errorString();
        return false;
    }

    QProcess backend;
    backend.setProgram(paths.backend);
    backend.setArguments({QStringLiteral("serve")});
    backend.setProcessChannelMode(QProcess::SeparateChannels);
    backend.start();
    if (!backend.waitForStarted(5000)) {
        if (error) *error = QStringLiteral("Could not start backend: %1").arg(backend.errorString());
        return false;
    }
    QByteArray responseBuffer;
    QJsonObject info;
    if (!request(backend, responseBuffer, "smoke-info", "system.info", &info, error)) {
        stopProcess(backend);
        return false;
    }
    const QString version = info.value(QStringLiteral("version")).toString();
    const QJsonValue apiVersion = info.value(QStringLiteral("apiVersion"));
    if (version.isEmpty() || !apiVersion.isDouble()
        || apiVersion.toDouble() != static_cast<double>(apiVersion.toInt())
        || apiVersion.toInt() < 1) {
        if (error) *error = QStringLiteral("Backend system.info is incomplete");
        stopProcess(backend);
        return false;
    }
    QJsonObject quitResult;
    if (!request(backend, responseBuffer, "smoke-quit", "system.quit", &quitResult, error)
        || quitResult.value(QStringLiteral("quitReady")).toBool() != true
        || !backend.waitForFinished(5000) || backend.exitStatus() != QProcess::NormalExit
        || backend.exitCode() != 0) {
        if (error && error->isEmpty()) *error = QStringLiteral("Backend did not shut down cleanly");
        stopProcess(backend);
        return false;
    }

    QSaveFile file(readyFile);
    const QJsonObject ready{{QStringLiteral("version"), version},
                            {QStringLiteral("apiVersion"), apiVersion.toInt()}};
    const QByteArray bytes = QJsonDocument(ready).toJson(QJsonDocument::Indented);
    if (!QDir().mkpath(QFileInfo(readyFile).absolutePath())
        || !file.open(QIODevice::WriteOnly) || file.write(bytes) != bytes.size()
        || !file.commit()) {
        if (error) *error = QStringLiteral("Could not atomically write ready file: %1")
                                .arg(file.errorString());
        return false;
    }
    if (error) error->clear();
    return true;
}
