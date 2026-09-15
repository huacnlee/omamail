#include "app_icon.h"
#include "resource_check.h"

#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QGuiApplication>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLibraryInfo>
#include <QTemporaryDir>
#include <QTest>
#include <QTextStream>

class ResourcesTest : public QObject {
    Q_OBJECT

private:
    static bool writeFile(const QString &path, const QByteArray &contents = "fixture")
    {
        QDir().mkpath(QFileInfo(path).absolutePath());
        QFile file(path);
        if (!file.open(QIODevice::WriteOnly)) return false;
        return file.write(contents) == contents.size();
    }

    static ResourcePaths completeLayout(QTemporaryDir &directory)
    {
        ResourcePaths paths;
        paths.standaloneQml = directory.filePath(QStringLiteral("qml/Main.qml"));
        paths.sharedUi = directory.filePath(QStringLiteral("ui/Service.qml"));
        paths.platformPlugin = directory.filePath(QStringLiteral("plugins/platforms/platform.fixture"));
        paths.backend = directory.filePath(QStringLiteral("bin/omamail"));
        paths.manifest = directory.filePath(QStringLiteral("manifest.json"));
        writeFile(paths.standaloneQml, "import QtQuick\nItem {}\n");
        writeFile(paths.sharedUi, "import QtQuick\nItem {}\n");
        writeFile(paths.platformPlugin);
        writeFile(paths.manifest, QByteArrayLiteral("{\"id\":\"omamail\",\"name\":\"Omamail\",\"version\":\"")
            + QByteArrayLiteral(OMAMAIL_APP_VERSION) + QByteArrayLiteral("\"}"));
        writeFile(paths.backend, "#!/bin/sh\nexit 0\n");
        QFile backend(paths.backend);
        backend.setPermissions(backend.permissions() | QFileDevice::ExeOwner
                               | QFileDevice::ExeGroup | QFileDevice::ExeOther);
        return paths;
    }

private slots:
    void platedIconReadsEveryPngInTheIcns();
    void acceptsCompleteReadableLayout();
    void reportsEachMissingComponent_data();
    void reportsEachMissingComponent();
    void rejectsBackendWithoutExecutePermission();
    void rejectsInvalidManifest();
    void smokeTestLoadsQmlHandshakesAndWritesReadyFile();
    void smokeRejectsMismatchedBackendApi();
    void smokeRejectsOversizedStdoutFrame();
    void smokeDrainsLargeStderr();
    void smokeBoundsBothChannelsAfterQuitReply();
    void smokeDeadlineCrossedDuringDrainDoesNotWaitForever();
    void bundleDiscoveryDoesNotUseDevelopmentFallbacks();
    void developmentDiscoveryUsesExplicitSourceAndBackend();
    void bundleDiscoveryAcceptsPortableRootLayout();
};

void ResourcesTest::platedIconReadsEveryPngInTheIcns()
{
    const QIcon icon = iconFromIcnsFile(QDir(QStringLiteral(OMAMAIL_SOURCE_ROOT))
        .filePath(QStringLiteral("app/resources/macos/omamail.icns")));
    QVERIFY(!icon.isNull());
    const QList<QSize> sizes = icon.availableSizes();
    for (int dimension : {32, 64, 128, 256, 512, 1024})
        QVERIFY2(sizes.contains(QSize(dimension, dimension)), qPrintable(QString::number(dimension)));
    // The plate is the Omarchy background, not the bare logo's transparency.
    const QImage image = icon.pixmap(QSize(64, 64)).toImage();
    QCOMPARE(image.pixelColor(32, 16).name(), QStringLiteral("#1a1b26"));
    QCOMPARE(image.pixelColor(2, 2).alpha(), 0);

    QVERIFY(iconFromIcns(QByteArray()).isNull());
    QVERIFY(iconFromIcns(QByteArrayLiteral("icns\0\0\0\x08")).isNull());
    QVERIFY(iconFromIcnsFile(QStringLiteral("/nonexistent/omamail.icns")).isNull());
}

void ResourcesTest::acceptsCompleteReadableLayout()
{
    QTemporaryDir directory;
    const ResourceCheck result = checkResources(completeLayout(directory));
    QVERIFY2(result.ok, qPrintable(result.errors.join(QStringLiteral("; "))));
}

void ResourcesTest::reportsEachMissingComponent_data()
{
    QTest::addColumn<QString>("member");
    QTest::addColumn<QString>("description");
    QTest::newRow("standalone qml") << QStringLiteral("standaloneQml") << QStringLiteral("standalone QML");
    QTest::newRow("shared ui") << QStringLiteral("sharedUi") << QStringLiteral("shared UI");
    QTest::newRow("platform plugin") << QStringLiteral("platformPlugin") << QStringLiteral("Qt platform plugin");
    QTest::newRow("backend") << QStringLiteral("backend") << QStringLiteral("backend");
    QTest::newRow("manifest") << QStringLiteral("manifest") << QStringLiteral("manifest");
}

void ResourcesTest::reportsEachMissingComponent()
{
    QFETCH(QString, member);
    QFETCH(QString, description);
    QTemporaryDir directory;
    ResourcePaths paths = completeLayout(directory);
    QString path;
    if (member == QStringLiteral("standaloneQml")) path = paths.standaloneQml;
    else if (member == QStringLiteral("sharedUi")) path = paths.sharedUi;
    else if (member == QStringLiteral("platformPlugin")) path = paths.platformPlugin;
    else if (member == QStringLiteral("backend")) path = paths.backend;
    else path = paths.manifest;
    QVERIFY(QFile::remove(path));

    const ResourceCheck result = checkResources(paths);
    QVERIFY(!result.ok);
    QVERIFY(result.errors.join(QStringLiteral("\n")).contains(description));
}

void ResourcesTest::rejectsInvalidManifest()
{
    QTemporaryDir directory;
    ResourcePaths paths = completeLayout(directory);
    QVERIFY(writeFile(paths.manifest, "{\"id\":\"other\",\"name\":\"Omamail\",\"version\":\"0.10.1\"}"));
    const ResourceCheck result = checkResources(paths);
    QVERIFY(!result.ok);
    QVERIFY(result.errors.join(QStringLiteral("\n")).contains(QStringLiteral("Invalid standalone manifest")));
}

void ResourcesTest::rejectsBackendWithoutExecutePermission()
{
    QTemporaryDir directory;
    ResourcePaths paths = completeLayout(directory);
    QFile backend(paths.backend);
    backend.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner);
    const ResourceCheck result = checkResources(paths);
    QVERIFY(!result.ok);
    QVERIFY(result.errors.join(QStringLiteral("\n")).contains(QStringLiteral("executable")));
}

void ResourcesTest::smokeTestLoadsQmlHandshakesAndWritesReadyFile()
{
    QTemporaryDir directory;
    ResourcePaths paths = completeLayout(directory);
    paths.backend = QCoreApplication::applicationFilePath();
    const QString readyPath = directory.filePath(QStringLiteral("state/ready.json"));
    QString error;
    QVERIFY2(runSmokeTest(paths, readyPath, &error), qPrintable(error));
    QFile ready(readyPath);
    QVERIFY(ready.open(QIODevice::ReadOnly));
    const QJsonObject value = QJsonDocument::fromJson(ready.readAll()).object();
    QCOMPARE(value.value(QStringLiteral("version")).toString(), QStringLiteral(OMAMAIL_APP_VERSION));
    QCOMPARE(value.value(QStringLiteral("apiVersion")).toInt(), 4);
}

void ResourcesTest::smokeRejectsMismatchedBackendApi()
{
    QTemporaryDir directory;
    ResourcePaths paths = completeLayout(directory);
    paths.backend = QCoreApplication::applicationFilePath();
    qputenv("OMAMAIL_SMOKE_FIXTURE", "stale-api");
    QString error;
    QVERIFY(!runSmokeTest(paths, directory.filePath(QStringLiteral("ready.json")), &error));
    qunsetenv("OMAMAIL_SMOKE_FIXTURE");
    QVERIFY(error.contains(QStringLiteral("does not match")));
    QVERIFY(!QFile::exists(directory.filePath(QStringLiteral("ready.json"))));
}

void ResourcesTest::smokeRejectsOversizedStdoutFrame()
{
    QTemporaryDir directory;
    ResourcePaths paths = completeLayout(directory);
    paths.backend = QCoreApplication::applicationFilePath();
    qputenv("OMAMAIL_SMOKE_FIXTURE", "oversize-stdout");
    QString error;
    QVERIFY(!runSmokeTest(paths, directory.filePath(QStringLiteral("ready.json")), &error));
    qunsetenv("OMAMAIL_SMOKE_FIXTURE");
    QVERIFY(error.contains(QStringLiteral("too large")));
    QVERIFY(!QFile::exists(directory.filePath(QStringLiteral("ready.json"))));
}

void ResourcesTest::smokeDrainsLargeStderr()
{
    QTemporaryDir directory;
    ResourcePaths paths = completeLayout(directory);
    paths.backend = QCoreApplication::applicationFilePath();
    qputenv("OMAMAIL_SMOKE_FIXTURE", "large-stderr");
    QString error;
    QVERIFY2(runSmokeTest(paths, directory.filePath(QStringLiteral("ready.json")), &error),
             qPrintable(error));
    qunsetenv("OMAMAIL_SMOKE_FIXTURE");
}

void ResourcesTest::smokeBoundsBothChannelsAfterQuitReply()
{
    QTemporaryDir directory;
    ResourcePaths paths = completeLayout(directory);
    paths.backend = QCoreApplication::applicationFilePath();
    qputenv("OMAMAIL_SMOKE_FIXTURE", "flood-after-quit");
    QString error;
    SmokeMetrics metrics;
    QElapsedTimer elapsed;
    elapsed.start();
    QVERIFY(!runSmokeTest(paths, directory.filePath(QStringLiteral("ready.json")), &error,
                          100, &metrics));
    qunsetenv("OMAMAIL_SMOKE_FIXTURE");
    QVERIFY(error.contains(QStringLiteral("timed out")));
    QVERIFY(elapsed.elapsed() < 2000);
    QVERIFY(metrics.maximumStdoutFrameBytes <= 1024 * 1024);
    QVERIFY(metrics.maximumStderrTailBytes <= 64 * 1024);
    QVERIFY(!QFile::exists(directory.filePath(QStringLiteral("ready.json"))));
}

void ResourcesTest::smokeDeadlineCrossedDuringDrainDoesNotWaitForever()
{
    QTemporaryDir directory;
    ResourcePaths paths = completeLayout(directory);
    paths.backend = QCoreApplication::applicationFilePath();
    qputenv("OMAMAIL_SMOKE_FIXTURE", "flood-after-quit");
    QString error;
    QElapsedTimer elapsed;
    elapsed.start();
    QVERIFY(!runSmokeTest(paths, directory.filePath(QStringLiteral("ready.json")), &error, 1));
    qunsetenv("OMAMAIL_SMOKE_FIXTURE");
    QVERIFY(error.contains(QStringLiteral("timed out")));
    // The 1ms argument is only the post-quit drain. runSmokeTest still loads
    // QML, spawns the fixture, and kill-waits up to 1000ms, the same wall
    // budget the flood-after-quit bound uses.
    QVERIFY(elapsed.elapsed() < 2000);
}

void ResourcesTest::bundleDiscoveryDoesNotUseDevelopmentFallbacks()
{
    QTemporaryDir staged;
    const QString executable = staged.filePath(QStringLiteral("Omamail.app/Contents/MacOS/omamail-app"));
    QVERIFY(writeFile(executable));
    const ResourcePaths paths = defaultResourcePaths(executable, false);
    QVERIFY(!paths.sharedUi.startsWith(QStringLiteral(OMAMAIL_SOURCE_ROOT)));
    QVERIFY(paths.backend != QStringLiteral(OMAMAIL_BACKEND_PATH));
    QVERIFY(!paths.platformPlugin.startsWith(QLibraryInfo::path(QLibraryInfo::PluginsPath)));
    const ResourceCheck result = checkResources(paths);
    QVERIFY(!result.ok);
    QVERIFY(result.errors.join(QStringLiteral("\n")).contains(QStringLiteral("shared UI")));
    QVERIFY(result.errors.join(QStringLiteral("\n")).contains(QStringLiteral("platform plugin")));
    QVERIFY(result.errors.join(QStringLiteral("\n")).contains(QStringLiteral("backend")));
}

void ResourcesTest::developmentDiscoveryUsesExplicitSourceAndBackend()
{
    QTemporaryDir staged;
    const QString executable = staged.filePath(QStringLiteral("build/omamail-app"));
    QVERIFY(writeFile(executable));
    const QString backendPath = staged.filePath(QStringLiteral("target/debug/omamail"));
    QVERIFY(writeFile(backendPath, "#!/bin/sh\nexit 0\n"));
    QFile backendFile(backendPath);
    backendFile.setPermissions(backendFile.permissions() | QFileDevice::ExeOwner);
    const QByteArray backend = backendPath.toUtf8();
    qputenv("OMAMAIL_BIN", backend);
    const ResourcePaths paths = defaultResourcePaths(executable, true);
    qunsetenv("OMAMAIL_BIN");
    QCOMPARE(paths.standaloneQml,
             QDir(QStringLiteral(OMAMAIL_SOURCE_ROOT)).filePath(QStringLiteral("app/qml/Main.qml")));
    QCOMPARE(paths.sharedUi,
             QDir(QStringLiteral(OMAMAIL_SOURCE_ROOT)).filePath(QStringLiteral("ui/Service.qml")));
    QCOMPARE(paths.backend, QString::fromUtf8(backend));
}

void ResourcesTest::bundleDiscoveryAcceptsPortableRootLayout()
{
    QTemporaryDir staged;
    const QString executable = staged.filePath(QStringLiteral("omamail.app/bin/omamail-app"));
    QVERIFY(writeFile(executable));
    QVERIFY(writeFile(staged.filePath(QStringLiteral("omamail.app/qml/Main.qml"))));
    QVERIFY(writeFile(staged.filePath(QStringLiteral("omamail.app/ui/Service.qml"))));
#ifdef Q_OS_WIN
    const QString plugin = QStringLiteral("qwindows.dll");
#elif defined(Q_OS_MACOS)
    const QString plugin = QStringLiteral("libqcocoa.dylib");
#else
    const QString plugin = QStringLiteral("libqxcb.so");
#endif
    QVERIFY(writeFile(staged.filePath(QStringLiteral("omamail.app/plugins/platforms/") + plugin)));
    const QString backend = staged.filePath(
#ifdef Q_OS_WIN
        QStringLiteral("omamail.app/bin/omamail.exe")
#else
        QStringLiteral("omamail.app/bin/omamail")
#endif
    );
    QVERIFY(writeFile(backend, "#!/bin/sh\nexit 0\n"));
    QFile backendFile(backend);
    backendFile.setPermissions(backendFile.permissions() | QFileDevice::ExeOwner);

    const ResourcePaths paths = defaultResourcePaths(executable, false);
    QCOMPARE(paths.standaloneQml,
             staged.filePath(QStringLiteral("omamail.app/qml/Main.qml")));
    QCOMPARE(paths.sharedUi,
             staged.filePath(QStringLiteral("omamail.app/ui/Service.qml")));
    QCOMPARE(paths.platformPlugin,
             staged.filePath(QStringLiteral("omamail.app/plugins/platforms/") + plugin));
    QCOMPARE(paths.backend, backend);
}

int main(int argc, char *argv[])
{
    if (argc > 1 && QByteArray(argv[1]) == QByteArrayLiteral("serve")) {
        const QByteArray fixture = qgetenv("OMAMAIL_SMOKE_FIXTURE");
        if (fixture == QByteArrayLiteral("oversize-stdout")) {
            QFile output;
            if (!output.open(stdout, QIODevice::WriteOnly)) return 2;
            output.write(QByteArray(1024 * 1024 + 1, 'x') + '\n');
            output.flush();
            return 0;
        }
        if (fixture == QByteArrayLiteral("large-stderr")) {
            QFile errors;
            if (!errors.open(stderr, QIODevice::WriteOnly)) return 2;
            errors.write(QByteArray(4 * 1024 * 1024, 'e'));
            errors.flush();
        }
        QTextStream input(stdin, QIODevice::ReadOnly);
        QTextStream output(stdout, QIODevice::WriteOnly);
        while (!input.atEnd()) {
            const QJsonObject request = QJsonDocument::fromJson(input.readLine().toUtf8()).object();
            QJsonObject result;
            if (request.value(QStringLiteral("method")).toString() == QStringLiteral("system.info")) {
                result = {{QStringLiteral("name"), QStringLiteral("omamail")},
                          {QStringLiteral("version"), QStringLiteral(OMAMAIL_APP_VERSION)},
                          {QStringLiteral("protocol"), 1},
                          {QStringLiteral("apiVersion"), fixture == QByteArrayLiteral("stale-api") ? 3 : 4}};
            } else {
                result = {{QStringLiteral("quitReady"), true}};
            }
            const QJsonObject reply{{QStringLiteral("jsonrpc"), QStringLiteral("2.0")},
                                    {QStringLiteral("id"), request.value(QStringLiteral("id"))},
                                    {QStringLiteral("result"), result}};
            output << QJsonDocument(reply).toJson(QJsonDocument::Compact) << Qt::endl;
            if (request.value(QStringLiteral("method")).toString() == QStringLiteral("system.quit")) {
                if (fixture == QByteArrayLiteral("flood-after-quit")) {
                    QFile standardOutput;
                    QFile standardError;
                    if (!standardOutput.open(stdout, QIODevice::WriteOnly)
                        || !standardError.open(stderr, QIODevice::WriteOnly)) return 2;
                    const QByteArray stdoutRecord(8 * 1024, 'o');
                    const QByteArray stderrRecord(8 * 1024, 'e');
                    for (;;) {
                        standardOutput.write(stdoutRecord);
                        standardOutput.write("\n");
                        standardError.write(stderrRecord);
                        standardError.write("\n");
                        if (!standardOutput.flush() || !standardError.flush()) return 0;
                    }
                }
                return 0;
            }
        }
        return 1;
    }
    QGuiApplication application(argc, argv);
    ResourcesTest test;
    return QTest::qExec(&test, argc, argv);
}
#include "tst_resources.moc"
