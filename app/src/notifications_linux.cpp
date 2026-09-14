#include "notifications.h"

#include <QDBusConnection>
#include <QDBusInterface>
#include <QDBusPendingCallWatcher>
#include <QDBusPendingReply>
#include <QVariantMap>

namespace {
class LinuxNotificationPlatform final : public NotificationPlatform {
    Q_OBJECT

public:
    LinuxNotificationPlatform()
        : m_bus(QDBusConnection::sessionBus()),
          m_notifications(QStringLiteral("org.freedesktop.Notifications"),
                          QStringLiteral("/org/freedesktop/Notifications"),
                          QStringLiteral("org.freedesktop.Notifications"), m_bus)
    {
        if (!m_bus.isConnected()) return;
        m_bus.connect(QStringLiteral("org.freedesktop.Notifications"),
                      QStringLiteral("/org/freedesktop/Notifications"),
                      QStringLiteral("org.freedesktop.Notifications"),
                      QStringLiteral("ActionInvoked"), this,
                      SLOT(actionInvoked(uint,QString)));
        m_bus.connect(QStringLiteral("org.freedesktop.Notifications"),
                      QStringLiteral("/org/freedesktop/Notifications"),
                      QStringLiteral("org.freedesktop.Notifications"),
                      QStringLiteral("NotificationClosed"), this,
                      SLOT(notificationClosed(uint,uint)));
    }

    bool available() const override { return m_bus.isConnected(); }

    bool show(const NativeNotification &notification, QString *error) override
    {
        if (!available()) {
            if (error) *error = QStringLiteral("Linux desktop notification bus is unavailable");
            return false;
        }
        if (notification.title.contains(QChar::Null)
            || notification.body.contains(QChar::Null)) {
            if (error) *error = QStringLiteral("Desktop notification text contains NUL");
            return false;
        }

        const quint64 revision = ++m_revisions[notification.token];
        const uint replacesId = m_tokenToNative.value(notification.token, 0);
        const QStringList actions{QStringLiteral("default"), QStringLiteral("Open")};
        QVariantMap hints;
        hints.insert(QStringLiteral("desktop-entry"), QStringLiteral("omamail"));
        const QList<QVariant> arguments{
            QStringLiteral("Omamail"), replacesId, QString{},
            notification.title,
            notificationMarkupText(notification.body), actions, hints, -1};

        auto *watcher = new QDBusPendingCallWatcher(
            m_notifications.asyncCallWithArgumentList(QStringLiteral("Notify"), arguments),
            this);
        watcher->setProperty("omamailToken", notification.token);
        watcher->setProperty("omamailRevision", QVariant::fromValue(revision));
        connect(watcher, &QDBusPendingCallWatcher::finished, this,
                &LinuxNotificationPlatform::notificationCreated);
        return true;
    }

private slots:
    void notificationCreated(QDBusPendingCallWatcher *watcher)
    {
        const QString token = watcher->property("omamailToken").toString();
        const quint64 revision = watcher->property("omamailRevision").toULongLong();
        const QDBusPendingReply<uint> reply = *watcher;
        watcher->deleteLater();
        if (reply.isError()) {
            if (m_revisions.value(token) == revision)
                emit failed(QStringLiteral("Linux notification delivery failed: %1")
                                .arg(reply.error().message()));
            return;
        }

        const uint nativeId = reply.value();
        if (m_revisions.value(token) != revision) {
            m_notifications.asyncCall(QStringLiteral("CloseNotification"), nativeId);
            return;
        }
        const uint previous = m_tokenToNative.value(token, 0);
        if (previous && previous != nativeId) m_nativeToToken.remove(previous);
        m_tokenToNative.insert(token, nativeId);
        m_nativeToToken.insert(nativeId, token);
        emit delivered(token);
        emit activationAliasAssigned(token,
            notificationToken(QStringLiteral("linux-notification:")
                              + QString::number(nativeId)));
    }

    void actionInvoked(uint nativeId, const QString &action)
    {
        if (action != QStringLiteral("default") && action != QStringLiteral("open"))
            return;
        const auto token = m_nativeToToken.constFind(nativeId);
        if (token != m_nativeToToken.cend()) deliverActivation(*token);
        else
            deliverActivation(notificationToken(QStringLiteral("linux-notification:")
                                                + QString::number(nativeId)));
    }

    void notificationClosed(uint nativeId, uint)
    {
        const QString token = m_nativeToToken.take(nativeId);
        if (!token.isEmpty() && m_tokenToNative.value(token) == nativeId)
            m_tokenToNative.remove(token);
    }

private:
    QDBusConnection m_bus;
    QDBusInterface m_notifications;
    QHash<QString, quint64> m_revisions;
    QHash<QString, uint> m_tokenToNative;
    QHash<uint, QString> m_nativeToToken;
};
}

std::unique_ptr<NotificationPlatform> createNotificationPlatform()
{
    return std::make_unique<LinuxNotificationPlatform>();
}

void initializeNotificationActivation() {}

#include "notifications_linux.moc"
