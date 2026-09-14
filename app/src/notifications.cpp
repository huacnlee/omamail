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

bool validActivationNamespace(const QString &activationNamespace)
{
    static const QRegularExpression expression(
        QStringLiteral("^[0-9a-f]{32}/:[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)+$"));
    return activationNamespace.size() <= 288
        && expression.match(activationNamespace).hasMatch();
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
    while (m_pendingActivations.size() > maximumNativeNotificationEntries)
        m_pendingActivations.removeFirst();
}

QString notificationToken(const QString &id)
{
    return QString::fromLatin1(
        QCryptographicHash::hash(id.toUtf8(), QCryptographicHash::Sha256).toHex());
}

QString notificationPlatformAlias(const QString &activationNamespace,
                                  quint64 nativeId)
{
    return notificationToken(QStringLiteral("notification-platform:")
                             + activationNamespace + QLatin1Char(':')
                             + QString::number(nativeId));
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
            [this](const QString &token, quint64 revision, const QString &alias,
                   const QString &activationNamespace) {
                if (!validToken(token) || !validToken(alias)) return;
                if (m_revisions.value(token) != revision
                    || !validActivationNamespace(activationNamespace)
                    || activationNamespace != m_platform->activationNamespace()) return;
                const auto target = m_targets.constFind(token);
                if (target == m_targets.cend()) return;
                const Target targetValue = *target;
                const auto oldTargets = m_targets;
                const auto oldOrder = m_targetOrder;
                m_targets.insert(alias, Target{targetValue.accountId,
                    targetValue.messageId, targetValue.rootToken,
                    activationNamespace});
                touchTarget(alias);
                QString error;
                if (!saveRoutes(&error)) {
                    m_targets = oldTargets;
                    m_targetOrder = oldOrder;
                    setDeliveryError(token, revision, error);
                }
            });
    connect(m_platform.get(), &NotificationPlatform::activationNamespaceChanged,
            this, &NotificationService::invalidateActivationNamespace);
    connect(m_platform.get(), &NotificationPlatform::delivered, this,
            &NotificationService::deliverySucceeded);
    connect(m_platform.get(), &NotificationPlatform::failed, this,
            &NotificationService::deliveryFailed);
    invalidateActivationNamespace(m_platform->activationNamespace());
    const QStringList pending = m_platform->takePendingActivations();
    if (!pending.isEmpty()) {
        QTimer::singleShot(0, this, [this, pending] {
            for (const QString &token : pending) routeActivation(token);
        });
    }
}

NotificationService::~NotificationService() = default;

void NotificationService::touchTarget(const QString &token)
{
    m_targetOrder.removeAll(token);
    m_targetOrder.append(token);
    while (m_targetOrder.size() > maximumRetainedTargets)
        m_targets.remove(m_targetOrder.takeFirst());
}

void NotificationService::touchRevision(const QString &token, quint64 revision)
{
    m_revisionOrder.removeAll(token);
    m_revisionOrder.append(token);
    m_revisions.insert(token, revision);
    while (m_revisionOrder.size() > maximumRetainedTargets)
        m_revisions.remove(m_revisionOrder.takeFirst());
}

void NotificationService::removeRouteFamily(const QString &rootToken)
{
    for (auto iterator = m_targets.begin(); iterator != m_targets.end();) {
        if (iterator->rootToken == rootToken) {
            m_targetOrder.removeAll(iterator.key());
            iterator = m_targets.erase(iterator);
        } else {
            ++iterator;
        }
    }
}

void NotificationService::setDeliveryError(const QString &token, quint64 revision,
                                           const QString &error)
{
    if (revision < m_errorRevision) return;
    m_errorToken = token;
    m_errorRevision = revision;
    setError(error);
}

void NotificationService::deliverySucceeded(const QString &token, quint64 revision)
{
    if (m_revisions.value(token) != revision || revision < m_errorRevision) return;
    m_errorToken.clear();
    m_errorRevision = revision;
    setError({});
}

void NotificationService::deliveryFailed(const QString &token, quint64 revision,
                                         const QString &error)
{
    if (m_revisions.value(token) != revision) return;
    removeRouteFamily(token);
    m_revisions.remove(token);
    m_revisionOrder.removeAll(token);
    QString persistenceError;
    if (!persistRouteRemoval(&persistenceError)) {
        setDeliveryError(token, revision,
            QStringLiteral("%1; notification route cleanup failed: %2")
                .arg(error, persistenceError));
        return;
    }
    setDeliveryError(token, revision,
        error.isEmpty() ? QStringLiteral("Desktop notification failed") : error);
}

void NotificationService::invalidateActivationNamespace(
    const QString &activationNamespace)
{
    bool changed = false;
    for (auto iterator = m_targets.begin(); iterator != m_targets.end();) {
        if (!iterator->activationNamespace.isEmpty()
            && iterator->activationNamespace != activationNamespace) {
            m_targetOrder.removeAll(iterator.key());
            iterator = m_targets.erase(iterator);
            changed = true;
        } else {
            ++iterator;
        }
    }
    if (!changed) return;
    QString error;
    if (!persistRouteRemoval(&error)) setError(error);
}

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
    const quint64 revision = ++m_nextRevision;
    const QString token = notificationToken(id);
    if (!available()) {
        setDeliveryError(token, revision,
                         QStringLiteral("Desktop notifications are unavailable"));
        return false;
    }
    if (title.contains(QChar::Null) || body.contains(QChar::Null)) {
        setDeliveryError(token, revision,
                         QStringLiteral("Desktop notification text contains NUL"));
        return false;
    }
    if (!validRouteValue(id) || !validRouteValue(accountId)
        || !validRouteValue(messageId)) {
        setDeliveryError(token, revision,
                         QStringLiteral("Desktop notification route is invalid"));
        return false;
    }

    const NativeNotification notification{
        token, revision, normalizeNotificationText(title),
        normalizeNotificationText(body)};
    const auto oldTargets = m_targets;
    const auto oldOrder = m_targetOrder;
    const auto oldRevisions = m_revisions;
    const auto oldRevisionOrder = m_revisionOrder;
    m_targets.insert(notification.token,
                     Target{accountId, messageId, notification.token, {}});
    touchTarget(notification.token);
    touchRevision(notification.token, revision);

    QString error;
    if (!saveRoutes(&error)) {
        m_targets = oldTargets;
        m_targetOrder = oldOrder;
        m_revisions = oldRevisions;
        m_revisionOrder = oldRevisionOrder;
        setDeliveryError(token, revision, error);
        return false;
    }
    if (!m_platform->show(notification, &error)) {
        m_targets = oldTargets;
        m_targetOrder = oldOrder;
        m_revisions = oldRevisions;
        m_revisionOrder = oldRevisionOrder;
        QString rollbackError;
        if (!saveRoutes(&rollbackError) && error.isEmpty()) error = rollbackError;
        setDeliveryError(token, revision,
            error.isEmpty() ? QStringLiteral("Desktop notification failed") : error);
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
        || document.object().value(QStringLiteral("version")).toInt() != 2
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
        const QString rootToken = route.value(QStringLiteral("rootToken")).toString();
        const QString activationNamespace =
            route.value(QStringLiteral("activationNamespace")).toString();
        if (!validToken(rootToken)
            || (!activationNamespace.isEmpty()
                && !validActivationNamespace(activationNamespace))) {
            if (error) *error = QStringLiteral("Notification route entry is invalid");
            m_targets.clear();
            m_targetOrder.clear();
            return false;
        }
        m_targets.insert(token, Target{accountId, messageId, rootToken,
                                      activationNamespace});
        touchTarget(token);
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
                                  {QStringLiteral("messageId"), target->messageId},
                                  {QStringLiteral("rootToken"), target->rootToken},
                                  {QStringLiteral("activationNamespace"),
                                   target->activationNamespace}});
    }
    const QByteArray plain = QJsonDocument(QJsonObject{
        {QStringLiteral("version"), 2}, {QStringLiteral("routes"), routes}})
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

bool NotificationService::persistRouteRemoval(QString *error) const
{
    QString saveError;
    if (saveRoutes(&saveError)) {
        if (error) error->clear();
        return true;
    }
    const QFileInfo routeInfo(m_routingPath);
    if ((!routeInfo.exists() && !routeInfo.isSymLink())
        || QFile::remove(m_routingPath)) {
        if (error) error->clear();
        return true;
    }
    if (error) {
        *error = QStringLiteral("%1; could not remove notification route file")
                     .arg(saveError);
    }
    return false;
}

void NotificationService::setError(const QString &error)
{
    if (m_error == error) return;
    m_error = error;
    emit errorChanged();
}
