#include "application_host.h"
#include "file_store.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QSignalSpy>
#include <QStandardPaths>
#include <QTemporaryDir>
#include <QTest>

class SettingsTest : public QObject {
    Q_OBJECT

private slots:
    void initTestCase();
    void atomicSettingsRoundTrip();
    void invalidJsonIsPreserved();
    void rejectsCredentialAndUnknownFields();
    void fileStoreReadsWritesAndWatches();
    void watchReportsExternalCreation();
    void watchReportsDirectoryMutation();
    void watchSettlesAfterDirectoryMutation();
    void environmentUsesFixedAllowlist();
    void applicationPathsMatchBackendRoots();
    void applicationPathsRejectTraversalAndRemoteUrls();
};

void SettingsTest::initTestCase()
{
    QStandardPaths::setTestModeEnabled(true);
}

void SettingsTest::atomicSettingsRoundTrip()
{
    QTemporaryDir directory;
    QVERIFY(directory.isValid());
    const QString path = directory.filePath(QStringLiteral("settings.json"));
    SettingsStore store(path);
    QString error;
    const QVariantMap settings{{QStringLiteral("refreshIntervalSec"), 300},
                               {QStringLiteral("contentDirection"), QStringLiteral("Auto")},
                               {QStringLiteral("unifiedMailboxes"), true}};
    QVERIFY2(store.replace(settings, &error), qPrintable(error));
    QCOMPARE(store.load(&error), settings);
    QVERIFY(error.isEmpty());
    QCOMPARE(QDir(directory.path()).entryList(QDir::Files),
             QStringList{QStringLiteral("settings.json")});
    const QFileDevice::Permissions permissions = QFileInfo(path).permissions();
    QVERIFY(permissions.testFlag(QFileDevice::ReadOwner));
    QVERIFY(permissions.testFlag(QFileDevice::WriteOwner));
#ifndef Q_OS_WIN
    // NTFS has no group and other bits; Qt reports the file readable by both
    // whatever the ACL says, so the private mode is a POSIX assertion.
    QVERIFY(!permissions.testFlag(QFileDevice::ReadGroup));
    QVERIFY(!permissions.testFlag(QFileDevice::ReadOther));
#endif
}

void SettingsTest::invalidJsonIsPreserved()
{
    QTemporaryDir directory;
    const QString path = directory.filePath(QStringLiteral("settings.json"));
    const QByteArray original("{not valid json\n");
    QFile file(path);
    QVERIFY(file.open(QIODevice::WriteOnly));
    QCOMPARE(file.write(original), original.size());
    file.close();

    SettingsStore store(path);
    QString error;
    QVERIFY(!store.replace({{QStringLiteral("maxMessages"), 25}}, &error));
    QVERIFY(!error.isEmpty());
    QVERIFY(file.open(QIODevice::ReadOnly));
    QCOMPARE(file.readAll(), original);
}

void SettingsTest::rejectsCredentialAndUnknownFields()
{
    QTemporaryDir directory;
    const QString path = directory.filePath(QStringLiteral("settings.json"));
    SettingsStore store(path);
    QString error;
    QVERIFY(!store.replace({{QStringLiteral("refreshToken"), QStringLiteral("synthetic-secret")}}, &error));
    QVERIFY(!QFile::exists(path));
    QVERIFY(!store.replace({{QStringLiteral("futureUnreviewedField"), true}}, &error));
    QVERIFY(!QFile::exists(path));
}

void SettingsTest::fileStoreReadsWritesAndWatches()
{
    QTemporaryDir directory;
    const QString path = directory.filePath(QStringLiteral("payload.txt"));
    FileStore store;
    QVERIFY(!store.exists(path));
    QSignalSpy changed(&store, &FileStore::changed);
    auto written = store.write(path, QString::fromUtf8("one €"), true);
    QVERIFY(written.value(QStringLiteral("ok")).toBool());
    QVERIFY(store.exists(path));
    QVERIFY(store.exists(directory.path()));
    const auto read = store.read(path);
    QVERIFY(read.value(QStringLiteral("ok")).toBool());
    QCOMPARE(read.value(QStringLiteral("text")).toString(), QString::fromUtf8("one €"));

    store.watch(path, true);
    written = store.write(path, QStringLiteral("two"), true);
    QVERIFY(written.value(QStringLiteral("ok")).toBool());
    QTRY_VERIFY_WITH_TIMEOUT(!changed.isEmpty(), 2000);
    QCOMPARE(changed.last().at(0).toString(), path);
}

void SettingsTest::environmentUsesFixedAllowlist()
{
    qputenv("OMAMAIL_BIN", "/synthetic/backend");
    qputenv("OMAMAIL_TEST_SECRET", "must-not-cross-qml-boundary");
    ApplicationHost host;
    QCOMPARE(host.environment(QStringLiteral("OMAMAIL_BIN")), QStringLiteral("/synthetic/backend"));
    QCOMPARE(host.environment(QStringLiteral("OMAMAIL_TEST_SECRET")), QString());
}

void SettingsTest::applicationPathsMatchBackendRoots()
{
    ApplicationHost host;
#ifdef Q_OS_WIN
    const QByteArray oldAppData = qgetenv("APPDATA");
    qputenv("APPDATA", "C:/Users/fixture/AppData/Roaming");
    QCOMPARE(QDir::fromNativeSeparators(host.configPath(QStringLiteral("settings.json"))),
             QStringLiteral("C:/Users/fixture/AppData/Roaming/omamail/settings.json"));
    qputenv("APPDATA", oldAppData);
#elif defined(Q_OS_MACOS)
    QCOMPARE(host.configPath(QStringLiteral("settings.json")),
             QDir(QDir::homePath()).filePath(
                 QStringLiteral("Library/Application Support/omamail/settings.json")));
#else
    const QByteArray oldConfigHome = qgetenv("XDG_CONFIG_HOME");
    qputenv("XDG_CONFIG_HOME", "/tmp/omamail-xdg-config");
    QCOMPARE(host.configPath(QStringLiteral("settings.json")),
             QStringLiteral("/tmp/omamail-xdg-config/omamail/settings.json"));
    qputenv("XDG_CONFIG_HOME", oldConfigHome);
#endif
}

void SettingsTest::applicationPathsRejectTraversalAndRemoteUrls()
{
    ApplicationHost host;
    QVERIFY(host.configPath(QStringLiteral("window.json")).endsWith(QStringLiteral("window.json")));
    QVERIFY(host.cachePath(QStringLiteral("compose/draft-1")).endsWith(
        QStringLiteral("compose/draft-1")));
    for (const QString &value : {QStringLiteral("../outside"), QStringLiteral("a/../outside"),
                                 QStringLiteral("a\\outside"), QStringLiteral("a\nname"),
                                 QStringLiteral("/absolute")}) {
        QVERIFY2(host.configPath(value).isEmpty(), qPrintable(value));
        QVERIFY2(host.cachePath(value).isEmpty(), qPrintable(value));
    }
    QCOMPARE(host.localFilePath(QUrl::fromLocalFile(QStringLiteral("/tmp/a b"))),
             QStringLiteral("/tmp/a b"));
    QVERIFY(host.localFilePath(QUrl(QStringLiteral("https://example.test/file"))).isEmpty());
}

void SettingsTest::watchReportsExternalCreation()
{
    QTemporaryDir directory;
    const QString path = directory.filePath(QStringLiteral("created-later.txt"));
    FileStore store;
    QSignalSpy changed(&store, &FileStore::changed);
    store.watch(path, true);
    QFile file(path);
    QVERIFY(file.open(QIODevice::WriteOnly));
    QCOMPARE(file.write("outside"), qint64(7));
    file.close();
    QTRY_VERIFY_WITH_TIMEOUT(!changed.isEmpty(), 2000);
    QCOMPARE(changed.last().at(0).toString(), path);
}

void SettingsTest::watchReportsDirectoryMutation()
{
    QTemporaryDir directory;
    const QString watchedDirectory = directory.filePath(QStringLiteral("current"));
    QVERIFY(QDir().mkpath(watchedDirectory));
    FileStore store;
    QSignalSpy changed(&store, &FileStore::changed);
    store.watch(watchedDirectory, true);

    QFile file(QDir(watchedDirectory).filePath(QStringLiteral("replacement")));
    QVERIFY(file.open(QIODevice::WriteOnly));
    QCOMPARE(file.write("outside"), qint64(7));
    file.close();
    QTRY_VERIFY_WITH_TIMEOUT(!changed.isEmpty(), 2000);
    QCOMPARE(changed.last().at(0).toString(), watchedDirectory);
}

// A directory event used to re-arm every watch, and re-arming the directory
// raised another directory event: one metadata tick on a sibling file kept
// the store emitting for the rest of the process's life.
void SettingsTest::watchSettlesAfterDirectoryMutation()
{
    QTemporaryDir directory;
    const QString missing = directory.filePath(QStringLiteral("calendars.json"));
    const QString present = directory.filePath(QStringLiteral("credentials.json"));
    QFile seed(present);
    QVERIFY(seed.open(QIODevice::WriteOnly));
    QCOMPARE(seed.write("{}"), qint64(2));
    seed.close();
    // The backend keeps lock files beside its registry. Qt's FSEvents engine
    // lists a directory without hidden entries when a watch is added and with
    // them when it checks the directory, so a hidden sibling makes every
    // re-armed watch report the directory as changed once more.
    QFile lock(directory.filePath(QStringLiteral(".accounts.lock")));
    QVERIFY(lock.open(QIODevice::WriteOnly));
    lock.close();
    FileStore store;
    QSignalSpy changed(&store, &FileStore::changed);
    store.watch(missing, true);
    store.watch(present, true);
    QTest::qWait(300);
    changed.clear();

    // A sibling written is a directory event everywhere. The backend's own
    // touch, re-asserting a private mode that already holds, moves only a
    // ctime, which is nothing Windows reports.
    QFile sibling(directory.filePath(QStringLiteral("accounts.json")));
    QVERIFY(sibling.open(QIODevice::WriteOnly));
    QCOMPARE(sibling.write("outside"), qint64(7));
    sibling.close();
#ifndef Q_OS_WIN
    QVERIFY(QFile::setPermissions(directory.path(), QFileDevice::ReadOwner | QFileDevice::WriteOwner | QFileDevice::ExeOwner));
    QVERIFY(QFile::setPermissions(present, QFileDevice::ReadOwner | QFileDevice::WriteOwner));
#endif
    QTRY_VERIFY_WITH_TIMEOUT(!changed.isEmpty(), 2000);
    QTest::qWait(500);
    const int settled = changed.count();
    QTest::qWait(1000);
    QCOMPARE(changed.count(), settled);
    // A handful for two coalesced events over two watched paths; the loop
    // produced hundreds and was still going.
    QVERIFY2(settled <= 16, qPrintable(QString::number(settled)));
}

QTEST_MAIN(SettingsTest)
#include "tst_settings.moc"
