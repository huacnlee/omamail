#include "application_host.h"

#include "resource_check.h"

#include <QClipboard>
#include <QCoreApplication>
#include <QDesktopServices>
#include <QFile>
#include <QFileInfo>
#include <QGuiApplication>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSet>
#include <QUrl>
#include <QWindow>

ApplicationHost::ApplicationHost(QObject *parent)
    : ApplicationHost(defaultResourcePaths({}, developmentResourcesEnabled()).manifest,
                      defaultResourcePaths({}, developmentResourcesEnabled()).backend, {}, parent)
{
}
ApplicationHost::ApplicationHost(QString manifestPath, QString backendPath,
                                 QString settingsPath, QObject *parent)
    : QObject(parent), m_backendPath(std::move(backendPath)),
      m_store(std::move(settingsPath))
{
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

bool ApplicationHost::showNotification(const QString &, const QString &,
                                       const QString &, const QString &,
                                       const QString &)
{
    return false;
}

void ApplicationHost::hide()
{
    for (QWindow *window : QGuiApplication::topLevelWindows()) window->hide();
    emit hideRequested();
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
        QStringLiteral("XDG_CACHE_HOME"), QStringLiteral("OMAMAIL_BIN")};
    if (!allowed.contains(name)) return {};
    return QString::fromLocal8Bit(qgetenv(name.toLocal8Bit().constData()));
}
