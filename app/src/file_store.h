#pragma once

#include <QFileSystemWatcher>
#include <QHash>
#include <QObject>
#include <QSet>
#include <QVariantMap>
#include <QtQml/qqmlregistration.h>

class FileStore : public QObject {
    Q_OBJECT
    QML_NAMED_ELEMENT(NativeFileStore)
    QML_SINGLETON

public:
    explicit FileStore(QObject *parent = nullptr);

    Q_INVOKABLE QVariantMap read(const QString &path);
    Q_INVOKABLE bool exists(const QString &path) const;
    Q_INVOKABLE QVariantMap write(const QString &path, const QString &text,
                                  bool atomic = true);
    Q_INVOKABLE void watch(const QString &path, bool enabled);

signals:
    void changed(const QString &path);
    void failed(const QString &path, const QString &error);

private:
    void restoreWatches();

    QFileSystemWatcher m_watcher;
    QSet<QString> m_watchedFiles;
    QHash<QString, bool> m_lastExists;
};
class SettingsStore final {
public:
    explicit SettingsStore(QString path = {});

    QString path() const { return m_path; }
    QVariantMap load(QString *error = nullptr) const;
    bool replace(const QVariantMap &settings, QString *error = nullptr) const;
    static bool accepts(const QVariantMap &settings, QString *error = nullptr);

private:
    QString m_path;
};
