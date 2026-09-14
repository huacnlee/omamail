#include "notifications.h"

#include <QCryptographicHash>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMetaMethod>
#include <QRegularExpression>
#include <QSaveFile>
#include <QStandardPaths>
#include <QTimer>

#ifdef Q_OS_WIN
#include <windows.h>
#include <wincrypt.h>
#else
#include <unistd.h>
#endif

namespace {
constexpr qsizetype maximumRetainedTargets = 256;
constexpr qint64 maximumRoutePlaintextBytes = 1024 * 1024;
constexpr qint64 maximumRouteFileBytes = 2 * maximumRoutePlaintextBytes;

bool validRouteValue(const QString &value)
{
    if (value.isEmpty() || value.size() > 4096) return false;
    for (const QChar character : value) {
        const ushort code = character.unicode();
        if (code == 0 || code == 0x7f || (code < 0x20 && code != 0x09))
            return false;
    }
    return true;
}

bool validToken(const QString &token)
{
    static const QRegularExpression expression(QStringLiteral("^[0-9a-f]{64}$"));
    return expression.match(token).hasMatch();
}

bool ensurePrivateDirectory(const QString &path, QString *error)
{
    const QFileInfo before(path);
    if (before.exists() && (before.isSymLink() || !before.isDir())) {
        if (error) *error = QStringLiteral("Notification route directory is unsafe");
        return false;
    }
    if (!QDir().mkpath(path)) {
        if (error) *error = QStringLiteral("Could not create notification route directory");
        return false;
    }
#ifndef Q_OS_WIN
    QFile directory(path);
    if (!directory.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner
                                  | QFileDevice::ExeOwner)) {
        if (error) *error = QStringLiteral("Could not protect notification route directory");
        return false;
    }
    const QFileInfo info(path);
    const auto unsafePermissions = QFileDevice::ReadGroup | QFileDevice::WriteGroup
        | QFileDevice::ExeGroup | QFileDevice::ReadOther | QFileDevice::WriteOther
        | QFileDevice::ExeOther;
    if (info.ownerId() != static_cast<uint>(geteuid())
        || (info.permissions() & unsafePermissions)) {
        if (error) *error = QStringLiteral("Notification route directory is not private");
        return false;
    }
#endif
    return true;
}

bool validateRouteFile(const QString &path, QString *error)
{
    const QFileInfo info(path);
    if (!info.exists()) return true;
    if (info.isSymLink() || !info.isFile()) {
        if (error) *error = QStringLiteral("Notification route file is unsafe");
        return false;
    }
#ifndef Q_OS_WIN
    const auto unsafePermissions = QFileDevice::ReadGroup | QFileDevice::WriteGroup
        | QFileDevice::ExeGroup | QFileDevice::ReadOther | QFileDevice::WriteOther
        | QFileDevice::ExeOther;
    if (info.ownerId() != static_cast<uint>(geteuid())
        || (info.permissions() & unsafePermissions)) {
        if (error) *error = QStringLiteral("Notification route file is not private");
        return false;
    }
#endif
    return true;
}

#ifdef Q_OS_WIN
QByteArray protectRouteBytes(const QByteArray &plain, QString *error)
{
    DATA_BLOB input{static_cast<DWORD>(plain.size()),
                    reinterpret_cast<BYTE *>(const_cast<char *>(plain.data()))};
    DATA_BLOB output{};
    if (!CryptProtectData(&input, L"Omamail notification routes", nullptr, nullptr,
                          nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output)) {
        if (error)
            *error = QStringLiteral("Could not protect notification routes: %1")
                .arg(static_cast<qulonglong>(GetLastError()));
        return {};
    }
    const QByteArray protectedBytes(reinterpret_cast<const char *>(output.pbData),
                                    static_cast<qsizetype>(output.cbData));
    LocalFree(output.pbData);
    return protectedBytes;
}

QByteArray unprotectRouteBytes(const QByteArray &protectedBytes, QString *error)
{
    DATA_BLOB input{static_cast<DWORD>(protectedBytes.size()),
                    reinterpret_cast<BYTE *>(
                        const_cast<char *>(protectedBytes.data()))};
    DATA_BLOB output{};
    if (!CryptUnprotectData(&input, nullptr, nullptr, nullptr, nullptr,
                            CRYPTPROTECT_UI_FORBIDDEN, &output)) {
        if (error)
            *error = QStringLiteral("Could not read protected notification routes: %1")
                .arg(static_cast<qulonglong>(GetLastError()));
        return {};
    }
    const QByteArray plain(reinterpret_cast<const char *>(output.pbData),
                           static_cast<qsizetype>(output.cbData));
    LocalFree(output.pbData);
    return plain;
}
#else
QByteArray protectRouteBytes(const QByteArray &plain, QString *) { return plain; }
QByteArray unprotectRouteBytes(const QByteArray &plain, QString *) { return plain; }
#endif
}

QStringList NotificationPlatform::takePendingActivations()
{
    const QStringList pending = m_pendingActivations;
    m_pendingActivations.clear();
    return pending;
}

void NotificationPlatform::deliverActivation(const QString &token)
{
    if (isSignalConnected(QMetaMethod::fromSignal(&NotificationPlatform::activated)))
        emit activated(token);
    else
        m_pendingActivations.append(token);
}

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
    std::unique_ptr<NotificationPlatform> platform, QString routingPath,
    QObject *parent)
    : QObject(parent),
      m_platform(platform ? std::move(platform) : createNotificationPlatform()),
      m_routingPath(std::move(routingPath))
{
    if (m_routingPath.isEmpty()) {
        m_routingPath = QDir(QStandardPaths::writableLocation(
            QStandardPaths::AppDataLocation)).filePath(
                QStringLiteral("notification-routes.json"));
    }
    QString routeError;
    if (!loadRoutes(&routeError)) setError(routeError);
    connect(m_platform.get(), &NotificationPlatform::activated, this,
            &NotificationService::routeActivation);
    connect(m_platform.get(), &NotificationPlatform::activationAliasAssigned, this,
            [this](const QString &token, const QString &alias) {
                if (!validToken(token) || !validToken(alias)) return;
                const auto target = m_targets.constFind(token);
                if (target == m_targets.cend()) return;
                const Target targetValue = *target;
                if (!m_targets.contains(alias)) m_targetOrder.append(alias);
                m_targets.insert(alias, targetValue);
                while (m_targetOrder.size() > maximumRetainedTargets)
                    m_targets.remove(m_targetOrder.takeFirst());
                QString error;
                if (!saveRoutes(&error)) setError(error);
            });
    connect(m_platform.get(), &NotificationPlatform::delivered, this,
            [this](const QString &) { setError({}); });
    connect(m_platform.get(), &NotificationPlatform::failed, this,
            [this](const QString &error) { setError(error); });
    const QStringList pending = m_platform->takePendingActivations();
    if (!pending.isEmpty()) {
        QTimer::singleShot(0, this, [this, pending] {
            for (const QString &token : pending) routeActivation(token);
        });
    }
}

NotificationService::~NotificationService() = default;

void NotificationService::routeActivation(const QString &token)
{
    const auto target = m_targets.constFind(token);
    if (target == m_targets.cend()) return;
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    if (token == m_lastActivatedToken && now - m_lastActivationTime < 5000) return;
    m_lastActivatedToken = token;
    m_lastActivationTime = now;
    emit activated(target->accountId, target->messageId);
}

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
    if (!validRouteValue(id) || !validRouteValue(accountId)
        || !validRouteValue(messageId)) {
        setError(QStringLiteral("Desktop notification route is invalid"));
        return false;
    }

    const NativeNotification notification{
        notificationToken(id), normalizeNotificationText(title),
        normalizeNotificationText(body)};
    const auto oldTargets = m_targets;
    const auto oldOrder = m_targetOrder;
    if (!m_targets.contains(notification.token)) {
        m_targetOrder.append(notification.token);
        while (m_targetOrder.size() > maximumRetainedTargets)
            m_targets.remove(m_targetOrder.takeFirst());
    }
    m_targets.insert(notification.token, Target{accountId, messageId});

    QString error;
    if (!saveRoutes(&error)) {
        m_targets = oldTargets;
        m_targetOrder = oldOrder;
        setError(error);
        return false;
    }
    if (!m_platform->show(notification, &error)) {
        m_targets = oldTargets;
        m_targetOrder = oldOrder;
        QString rollbackError;
        if (!saveRoutes(&rollbackError) && error.isEmpty()) error = rollbackError;
        setError(error.isEmpty() ? QStringLiteral("Desktop notification failed") : error);
        return false;
    }
    return true;
}

bool NotificationService::loadRoutes(QString *error)
{
    m_targets.clear();
    m_targetOrder.clear();
    if (!ensurePrivateDirectory(QFileInfo(m_routingPath).absolutePath(), error)
        || !validateRouteFile(m_routingPath, error)) return false;
    QFile file(m_routingPath);
    if (!file.exists()) return true;
    if (!file.open(QIODevice::ReadOnly) || file.size() > maximumRouteFileBytes) {
        if (error) *error = QStringLiteral("Could not read notification routes");
        return false;
    }
    const QByteArray plain = unprotectRouteBytes(file.readAll(), error);
    if (plain.isEmpty() && file.size() > 0) return false;
    if (plain.size() > maximumRoutePlaintextBytes) {
        if (error) *error = QStringLiteral("Notification routes are too large");
        return false;
    }
    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(plain, &parseError);
    if (parseError.error != QJsonParseError::NoError || !document.isObject()
        || document.object().value(QStringLiteral("version")).toInt() != 1
        || !document.object().value(QStringLiteral("routes")).isArray()) {
        if (error) *error = QStringLiteral("Notification routes are invalid");
        return false;
    }
    const QJsonArray routes = document.object().value(QStringLiteral("routes")).toArray();
    for (const QJsonValue &value : routes) {
        const QJsonObject route = value.toObject();
        const QString token = route.value(QStringLiteral("token")).toString();
        const QString accountId = route.value(QStringLiteral("accountId")).toString();
        const QString messageId = route.value(QStringLiteral("messageId")).toString();
        if (!validToken(token) || !validRouteValue(accountId)
            || !validRouteValue(messageId)) {
            if (error) *error = QStringLiteral("Notification route entry is invalid");
            m_targets.clear();
            m_targetOrder.clear();
            return false;
        }
        if (!m_targets.contains(token)) m_targetOrder.append(token);
        m_targets.insert(token, Target{accountId, messageId});
        while (m_targetOrder.size() > maximumRetainedTargets)
            m_targets.remove(m_targetOrder.takeFirst());
    }
    if (error) error->clear();
    return true;
}

bool NotificationService::saveRoutes(QString *error) const
{
    const QFileInfo routeInfo(m_routingPath);
    if (!ensurePrivateDirectory(routeInfo.absolutePath(), error)
        || !validateRouteFile(m_routingPath, error)) return false;
    QJsonArray routes;
    for (const QString &token : m_targetOrder) {
        const auto target = m_targets.constFind(token);
        if (target == m_targets.cend()) continue;
        routes.append(QJsonObject{{QStringLiteral("token"), token},
                                  {QStringLiteral("accountId"), target->accountId},
                                  {QStringLiteral("messageId"), target->messageId}});
    }
    const QByteArray plain = QJsonDocument(QJsonObject{
        {QStringLiteral("version"), 1}, {QStringLiteral("routes"), routes}})
        .toJson(QJsonDocument::Compact);
    if (plain.size() > maximumRoutePlaintextBytes) {
        if (error) *error = QStringLiteral("Notification routes are too large");
        return false;
    }
    const QByteArray bytes = protectRouteBytes(plain, error);
    if (bytes.isEmpty()) return false;
    QSaveFile file(m_routingPath);
    if (!file.open(QIODevice::WriteOnly)) {
        if (error) *error = file.errorString();
        return false;
    }
    file.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner);
    if (file.write(bytes) != bytes.size() || !file.commit()
        || !validateRouteFile(m_routingPath, error)) {
        if (error && error->isEmpty()) *error = file.errorString();
        return false;
    }
    if (error) error->clear();
    return true;
}

void NotificationService::setError(const QString &error)
{
    if (m_error == error) return;
    m_error = error;
    emit errorChanged();
}
