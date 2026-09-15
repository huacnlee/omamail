#include "file_store.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSaveFile>
#include <QStandardPaths>

namespace {
constexpr qint64 maximumTextFileBytes = 16 * 1024 * 1024;

QVariantMap result(bool ok, const QString &text = {}, const QString &error = {})
{
    return {{QStringLiteral("ok"), ok}, {QStringLiteral("text"), text},
            {QStringLiteral("error"), error}};
}

const QSet<QString> &allowedSettings()
{
    static const QSet<QString> keys{
        QStringLiteral("refreshIntervalSec"), QStringLiteral("maxMessages"),
        QStringLiteral("heavyMessageRendering"), QStringLiteral("contentDirection"),
        QStringLiteral("defaultQuery"), QStringLiteral("notifyNewMail"),
        QStringLiteral("oauthPort"), QStringLiteral("undoSendSeconds"),
        QStringLiteral("unifiedCalendarView"), QStringLiteral("openOnClick"),
        QStringLiteral("showBarIcon"), QStringLiteral("suggestEvents"),
        QStringLiteral("unifiedMailboxes")};
    return keys;
}

bool parseSettingsFile(const QString &path, QVariantMap *settings, QString *error)
{
    QFile file(path);
    if (!file.exists()) {
        settings->clear();
        if (error) error->clear();
        return true;
    }
    if (!file.open(QIODevice::ReadOnly)) {
        if (error) *error = file.errorString();
        return false;
    }
    if (file.size() > maximumTextFileBytes) {
        if (error) *error = QStringLiteral("Settings file is too large");
        return false;
    }
    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(file.readAll(), &parseError);
    if (parseError.error != QJsonParseError::NoError || !document.isObject()) {
        if (error) *error = QStringLiteral("Invalid settings JSON: %1").arg(parseError.errorString());
        return false;
    }
    *settings = document.object().toVariantMap();
    return SettingsStore::accepts(*settings, error);
}
}

FileStore::FileStore(QObject *parent)
    : QObject(parent)
{
    connect(&m_watcher, &QFileSystemWatcher::fileChanged, this,
            [this](const QString &path) {
        emit changed(path);
        restoreWatches();
    });
    connect(&m_watcher, &QFileSystemWatcher::directoryChanged, this,
            [this](const QString &directory) {
        for (const QString &path : std::as_const(m_watchedFiles)) {
            const QFileInfo info(path);
            if (info.absolutePath() != directory && info.absoluteFilePath() != directory)
                continue;
            const bool exists = QFileInfo::exists(path);
            // A watched directory may be a symlink such as Omarchy's
            // `current` theme entry. Its existence can stay true while its
            // target is atomically replaced, so any relevant directory event
            // invalidates the watched path.
            emit changed(path);
            m_lastExists.insert(path, exists);
        }
        restoreWatches();
    });
}

QVariantMap FileStore::read(const QString &path)
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) {
        const QString error = file.errorString();
        emit failed(path, error);
        return result(false, {}, error);
    }
    if (file.size() > maximumTextFileBytes) {
        const QString error = QStringLiteral("File is too large");
        emit failed(path, error);
        return result(false, {}, error);
    }
    return result(true, QString::fromUtf8(file.readAll()));
}

bool FileStore::exists(const QString &path) const
{
    return QFileInfo::exists(path);
}

QVariantMap FileStore::write(const QString &path, const QString &text, bool atomic)
{
    if (path.isEmpty()) {
        const QString error = QStringLiteral("Path is empty");
        emit failed(path, error);
        return result(false, {}, error);
    }
    if (!QDir().mkpath(QFileInfo(path).absolutePath())) {
        const QString error = QStringLiteral("Could not create the parent directory");
        emit failed(path, error);
        return result(false, {}, error);
    }
    const QByteArray bytes = text.toUtf8();
    QString error;
    bool ok = false;
    if (atomic) {
        QSaveFile file(path);
        ok = file.open(QIODevice::WriteOnly);
        if (ok) file.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner);
        ok = ok && file.write(bytes) == bytes.size() && file.commit();
        if (!ok) error = file.errorString();
    } else {
        QFile file(path);
        ok = file.open(QIODevice::WriteOnly | QIODevice::Truncate);
        if (ok) file.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner);
        ok = ok && file.write(bytes) == bytes.size() && file.flush();
        if (!ok) error = file.errorString();
    }
    if (!ok) {
        emit failed(path, error);
        return result(false, {}, error);
    }
    if (m_watchedFiles.contains(QFileInfo(path).absoluteFilePath()))
        emit changed(QFileInfo(path).absoluteFilePath());
    restoreWatches();
    return result(true);
}

void FileStore::watch(const QString &path, bool enabled)
{
    const QString absolute = QFileInfo(path).absoluteFilePath();
    if (enabled) {
        m_watchedFiles.insert(absolute);
        m_lastExists.insert(absolute, QFileInfo::exists(absolute));
    } else {
        m_watchedFiles.remove(absolute);
        m_lastExists.remove(absolute);
    }
    restoreWatches();
}

// Only the difference is applied. Re-adding a directory that is already
// watched makes Qt's FSEvents engine list it afresh, and it lists without
// hidden entries then checks with them, so a directory holding a dotfile
// (the backend's lock files) reported itself changed after every re-arm.
// With every directory event re-arming the watches, that never ended.
void FileStore::restoreWatches()
{
    QSet<QString> wanted;
    for (const QString &file : std::as_const(m_watchedFiles)) {
        const bool exists = QFileInfo::exists(file);
        m_lastExists.insert(file, exists);
        if (exists) wanted.insert(file);
        wanted.insert(QFileInfo(file).absolutePath());
    }
    const QSet<QString> current = QSet<QString>(m_watcher.files().cbegin(), m_watcher.files().cend())
        | QSet<QString>(m_watcher.directories().cbegin(), m_watcher.directories().cend());
    const QStringList stale = (current - wanted).values();
    if (!stale.isEmpty()) m_watcher.removePaths(stale);
    const QStringList missing = (wanted - current).values();
    if (!missing.isEmpty()) m_watcher.addPaths(missing);
}

SettingsStore::SettingsStore(QString path)
    : m_path(std::move(path))
{
    if (m_path.isEmpty()) {
        m_path = QDir(QStandardPaths::writableLocation(QStandardPaths::AppDataLocation))
            .filePath(QStringLiteral("settings.json"));
    }
}

QVariantMap SettingsStore::load(QString *error) const
{
    QVariantMap settings;
    if (!parseSettingsFile(m_path, &settings, error)) return {};
    return settings;
}

bool SettingsStore::accepts(const QVariantMap &settings, QString *error)
{
    for (auto it = settings.cbegin(); it != settings.cend(); ++it) {
        if (!allowedSettings().contains(it.key())) {
            if (error) *error = QStringLiteral("Setting is not allowed: %1").arg(it.key());
            return false;
        }
    }
    if (error) error->clear();
    return true;
}

bool SettingsStore::replace(const QVariantMap &settings, QString *error) const
{
    if (!accepts(settings, error)) return false;
    QVariantMap existing;
    if (!parseSettingsFile(m_path, &existing, error)) return false;
    if (!QDir().mkpath(QFileInfo(m_path).absolutePath())) {
        if (error) *error = QStringLiteral("Could not create settings directory");
        return false;
    }
    QSaveFile file(m_path);
    if (!file.open(QIODevice::WriteOnly)) {
        if (error) *error = file.errorString();
        return false;
    }
    file.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner);
    const QByteArray bytes = QJsonDocument(QJsonObject::fromVariantMap(settings))
        .toJson(QJsonDocument::Indented);
    if (file.write(bytes) != bytes.size() || !file.commit()) {
        if (error) *error = file.errorString();
        return false;
    }
    if (error) error->clear();
    return true;
}
