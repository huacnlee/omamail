#include "application_host.h"
#include "notifications.h"

#include <QFileDevice>
#include <QFileInfo>
#include <QFile>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QTest>
#include <QWindow>

class FakeNotificationPlatform final : public NotificationPlatform {
public:
    bool isAvailable = true;
    bool accept = true;
    QString immediateError;
    QList<NativeNotification> shown;
    QStringList pending;

    bool available() const override { return isAvailable; }
    bool show(const NativeNotification &notification, QString *error) override
    {
        shown.append(notification);
        if (!accept && error) *error = immediateError;
        return accept;
    }
    QStringList takePendingActivations() override
    {
        const QStringList result = pending;
        pending.clear();
        return result;
    }

    void activate(const QString &token) { emit activated(token); }
    void deliver(const QString &token) { emit delivered(token); }
    void failLater(const QString &error) { emit failed(error); }
    void assignAlias(const QString &token, const QString &alias)
    {
        emit activationAliasAssigned(token, alias);
    }
};

class NotificationTest final : public QObject {
    Q_OBJECT

private slots:
    void plainTextAndOpaqueIdentifiers();
    void duplicateIdRoutesToNewestTarget();
    void deliveryFailuresAreNonFatalAndObservable();
    void nulTextIsRejectedBeforeThePlatformBoundary();
    void activationRaisesExistingWindow();
    void routesSurviveRestartAndEarlyActivation();
    void platformActivationAliasSurvivesRestart();
    void invalidRoutesNeverReachThePlatform();
    void failedReplacementKeepsThePreviousDurableRoute();
    void unsafeRouteFileIsRefused();
    void publicRouteFileIsNotLoaded();
    void nativePlatformIsSafeOutsideAnApplicationBundle();
};

void NotificationTest::plainTextAndOpaqueIdentifiers()
{
    auto platform = std::make_unique<FakeNotificationPlatform>();
    auto *fake = platform.get();
    QTemporaryDir directory;
    QVERIFY(directory.isValid());
    NotificationService service(std::move(platform),
        directory.filePath(QStringLiteral("routes.json")));

    const QString hostileId = QStringLiteral("account\\\";$(touch never):邮件");
    const QString title = QStringLiteral("'quote' \\\\ <b>邮件</b>\rline\nend\r\nlast");
    const QString body = QStringLiteral("<img src='https://tracker.invalid/x'> & text");
    QVERIFY(service.show(hostileId, title, body, QStringLiteral("account"),
                         QStringLiteral("message")));
    QCOMPARE(fake->shown.size(), 1);
    QCOMPARE(fake->shown[0].token, notificationToken(hostileId));
    QCOMPARE(fake->shown[0].token.size(), 64);
    QVERIFY(!fake->shown[0].token.contains(QStringLiteral("account")));
    QCOMPARE(fake->shown[0].title,
             QStringLiteral("'quote' \\\\ <b>邮件</b>\nline\nend\nlast"));
    QCOMPARE(fake->shown[0].body, body);
    QCOMPARE(notificationMarkupText(fake->shown[0].body),
             QStringLiteral("&lt;img src=&apos;https://tracker.invalid/x&apos;&gt; &amp; text"));
}

void NotificationTest::duplicateIdRoutesToNewestTarget()
{
    auto platform = std::make_unique<FakeNotificationPlatform>();
    auto *fake = platform.get();
    QTemporaryDir directory;
    QVERIFY(directory.isValid());
    NotificationService service(std::move(platform),
        directory.filePath(QStringLiteral("routes.json")));
    QSignalSpy activated(&service, &NotificationService::activated);

    QVERIFY(service.show(QStringLiteral("same"), QStringLiteral("first"), {},
                         QStringLiteral("account-1"), QStringLiteral("message-1")));
    QVERIFY(service.show(QStringLiteral("same"), QStringLiteral("second"), {},
                         QStringLiteral("account-2"), QStringLiteral("message-2")));
    QCOMPARE(fake->shown[0].token, fake->shown[1].token);
    fake->activate(fake->shown[0].token);
    QCOMPARE(activated.size(), 1);
    QCOMPARE(activated[0][0].toString(), QStringLiteral("account-2"));
    QCOMPARE(activated[0][1].toString(), QStringLiteral("message-2"));
    fake->activate(fake->shown[0].token);
    QCOMPARE(activated.size(), 1);

    fake->activate(notificationToken(QStringLiteral("unknown")));
    QCOMPARE(activated.size(), 1);
}

void NotificationTest::deliveryFailuresAreNonFatalAndObservable()
{
    auto platform = std::make_unique<FakeNotificationPlatform>();
    auto *fake = platform.get();
    fake->accept = false;
    fake->immediateError = QStringLiteral("permission denied");
    QTemporaryDir directory;
    QVERIFY(directory.isValid());
    NotificationService service(std::move(platform),
        directory.filePath(QStringLiteral("routes.json")));
    QSignalSpy changed(&service, &NotificationService::errorChanged);

    QVERIFY(!service.show(QStringLiteral("id"), {}, {}, QStringLiteral("account"),
                          QStringLiteral("message")));
    QCOMPARE(service.error(), QStringLiteral("permission denied"));
    QCOMPARE(changed.size(), 1);

    fake->accept = true;
    QVERIFY(service.show(QStringLiteral("id"), {}, {}, QStringLiteral("account"),
                         QStringLiteral("message")));
    QCOMPARE(service.error(), QStringLiteral("permission denied"));
    fake->deliver(notificationToken(QStringLiteral("id")));
    QCOMPARE(service.error(), QString());
    fake->failLater(QStringLiteral("native delivery failed"));
    QCOMPARE(service.error(), QStringLiteral("native delivery failed"));
}

void NotificationTest::nulTextIsRejectedBeforeThePlatformBoundary()
{
    auto platform = std::make_unique<FakeNotificationPlatform>();
    auto *fake = platform.get();
    QTemporaryDir directory;
    QVERIFY(directory.isValid());
    NotificationService service(std::move(platform),
        directory.filePath(QStringLiteral("routes.json")));
    const QString body = QStringLiteral("before") + QChar::Null
        + QStringLiteral("after");

    QVERIFY(!service.show(QStringLiteral("id"), QStringLiteral("title"), body,
                          QStringLiteral("account"), QStringLiteral("message")));
    QVERIFY(service.error().contains(QStringLiteral("NUL")));
    QVERIFY(fake->shown.isEmpty());
}

void NotificationTest::activationRaisesExistingWindow()
{
    auto platform = std::make_unique<FakeNotificationPlatform>();
    auto *fake = platform.get();
    QTemporaryDir directory;
    QVERIFY(directory.isValid());
    ApplicationHost host({}, {}, directory.filePath(QStringLiteral("settings.json")),
                         std::move(platform));
    QSignalSpy activated(&host, &ApplicationHost::notificationActivated);
    QWindow window;
    window.hide();

    QVERIFY(host.showNotification(QStringLiteral("id"), QStringLiteral("title"),
                                  QStringLiteral("body"), QStringLiteral("account"),
                                  QStringLiteral("message")));
    fake->activate(notificationToken(QStringLiteral("id")));
    QTRY_VERIFY(window.isVisible());
    QCOMPARE(activated.size(), 1);
    QCOMPARE(activated[0][0].toString(), QStringLiteral("account"));
    QCOMPARE(activated[0][1].toString(), QStringLiteral("message"));
    QCOMPARE(host.pendingNotificationActivation().value(QStringLiteral("messageId")),
             QStringLiteral("message"));
    QCOMPARE(host.takePendingNotificationActivation().value(
                 QStringLiteral("accountId")), QStringLiteral("account"));
    QVERIFY(host.pendingNotificationActivation().isEmpty());
}

void NotificationTest::routesSurviveRestartAndEarlyActivation()
{
    QTemporaryDir directory;
    QVERIFY(directory.isValid());
    const QString path = directory.filePath(QStringLiteral("routes.json"));
    const QString token = notificationToken(QStringLiteral("persistent-id"));
    {
        auto platform = std::make_unique<FakeNotificationPlatform>();
        NotificationService service(std::move(platform), path);
        QVERIFY(service.show(QStringLiteral("persistent-id"), QStringLiteral("title"),
                             QStringLiteral("body"), QStringLiteral("account-1"),
                             QStringLiteral("message-1")));
    }
#ifndef Q_OS_WIN
    const auto unsafePermissions = QFileDevice::ReadGroup | QFileDevice::WriteGroup
        | QFileDevice::ExeGroup | QFileDevice::ReadOther | QFileDevice::WriteOther
        | QFileDevice::ExeOther;
    QVERIFY(!(QFileInfo(path).permissions() & unsafePermissions));
#endif

    auto restartedPlatform = std::make_unique<FakeNotificationPlatform>();
    restartedPlatform->pending = {token};
    NotificationService restarted(std::move(restartedPlatform), path);
    QSignalSpy activated(&restarted, &NotificationService::activated);
    QTRY_COMPARE(activated.size(), 1);
    QCOMPARE(activated[0][0].toString(), QStringLiteral("account-1"));
    QCOMPARE(activated[0][1].toString(), QStringLiteral("message-1"));
}

void NotificationTest::platformActivationAliasSurvivesRestart()
{
    QTemporaryDir directory;
    QVERIFY(directory.isValid());
    const QString path = directory.filePath(QStringLiteral("routes.json"));
    const QString token = notificationToken(QStringLiteral("persistent-id"));
    const QString alias = notificationToken(QStringLiteral("linux-notification:42"));
    {
        auto platform = std::make_unique<FakeNotificationPlatform>();
        auto *fake = platform.get();
        NotificationService service(std::move(platform), path);
        QVERIFY(service.show(QStringLiteral("persistent-id"), QStringLiteral("title"),
                             {}, QStringLiteral("account"),
                             QStringLiteral("message")));
        fake->assignAlias(token, alias);
    }

    auto restartedPlatform = std::make_unique<FakeNotificationPlatform>();
    restartedPlatform->pending = {alias};
    NotificationService restarted(std::move(restartedPlatform), path);
    QSignalSpy activated(&restarted, &NotificationService::activated);
    QTRY_COMPARE(activated.size(), 1);
    QCOMPARE(activated[0][0].toString(), QStringLiteral("account"));
    QCOMPARE(activated[0][1].toString(), QStringLiteral("message"));
}

void NotificationTest::invalidRoutesNeverReachThePlatform()
{
    QTemporaryDir directory;
    QVERIFY(directory.isValid());
    auto platform = std::make_unique<FakeNotificationPlatform>();
    auto *fake = platform.get();
    NotificationService service(std::move(platform),
        directory.filePath(QStringLiteral("routes.json")));

    QVERIFY(!service.show(QStringLiteral("id"), QStringLiteral("title"), {},
                          QStringLiteral("account\nforged"), QStringLiteral("message")));
    QVERIFY(fake->shown.isEmpty());
}

void NotificationTest::failedReplacementKeepsThePreviousDurableRoute()
{
    QTemporaryDir directory;
    QVERIFY(directory.isValid());
    const QString path = directory.filePath(QStringLiteral("routes.json"));
    const QString token = notificationToken(QStringLiteral("same"));
    auto platform = std::make_unique<FakeNotificationPlatform>();
    auto *fake = platform.get();
    {
        NotificationService service(std::move(platform), path);
        QVERIFY(service.show(QStringLiteral("same"), QStringLiteral("first"), {},
                             QStringLiteral("account-old"),
                             QStringLiteral("message-old")));
        fake->accept = false;
        fake->immediateError = QStringLiteral("delivery refused");
        QVERIFY(!service.show(QStringLiteral("same"), QStringLiteral("second"), {},
                              QStringLiteral("account-new"),
                              QStringLiteral("message-new")));
    }

    auto restartedPlatform = std::make_unique<FakeNotificationPlatform>();
    restartedPlatform->pending = {token};
    NotificationService restarted(std::move(restartedPlatform), path);
    QSignalSpy activated(&restarted, &NotificationService::activated);
    QTRY_COMPARE(activated.size(), 1);
    QCOMPARE(activated[0][0].toString(), QStringLiteral("account-old"));
    QCOMPARE(activated[0][1].toString(), QStringLiteral("message-old"));
}

void NotificationTest::unsafeRouteFileIsRefused()
{
#ifdef Q_OS_UNIX
    QTemporaryDir directory;
    QVERIFY(directory.isValid());
    const QString outside = directory.filePath(QStringLiteral("outside"));
    QFile outsideFile(outside);
    QVERIFY(outsideFile.open(QIODevice::WriteOnly));
    QCOMPARE(outsideFile.write("unchanged"), 9);
    outsideFile.close();
    const QString route = directory.filePath(QStringLiteral("routes.json"));
    QVERIFY(QFile::link(outside, route));
    auto platform = std::make_unique<FakeNotificationPlatform>();
    auto *fake = platform.get();
    NotificationService service(std::move(platform), route);

    QVERIFY(!service.show(QStringLiteral("id"), QStringLiteral("title"), {},
                          QStringLiteral("account"), QStringLiteral("message")));
    QVERIFY(service.error().contains(QStringLiteral("unsafe")));
    QVERIFY(fake->shown.isEmpty());
    QVERIFY(outsideFile.open(QIODevice::ReadOnly));
    QCOMPARE(outsideFile.readAll(), QByteArray("unchanged"));
#else
    QSKIP("Windows route contents are protected with DPAPI");
#endif
}

void NotificationTest::publicRouteFileIsNotLoaded()
{
#ifdef Q_OS_UNIX
    QTemporaryDir directory;
    QVERIFY(directory.isValid());
    const QString path = directory.filePath(QStringLiteral("routes.json"));
    const QString token = notificationToken(QStringLiteral("id"));
    {
        auto platform = std::make_unique<FakeNotificationPlatform>();
        NotificationService service(std::move(platform), path);
        QVERIFY(service.show(QStringLiteral("id"), QStringLiteral("title"), {},
                             QStringLiteral("account"), QStringLiteral("message")));
    }
    QFile route(path);
    QVERIFY(route.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner
                                 | QFileDevice::ReadGroup | QFileDevice::ReadOther));
    auto platform = std::make_unique<FakeNotificationPlatform>();
    platform->pending = {token};
    NotificationService service(std::move(platform), path);
    QSignalSpy activated(&service, &NotificationService::activated);
    QTest::qWait(10);
    QCOMPARE(activated.size(), 0);
    QVERIFY(service.error().contains(QStringLiteral("not private")));
#else
    QSKIP("Windows route contents are protected with DPAPI");
#endif
}

void NotificationTest::nativePlatformIsSafeOutsideAnApplicationBundle()
{
#ifdef Q_OS_MACOS
    NotificationService service;
    QVERIFY(!service.available());
    QVERIFY(!service.show(QStringLiteral("id"), QStringLiteral("title"),
                          QStringLiteral("body"), {}, {}));
    QVERIFY(service.error().contains(QStringLiteral("unavailable")));
#else
    QSKIP("The native runner exercises this platform adapter separately");
#endif
}

QTEST_MAIN(NotificationTest)
#include "tst_notifications.moc"
