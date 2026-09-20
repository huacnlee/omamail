#include "application_host.h"

#include "resource_check.h"

#include <QClipboard>
#include <QCoreApplication>
#include <QDesktopServices>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QGuiApplication>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSet>
#include <QStandardPaths>
#include <QUrl>
#include <QWindow>

ApplicationHost::ApplicationHost(QObject *parent)
    : ApplicationHost(defaultResourcePaths({}, developmentResourcesEnabled()).manifest,
                      defaultResourcePaths({}, developmentResourcesEnabled()).backend, {}, parent)
{
}
ApplicationHost::ApplicationHost(QString manifestPath, QString backendPath,
                                 QString settingsPath, QObject *parent)
    : ApplicationHost(std::move(manifestPath), std::move(backendPath),
                      std::move(settingsPath), {}, parent)
{
}

ApplicationHost::ApplicationHost(
    QString manifestPath, QString backendPath, QString settingsPath,
    std::unique_ptr<NotificationPlatform> notificationPlatform, QObject *parent)
    : QObject(parent), m_backendPath(std::move(backendPath)),
      m_store(std::move(settingsPath)),
      m_notifications(std::make_unique<NotificationService>(
          std::move(notificationPlatform),
          QFileInfo(m_store.path()).dir().filePath(
              QStringLiteral("notification-routes.json"))))
{
    m_capabilities = {
        {QStringLiteral("agent"), false},
        {QStringLiteral("systemTray"), false},
        {QStringLiteral("notifications"), m_notifications->available()},
        // The Dock keeps a running application reachable after its window is
        // shut; elsewhere a windowless process has no such door.
#ifdef Q_OS_MACOS
        {QStringLiteral("reopen"), true}};
#else
        {QStringLiteral("reopen"), false}};
#endif
    connect(m_notifications.get(), &NotificationService::errorChanged, this,
            &ApplicationHost::notificationErrorChanged);
    connect(m_notifications.get(), &NotificationService::activated, this,
            &ApplicationHost::activateFromNotification);
    // A window shut with the close chord leaves the process running for its
    // notifications. Activating the application again with nothing on screen
    // is the desktop's way of asking for the window back; on macOS Qt reports
    // a Dock click as exactly that, even when the process was already active.
    if (auto *application = qobject_cast<QGuiApplication *>(QCoreApplication::instance()))
        connect(application, &QGuiApplication::applicationStateChanged, this,
                &ApplicationHost::handleApplicationStateChanged);
    loadManifest(manifestPath);
    QVariantMap defaults = m_manifest.value(QStringLiteral("barWidget")).toMap()
                               .value(QStringLiteral("defaults")).toMap();
    defaults.insert(QStringLiteral("unifiedMailboxes"), false);
    QString error;
    const QVariantMap saved = m_store.load(&error);
    for (auto it = saved.cbegin(); it != saved.cend(); ++it)
        defaults.insert(it.key(), it.value());
    m_settings = defaults;
}

void ApplicationHost::loadManifest(const QString &path)
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) return;
    const QJsonDocument document = QJsonDocument::fromJson(file.readAll());
    if (document.isObject()) m_manifest = document.object().toVariantMap();
}

bool ApplicationHost::openExternal(const QString &urlOrPath)
{
    if (urlOrPath.contains(QChar::Null) || urlOrPath.contains('\n')
        || urlOrPath.contains('\r')) return false;
    QUrl url(urlOrPath);
    if (url.isRelative() || url.scheme().isEmpty())
        url = QUrl::fromLocalFile(QFileInfo(urlOrPath).absoluteFilePath());
    static const QSet<QString> allowed{QStringLiteral("http"), QStringLiteral("https"),
                                       QStringLiteral("mailto"), QStringLiteral("file")};
    if (!url.isValid() || !allowed.contains(url.scheme().toLower())) return false;
    return QDesktopServices::openUrl(url);
}

bool ApplicationHost::setClipboard(const QString &text)
{
    if (!QGuiApplication::instance() || !QGuiApplication::clipboard()) return false;
    QGuiApplication::clipboard()->setText(text);
    return true;
}

QString ApplicationHost::notificationError() const
{
    return m_notifications ? m_notifications->error() : QString{};
}

bool ApplicationHost::showNotification(const QString &id, const QString &title,
                                       const QString &body, const QString &accountId,
                                       const QString &messageId)
{
    return m_notifications
        && m_notifications->show(id, title, body, accountId, messageId);
}

void ApplicationHost::activateFromNotification(const QString &accountId,
                                               const QString &messageId)
{
    m_pendingNotificationActivation = {
        {QStringLiteral("accountId"), accountId},
        {QStringLiteral("messageId"), messageId}};
    emit pendingNotificationActivationChanged();
    for (QWindow *window : QGuiApplication::topLevelWindows()) {
        window->show();
        window->raise();
        window->requestActivate();
    }
    emit notificationActivated(accountId, messageId);
}

QVariantMap ApplicationHost::takePendingNotificationActivation()
{
    const QVariantMap pending = m_pendingNotificationActivation;
    if (!pending.isEmpty()) {
        m_pendingNotificationActivation.clear();
        emit pendingNotificationActivationChanged();
    }
    return pending;
}

void ApplicationHost::handleApplicationStateChanged(Qt::ApplicationState state)
{
    if (state != Qt::ApplicationActive) return;
    for (QWindow *window : QGuiApplication::topLevelWindows())
        if (window->isVisible()) return;
    emit reopenRequested();
}

void ApplicationHost::hide()
{
    for (QWindow *window : QGuiApplication::topLevelWindows()) window->hide();
    emit hideRequested();
}

void ApplicationHost::requestClose()
{
    emit closeRequested();
}

void ApplicationHost::quit()
{
    QCoreApplication::quit();
}

bool ApplicationHost::updateSettings(const QVariantMap &settings)
{
    QString error;
    if (!m_store.replace(settings, &error)) return false;
    if (m_settings == settings) return true;
    m_settings = settings;
    emit settingsChanged();
    return true;
}

QString ApplicationHost::environment(const QString &name) const
{
    static const QSet<QString> allowed{
        QStringLiteral("HOME"), QStringLiteral("XDG_CONFIG_HOME"),
        QStringLiteral("XDG_CACHE_HOME"), QStringLiteral("OMAMAIL_BIN"),
        QStringLiteral("OMAMAIL_SMOKE_TEST")};
    if (!allowed.contains(name)) return {};
    return QString::fromLocal8Bit(qgetenv(name.toLocal8Bit().constData()));
}

namespace {
bool safeRelativePath(const QString &name)
{
    if (name.isEmpty() || name.contains(QChar::Null) || name.contains('\\')) return false;
    const QStringList parts = name.split('/');
    for (const QString &part : parts) {
        if (part.isEmpty() || part == QStringLiteral(".") || part == QStringLiteral(".."))
            return false;
        for (const QChar character : part) {
            if (!character.isLetterOrNumber() && character != '.' && character != '-'
                && character != '_') return false;
        }
    }
    return true;
}

QString backendStorageRoot(bool cache)
{
#ifdef Q_OS_WIN
    QString root = QString::fromLocal8Bit(qgetenv(cache ? "LOCALAPPDATA" : "APPDATA"));
    if (root.isEmpty()) root = QStandardPaths::writableLocation(
        cache ? QStandardPaths::CacheLocation : QStandardPaths::AppConfigLocation);
    if (cache) root = QDir(root).filePath(QStringLiteral("OmamailData/Cache"));
#elif defined(Q_OS_MACOS)
    const QString home = QDir::homePath();
    QString root = QDir(home).filePath(cache ? QStringLiteral("Library/Caches")
                                             : QStringLiteral("Library/Application Support"));
#else
    QString root = QString::fromLocal8Bit(qgetenv(
        cache ? "XDG_CACHE_HOME" : "XDG_CONFIG_HOME"));
    if (root.isEmpty()) root = QDir::home().filePath(
        cache ? QStringLiteral(".cache") : QStringLiteral(".config"));
#endif
    if (!QDir::isAbsolutePath(root)
        || QDir::fromNativeSeparators(root).split('/').contains(QStringLiteral(".."))) return {};
    return QDir(QDir::cleanPath(root)).filePath(QStringLiteral("omamail"));
}

QString applicationPath(bool cache, const QString &name)
{
    if (!safeRelativePath(name)) return {};
    const QString root = backendStorageRoot(cache);
    return root.isEmpty() ? QString() : QDir(root).filePath(name);
}
}

QString ApplicationHost::configPath(const QString &name) const
{
    return applicationPath(false, name);
}

QString ApplicationHost::cachePath(const QString &name) const
{
    return applicationPath(true, name);
}

QString ApplicationHost::localFilePath(const QUrl &url) const
{
    return url.isLocalFile() ? url.toLocalFile() : QString();
}
