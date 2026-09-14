#include "notifications.h"

#include <QDBusConnection>
#include <QDBusConnectionInterface>
#include <QDBusInterface>
#include <QDBusPendingCallWatcher>
#include <QDBusPendingReply>
#include <QDBusReply>
#include <QDBusServiceWatcher>
#include <QVariantMap>

namespace {
const QString notificationService = QStringLiteral("org.freedesktop.Notifications");

class LinuxNotificationPlatform final : public NotificationPlatform {
    Q_OBJECT

public:
    LinuxNotificationPlatform()
        : m_bus(QDBusConnection::sessionBus()),
          m_notifications(notificationService,
                          QStringLiteral("/org/freedesktop/Notifications"),
                          QStringLiteral("org.freedesktop.Notifications"), m_bus),
          m_serviceWatcher(notificationService, m_bus,
                QDBusServiceWatcher::WatchForOwnerChange, this)
    {
        if (!m_bus.isConnected()) return;
        updateServiceOwner(currentServiceOwner());
        connect(&m_serviceWatcher, &QDBusServiceWatcher::serviceOwnerChanged,
                this, [this](const QString &, const QString &, const QString &owner) {
                    updateServiceOwner(owner);
                });
        m_bus.connect(notificationService,
                      QStringLiteral("/org/freedesktop/Notifications"),
                      QStringLiteral("org.freedesktop.Notifications"),
                      QStringLiteral("ActionInvoked"), this,
                      SLOT(actionInvoked(uint,QString)));
        m_bus.connect(notificationService,
                      QStringLiteral("/org/freedesktop/Notifications"),
                      QStringLiteral("org.freedesktop.Notifications"),
                      QStringLiteral("NotificationClosed"), this,
                      SLOT(notificationClosed(uint,uint)));
    }

    bool available() const override { return m_bus.isConnected(); }
    QString activationNamespace() const override { return m_serviceOwner; }

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

        const QString owner = currentServiceOwner();
        if (owner != m_serviceOwner) updateServiceOwner(owner);
        trackRevision(notification.token, notification.revision);
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
        watcher->setProperty("omamailRevision",
                             QVariant::fromValue(notification.revision));
        watcher->setProperty("omamailServiceOwner", m_serviceOwner);
        connect(watcher, &QDBusPendingCallWatcher::finished, this,
                &LinuxNotificationPlatform::notificationCreated);
        return true;
    }

private slots:
    void notificationCreated(QDBusPendingCallWatcher *watcher)
    {
        const QString token = watcher->property("omamailToken").toString();
        const quint64 revision = watcher->property("omamailRevision").toULongLong();
        QString serviceOwner = watcher->property("omamailServiceOwner").toString();
        const QDBusPendingReply<uint> reply = *watcher;
        watcher->deleteLater();
        if (reply.isError()) {
            if (takeCurrentRevision(token, revision))
                emit failed(token, revision,
                    QStringLiteral("Linux notification delivery failed: %1")
                        .arg(reply.error().message()));
            return;
        }

        const uint nativeId = reply.value();
        const QString currentOwner = currentServiceOwner();
        if (currentOwner != m_serviceOwner) updateServiceOwner(currentOwner);
        if (m_revisions.value(token) != revision) {
            if (!serviceOwner.isEmpty() && serviceOwner == m_serviceOwner)
                m_notifications.asyncCall(QStringLiteral("CloseNotification"), nativeId);
            return;
        }
        if (serviceOwner.isEmpty()) serviceOwner = currentOwner;
        if (serviceOwner.isEmpty() || serviceOwner != m_serviceOwner) return;
        takeCurrentRevision(token, revision);
        rememberNativeId(token, nativeId);
        emit delivered(token, revision);
        emit activationAliasAssigned(token, revision,
            notificationPlatformAlias(serviceOwner, nativeId), serviceOwner);
    }

    void actionInvoked(uint nativeId, const QString &action)
    {
        if (action != QStringLiteral("default") && action != QStringLiteral("open"))
            return;
        const auto token = m_nativeToToken.constFind(nativeId);
        if (token != m_nativeToToken.cend()) deliverActivation(*token);
        else if (!m_serviceOwner.isEmpty())
            deliverActivation(notificationPlatformAlias(m_serviceOwner, nativeId));
    }

    void notificationClosed(uint nativeId, uint)
    {
        const QString token = m_nativeToToken.take(nativeId);
        if (!token.isEmpty() && m_tokenToNative.value(token) == nativeId) {
            m_tokenToNative.remove(token);
            m_nativeOrder.removeAll(token);
        }
    }

private:
    QString currentServiceOwner() const
    {
        if (!m_bus.interface()) return {};
        const QDBusReply<QString> reply =
            m_bus.interface()->serviceOwner(notificationService);
        return reply.isValid() ? reply.value() : QString{};
    }

    void updateServiceOwner(const QString &owner)
    {
        if (m_serviceOwner == owner) return;
        const bool pendingBelongsToPreviousOwner = !m_serviceOwner.isEmpty();
        m_serviceOwner = owner;
        if (pendingBelongsToPreviousOwner) {
            m_revisions.clear();
            m_revisionOrder.clear();
        }
        m_tokenToNative.clear();
        m_nativeToToken.clear();
        m_nativeOrder.clear();
        emit activationNamespaceChanged(owner);
    }

    void trackRevision(const QString &token, quint64 revision)
    {
        m_revisionOrder.removeAll(token);
        m_revisionOrder.append(token);
        m_revisions.insert(token, revision);
        while (m_revisionOrder.size() > maximumNativeNotificationEntries)
            m_revisions.remove(m_revisionOrder.takeFirst());
    }

    bool takeCurrentRevision(const QString &token, quint64 revision)
    {
        if (m_revisions.value(token) != revision) return false;
        m_revisions.remove(token);
        m_revisionOrder.removeAll(token);
        return true;
    }

    void rememberNativeId(const QString &token, uint nativeId)
    {
        const uint previous = m_tokenToNative.value(token, 0);
        if (previous && previous != nativeId
            && m_nativeToToken.value(previous) == token)
            m_nativeToToken.remove(previous);
        const QString previousToken = m_nativeToToken.value(nativeId);
        if (!previousToken.isEmpty() && previousToken != token) {
            m_tokenToNative.remove(previousToken);
            m_nativeOrder.removeAll(previousToken);
        }
        m_nativeOrder.removeAll(token);
        m_nativeOrder.append(token);
        m_tokenToNative.insert(token, nativeId);
        m_nativeToToken.insert(nativeId, token);
        while (m_nativeOrder.size() > maximumNativeNotificationEntries) {
            const QString expiredToken = m_nativeOrder.takeFirst();
            const uint expiredId = m_tokenToNative.take(expiredToken);
            if (expiredId && m_nativeToToken.value(expiredId) == expiredToken)
                m_nativeToToken.remove(expiredId);
        }
    }

    QDBusConnection m_bus;
    QDBusInterface m_notifications;
    QDBusServiceWatcher m_serviceWatcher;
    QString m_serviceOwner;
    QHash<QString, quint64> m_revisions;
    QList<QString> m_revisionOrder;
    QHash<QString, uint> m_tokenToNative;
    QHash<uint, QString> m_nativeToToken;
    QList<QString> m_nativeOrder;
};
}

std::unique_ptr<NotificationPlatform> createNotificationPlatform()
{
    return std::make_unique<LinuxNotificationPlatform>();
}

void initializeNotificationActivation() {}

#include "notifications_linux.moc"
