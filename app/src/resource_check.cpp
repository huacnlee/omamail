#include "resource_check.h"

#include <QCoreApplication>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonParseError>
#include <QLibraryInfo>
#include <QQmlComponent>
#include <QQmlEngine>
#include <QProcess>
#include <QSaveFile>
#include <memory>

namespace {
constexpr qsizetype maximumBackendFrameBytes = 1024 * 1024;
constexpr qsizetype maximumStderrBytes = 64 * 1024;

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

void drainStderr(QProcess &process, QByteArray &stderrTail, SmokeMetrics *metrics,
                 const QElapsedTimer *timer = nullptr, int timeoutMilliseconds = 0)
{
    const QProcess::ProcessChannel previous = process.readChannel();
    process.setReadChannel(QProcess::StandardError);
    while (process.bytesAvailable() > 0) {
        if (timer && timer->elapsed() >= timeoutMilliseconds) break;
        const QByteArray chunk = process.read(qMin<qint64>(process.bytesAvailable(), 64 * 1024));
        if (chunk.isEmpty()) break;
        stderrTail.append(chunk);
        if (stderrTail.size() > maximumStderrBytes)
            stderrTail.remove(0, stderrTail.size() - maximumStderrBytes);
        if (metrics)
            metrics->maximumStderrTailBytes = qMax(metrics->maximumStderrTailBytes,
                                                   stderrTail.size());
    }
    process.setReadChannel(previous);
}

bool appendBoundedRecords(QByteArray &buffer, const QByteArray &bytes, QString *error,
                          SmokeMetrics *metrics = nullptr)
{
    qsizetype offset = 0;
    while (offset < bytes.size()) {
        const qsizetype newline = bytes.indexOf('\n', offset);
        const qsizetype end = newline < 0 ? bytes.size() : newline;
        const qsizetype length = end - offset;
        if (buffer.size() + length >= maximumBackendFrameBytes) {
            if (error) *error = QStringLiteral("Backend response frame is too large");
            return false;
        }
        buffer.append(bytes.constData() + offset, length);
        if (metrics)
            metrics->maximumStdoutFrameBytes = qMax(metrics->maximumStdoutFrameBytes,
                                                    buffer.size());
        if (newline < 0) return true;
        buffer.clear();
        offset = newline + 1;
    }
    return true;
}

bool takeLine(QByteArray &buffer, const QByteArray &bytes, QByteArray *line,
              bool *complete, QString *error, SmokeMetrics *metrics)
{
    *complete = false;
    const qsizetype newline = bytes.indexOf('\n');
    const qsizetype prefix = newline < 0 ? bytes.size() : newline;
    if (buffer.size() + prefix >= maximumBackendFrameBytes) {
        if (error) *error = QStringLiteral("Backend response frame is too large");
        return false;
    }
    buffer.append(bytes.constData(), prefix);
    if (metrics)
        metrics->maximumStdoutFrameBytes = qMax(metrics->maximumStdoutFrameBytes,
                                                buffer.size());
    if (newline < 0) return true;
    *line = buffer;
    buffer.clear();
    *complete = true;
    return appendBoundedRecords(buffer, bytes.mid(newline + 1), error, metrics);
}

bool waitForLine(QProcess &process, QByteArray &buffer, QByteArray &stderrTail,
                 QByteArray *line, int timeoutMilliseconds, QString *error,
                 SmokeMetrics *metrics)
{
    QElapsedTimer timer;
    timer.start();
    while (timer.elapsed() < timeoutMilliseconds) {
        drainStderr(process, stderrTail, metrics);
        while (process.bytesAvailable() > 0) {
            const QByteArray bytes = process.read(qMin<qint64>(process.bytesAvailable(), 64 * 1024));
            bool complete = false;
            if (!takeLine(buffer, bytes, line, &complete, error, metrics)) return false;
            if (complete) return true;
        }
        const int remaining = timeoutMilliseconds - static_cast<int>(timer.elapsed());
        if (!process.waitForReadyRead(qMin(remaining, 100))) {
            drainStderr(process, stderrTail, metrics);
            if (process.state() == QProcess::NotRunning
                && process.bytesAvailable() == 0) break;
            QCoreApplication::processEvents();
        }
    }
    if (error && error->isEmpty()) *error = QStringLiteral("Backend response timed out");
    return false;
}

bool request(QProcess &process, QByteArray &buffer, QByteArray &stderrTail,
             const QByteArray &id, const QByteArray &method,
             QJsonObject *result, QString *error, SmokeMetrics *metrics)
{
    const QByteArray frame = QByteArrayLiteral("{\"jsonrpc\":\"2.0\",\"id\":\"")
        + id + QByteArrayLiteral("\",\"method\":\"") + method
        + QByteArrayLiteral("\",\"params\":{}}\n");
    if (process.write(frame) != frame.size() || !process.waitForBytesWritten(1000)) {
        if (error) *error = QStringLiteral("Could not write backend request");
        return false;
    }
    QByteArray line;
    if (!waitForLine(process, buffer, stderrTail, &line, 5000, error, metrics)) return false;
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

bool waitForCleanExit(QProcess &process, QByteArray &stdoutBuffer,
                      QByteArray &stderrTail, int timeoutMilliseconds,
                      QString *error, SmokeMetrics *metrics)
{
    QElapsedTimer timer;
    timer.start();
    while (timer.elapsed() < timeoutMilliseconds) {
        drainStderr(process, stderrTail, metrics, &timer, timeoutMilliseconds);
        while (process.bytesAvailable() > 0 && timer.elapsed() < timeoutMilliseconds) {
            const QByteArray bytes = process.read(
                qMin<qint64>(process.bytesAvailable(), 64 * 1024));
            if (!appendBoundedRecords(stdoutBuffer, bytes, error, metrics)) return false;
        }
        if (process.state() == QProcess::NotRunning) return true;
        const int remaining = timeoutMilliseconds - static_cast<int>(timer.elapsed());
        if (remaining <= 0) break;
        process.waitForFinished(qMin(10, remaining));
        QCoreApplication::processEvents();
    }
    // A still-running flood must not be drained after the deadline: reading
    // while the child keeps writing can spin until the pipe finally stalls.
    if (process.state() != QProcess::NotRunning) {
        if (error) *error = QStringLiteral("Backend shutdown timed out");
        return false;
    }
    drainStderr(process, stderrTail, metrics);
    while (process.bytesAvailable() > 0) {
        const QByteArray bytes = process.read(
            qMin<qint64>(process.bytesAvailable(), 64 * 1024));
        if (!appendBoundedRecords(stdoutBuffer, bytes, error, metrics)) return false;
    }
    return true;
}

void stopProcess(QProcess &process)
{
    if (process.state() == QProcess::NotRunning) return;
    process.kill();
    process.waitForFinished(1000);
}
}

bool developmentResourcesEnabled()
{
    return qgetenv("OMAMAIL_DEVELOPMENT_RESOURCES") == QByteArrayLiteral("1");
}

ResourcePaths defaultResourcePaths(const QString &executablePath, bool developmentMode)
{
    const QString executable = executablePath.isEmpty()
        ? QCoreApplication::applicationFilePath() : executablePath;
    const QDir executableDir(QFileInfo(executable).absolutePath());
    const QDir sourceRoot(QStringLiteral(OMAMAIL_SOURCE_ROOT));
    const QString pluginName = platformPluginName();
    ResourcePaths paths;
    QStringList standaloneCandidates{
        QStringLiteral(":/omamail/app/qml/Main.qml"),
        executableDir.filePath(QStringLiteral("qml/Main.qml")),
        QDir::cleanPath(executableDir.filePath(QStringLiteral("../qml/Main.qml"))),
        QDir::cleanPath(executableDir.filePath(QStringLiteral("../Resources/qml/Main.qml")))};
    QStringList sharedCandidates{
        QStringLiteral(":/omamail/ui/Service.qml"),
        executableDir.filePath(QStringLiteral("ui/Service.qml")),
        QDir::cleanPath(executableDir.filePath(QStringLiteral("../ui/Service.qml"))),
        QDir::cleanPath(executableDir.filePath(QStringLiteral("../Resources/ui/Service.qml")))};
    if (developmentMode) {
        standaloneCandidates.prepend(sourceRoot.filePath(QStringLiteral("app/qml/Main.qml")));
        sharedCandidates.prepend(sourceRoot.filePath(QStringLiteral("ui/Service.qml")));
    }
    paths.standaloneQml = firstExisting(standaloneCandidates);
    paths.sharedUi = firstExisting(sharedCandidates);
    QStringList platformCandidates{
        executableDir.filePath(QStringLiteral("plugins/platforms/%1").arg(pluginName)),
        executableDir.filePath(QStringLiteral("platforms/%1").arg(pluginName)),
        QDir::cleanPath(executableDir.filePath(QStringLiteral("../plugins/platforms/%1").arg(pluginName))),
        QDir::cleanPath(executableDir.filePath(QStringLiteral("../PlugIns/platforms/%1").arg(pluginName)))};
    if (developmentMode)
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
    if (developmentMode) {
        backendCandidates.prepend(configuredBackend);
        backendCandidates.prepend(QString::fromLocal8Bit(qgetenv("OMAMAIL_BIN")));
    }
    paths.backend = firstExisting(backendCandidates);
    QStringList manifestCandidates{
        QStringLiteral(":/omamail/manifest.json"),
        executableDir.filePath(QStringLiteral("manifest.json")),
        QDir::cleanPath(executableDir.filePath(QStringLiteral("../manifest.json"))),
        QDir::cleanPath(executableDir.filePath(QStringLiteral("../Resources/manifest.json")))};
    if (developmentMode)
        manifestCandidates.prepend(sourceRoot.filePath(QStringLiteral("manifest.json")));
    paths.manifest = firstExisting(manifestCandidates);
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
    QFile manifest(paths.manifest);
    if (!manifest.open(QIODevice::ReadOnly)) {
        result.errors.append(QStringLiteral("Missing or unreadable manifest: %1")
                                 .arg(paths.manifest));
    } else {
        const QByteArray bytes = manifest.read(1024 * 1024 + 1);
        QJsonParseError parseError;
        const QJsonDocument document = bytes.size() > 1024 * 1024
            ? QJsonDocument() : QJsonDocument::fromJson(bytes, &parseError);
        const QJsonObject value = document.object();
        if (bytes.size() > 1024 * 1024 || parseError.error != QJsonParseError::NoError
            || !document.isObject() || value.value(QStringLiteral("id")).toString() != QStringLiteral("omamail")
            || value.value(QStringLiteral("name")).toString() != QStringLiteral("Omamail")
            || value.value(QStringLiteral("version")).toString() != QStringLiteral(OMAMAIL_APP_VERSION)) {
            result.errors.append(QStringLiteral("Invalid standalone manifest: %1")
                                     .arg(paths.manifest));
        }
    }
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

bool runSmokeTest(const ResourcePaths &paths, const QString &readyFile, QString *error,
                  int shutdownTimeoutMilliseconds, SmokeMetrics *metrics)
{
    const ResourceCheck resources = checkResources(paths);
    if (!resources.ok) {
        if (error) *error = resources.errors.join(QStringLiteral("\n"));
        return false;
    }

    const QByteArray previousSmokeMode = qgetenv("OMAMAIL_SMOKE_TEST");
    qputenv("OMAMAIL_SMOKE_TEST", QByteArrayLiteral("1"));
    QQmlEngine engine;
    const QFileInfo sharedEntry(paths.sharedUi);
    engine.addImportPath(sharedEntry.absolutePath());
    const QString standaloneImports = paths.standaloneQml.startsWith(QStringLiteral(":"))
        ? QStringLiteral("qrc:/omamail/app/qml/imports")
        : QFileInfo(paths.standaloneQml).dir().filePath(QStringLiteral("imports"));
    engine.addImportPath(standaloneImports);
    const QUrl componentUrl = paths.standaloneQml.startsWith(QStringLiteral(":"))
        ? QUrl(QStringLiteral("qrc") + paths.standaloneQml)
        : QUrl::fromLocalFile(paths.standaloneQml);
    QQmlComponent component(&engine, componentUrl);
    if (component.status() != QQmlComponent::Ready) {
        if (previousSmokeMode.isNull()) qunsetenv("OMAMAIL_SMOKE_TEST");
        else qputenv("OMAMAIL_SMOKE_TEST", previousSmokeMode);
        if (error) *error = component.errorString();
        return false;
    }
    std::unique_ptr<QObject> root(component.create());
    if (previousSmokeMode.isNull()) qunsetenv("OMAMAIL_SMOKE_TEST");
    else qputenv("OMAMAIL_SMOKE_TEST", previousSmokeMode);
    if (!root) {
        if (error) *error = component.errorString();
        return false;
    }

    QProcess backend;
    backend.setProgram(paths.backend);
    backend.setArguments({QStringLiteral("serve")});
    backend.setProcessChannelMode(QProcess::SeparateChannels);
    backend.setReadChannel(QProcess::StandardOutput);
    backend.start();
    if (!backend.waitForStarted(5000)) {
        if (error) *error = QStringLiteral("Could not start backend: %1").arg(backend.errorString());
        return false;
    }
    QByteArray responseBuffer;
    QByteArray stderrTail;
    QJsonObject info;
    if (!request(backend, responseBuffer, stderrTail, "smoke-info", "system.info", &info,
                 error, metrics)) {
        stopProcess(backend);
        return false;
    }
    const QString version = info.value(QStringLiteral("version")).toString();
    const QJsonValue apiVersion = info.value(QStringLiteral("apiVersion"));
    const QJsonValue protocol = info.value(QStringLiteral("protocol"));
    if (info.value(QStringLiteral("name")).toString() != QStringLiteral("omamail")
        || version != QStringLiteral(OMAMAIL_APP_VERSION)
        || !protocol.isDouble() || protocol.toInt() != 1
        || !apiVersion.isDouble()
        || apiVersion.toDouble() != static_cast<double>(apiVersion.toInt())
        || apiVersion.toInt() != 4) {
        if (error) *error = QStringLiteral("Bundled backend system.info does not match this app");
        stopProcess(backend);
        return false;
    }
    QJsonObject quitResult;
    if (!request(backend, responseBuffer, stderrTail, "smoke-quit", "system.quit", &quitResult,
                 error, metrics)
        || quitResult.value(QStringLiteral("quitReady")).toBool() != true
        || !waitForCleanExit(backend, responseBuffer, stderrTail,
                             shutdownTimeoutMilliseconds, error, metrics)
        || backend.exitStatus() != QProcess::NormalExit
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
