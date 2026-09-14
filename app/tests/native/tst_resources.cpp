#include "resource_check.h"

#include <QDir>
#include <QFile>
#include <QGuiApplication>
#include <QJsonDocument>
#include <QJsonObject>
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
        writeFile(paths.standaloneQml, "import QtQuick\nItem {}\n");
        writeFile(paths.sharedUi, "import QtQuick\nItem {}\n");
        writeFile(paths.platformPlugin);
        writeFile(paths.backend, "#!/bin/sh\nexit 0\n");
        QFile backend(paths.backend);
        backend.setPermissions(backend.permissions() | QFileDevice::ExeOwner
                               | QFileDevice::ExeGroup | QFileDevice::ExeOther);
        return paths;
    }

private slots:
    void acceptsCompleteReadableLayout();
    void reportsEachMissingComponent_data();
    void reportsEachMissingComponent();
    void rejectsBackendWithoutExecutePermission();
    void smokeTestLoadsQmlHandshakesAndWritesReadyFile();
};

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
    else path = paths.backend;
    QVERIFY(QFile::remove(path));

    const ResourceCheck result = checkResources(paths);
    QVERIFY(!result.ok);
    QVERIFY(result.errors.join(QStringLiteral("\n")).contains(description));
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
    QCOMPARE(value.value(QStringLiteral("version")).toString(), QStringLiteral("fixture-1"));
    QCOMPARE(value.value(QStringLiteral("apiVersion")).toInt(), 9);
}

int main(int argc, char *argv[])
{
    if (argc > 1 && QByteArray(argv[1]) == QByteArrayLiteral("serve")) {
        QTextStream input(stdin, QIODevice::ReadOnly);
        QTextStream output(stdout, QIODevice::WriteOnly);
        while (!input.atEnd()) {
            const QJsonObject request = QJsonDocument::fromJson(input.readLine().toUtf8()).object();
            QJsonObject result;
            if (request.value(QStringLiteral("method")).toString() == QStringLiteral("system.info")) {
                result = {{QStringLiteral("name"), QStringLiteral("omamail")},
                          {QStringLiteral("version"), QStringLiteral("fixture-1")},
                          {QStringLiteral("protocol"), 1},
                          {QStringLiteral("apiVersion"), 9}};
            } else {
                result = {{QStringLiteral("quitReady"), true}};
            }
            const QJsonObject reply{{QStringLiteral("jsonrpc"), QStringLiteral("2.0")},
                                    {QStringLiteral("id"), request.value(QStringLiteral("id"))},
                                    {QStringLiteral("result"), result}};
            output << QJsonDocument(reply).toJson(QJsonDocument::Compact) << Qt::endl;
            if (request.value(QStringLiteral("method")).toString() == QStringLiteral("system.quit"))
                return 0;
        }
        return 1;
    }
    QGuiApplication application(argc, argv);
    ResourcesTest test;
    return QTest::qExec(&test, argc, argv);
}
#include "tst_resources.moc"
