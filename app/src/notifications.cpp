#include "notifications.h"

#include <QCryptographicHash>

QString notificationToken(const QString &id)
{
    return QString::fromLatin1(
        QCryptographicHash::hash(id.toUtf8(), QCryptographicHash::Sha256).toHex());
}

QString normalizeNotificationText(QString text)
{
    text.replace(QStringLiteral("\r\n"), QStringLiteral("\n"));
    text.replace(QChar::CarriageReturn, QChar::LineFeed);
    return text;
}

QString notificationMarkupText(const QString &text)
{
    QString result = normalizeNotificationText(text);
    result.replace(QLatin1Char('&'), QStringLiteral("&amp;"));
    result.replace(QLatin1Char('<'), QStringLiteral("&lt;"));
    result.replace(QLatin1Char('>'), QStringLiteral("&gt;"));
    result.replace(QLatin1Char('"'), QStringLiteral("&quot;"));
    result.replace(QLatin1Char('\''), QStringLiteral("&apos;"));
    return result;
}

NotificationService::NotificationService(
    std::unique_ptr<NotificationPlatform> platform, QObject *parent)
    : QObject(parent),
      m_platform(platform ? std::move(platform) : createNotificationPlatform())
{
    connect(m_platform.get(), &NotificationPlatform::activated, this,
            [this](const QString &token) {
                const auto target = m_targets.constFind(token);
                if (target == m_targets.cend()) return;
                emit activated(target->accountId, target->messageId);
            });
    connect(m_platform.get(), &NotificationPlatform::failed, this,
            [this](const QString &error) { setError(error); });
}

NotificationService::~NotificationService() = default;

bool NotificationService::available() const
{
    return m_platform && m_platform->available();
}

bool NotificationService::show(const QString &id, const QString &title,
                               const QString &body, const QString &accountId,
                               const QString &messageId)
{
    if (!available()) {
        setError(QStringLiteral("Desktop notifications are unavailable"));
        return false;
    }
    if (title.contains(QChar::Null) || body.contains(QChar::Null)) {
        setError(QStringLiteral("Desktop notification text contains NUL"));
        return false;
    }

    const NativeNotification notification{
        notificationToken(id), normalizeNotificationText(title),
        normalizeNotificationText(body)};
    QString error;
    if (!m_platform->show(notification, &error)) {
        setError(error.isEmpty() ? QStringLiteral("Desktop notification failed") : error);
        return false;
    }

    if (!m_targets.contains(notification.token)) {
        m_targetOrder.append(notification.token);
        constexpr qsizetype maximumRetainedTargets = 256;
        while (m_targetOrder.size() > maximumRetainedTargets)
            m_targets.remove(m_targetOrder.takeFirst());
    }
    m_targets.insert(notification.token, Target{accountId, messageId});
    setError({});
    return true;
}

void NotificationService::setError(const QString &error)
{
    if (m_error == error) return;
    m_error = error;
    emit errorChanged();
}
