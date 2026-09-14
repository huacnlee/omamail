#include "application_host.h"
#include "notifications.h"

#include <QSignalSpy>
#include <QTest>
#include <QWindow>

class FakeNotificationPlatform final : public NotificationPlatform {
public:
    bool isAvailable = true;
    bool accept = true;
    QString immediateError;
    QList<NativeNotification> shown;

    bool available() const override { return isAvailable; }
    bool show(const NativeNotification &notification, QString *error) override
    {
        shown.append(notification);
        if (!accept && error) *error = immediateError;
        return accept;
    }

    void activate(const QString &token) { emit activated(token); }
    void failLater(const QString &error) { emit failed(error); }
};

class NotificationTest final : public QObject {
    Q_OBJECT

private slots:
    void plainTextAndOpaqueIdentifiers();
    void duplicateIdRoutesToNewestTarget();
    void deliveryFailuresAreNonFatalAndObservable();
    void nulTextIsRejectedBeforeThePlatformBoundary();
    void activationRaisesExistingWindow();
    void nativePlatformIsSafeOutsideAnApplicationBundle();
};

void NotificationTest::plainTextAndOpaqueIdentifiers()
{
    auto platform = std::make_unique<FakeNotificationPlatform>();
    auto *fake = platform.get();
    NotificationService service(std::move(platform));

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
    NotificationService service(std::move(platform));
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

    fake->activate(notificationToken(QStringLiteral("unknown")));
    QCOMPARE(activated.size(), 1);
}

void NotificationTest::deliveryFailuresAreNonFatalAndObservable()
{
    auto platform = std::make_unique<FakeNotificationPlatform>();
    auto *fake = platform.get();
    fake->accept = false;
    fake->immediateError = QStringLiteral("permission denied");
    NotificationService service(std::move(platform));
    QSignalSpy changed(&service, &NotificationService::errorChanged);

    QVERIFY(!service.show(QStringLiteral("id"), {}, {}, {}, {}));
    QCOMPARE(service.error(), QStringLiteral("permission denied"));
    QCOMPARE(changed.size(), 1);

    fake->accept = true;
    QVERIFY(service.show(QStringLiteral("id"), {}, {}, {}, {}));
    QCOMPARE(service.error(), QString());
    fake->failLater(QStringLiteral("native delivery failed"));
    QCOMPARE(service.error(), QStringLiteral("native delivery failed"));
}

void NotificationTest::nulTextIsRejectedBeforeThePlatformBoundary()
{
    auto platform = std::make_unique<FakeNotificationPlatform>();
    auto *fake = platform.get();
    NotificationService service(std::move(platform));
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
    ApplicationHost host({}, {}, {}, std::move(platform));
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
