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
    void environmentUsesFixedAllowlist();
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
    QVERIFY(!permissions.testFlag(QFileDevice::ReadGroup));
    QVERIFY(!permissions.testFlag(QFileDevice::ReadOther));
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
    QSignalSpy changed(&store, &FileStore::changed);
    auto written = store.write(path, QString::fromUtf8("one €"), true);
    QVERIFY(written.value(QStringLiteral("ok")).toBool());
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

QTEST_MAIN(SettingsTest)
#include "tst_settings.moc"
