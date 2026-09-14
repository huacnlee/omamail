#pragma once

#include "file_store.h"
#include "notifications.h"

#include <QObject>
#include <QUrl>
#include <QVariantMap>
#include <QtQml/qqmlregistration.h>

#include <memory>

class ApplicationHost : public QObject {
    Q_OBJECT
    QML_NAMED_ELEMENT(NativeHost)
    QML_SINGLETON

    Q_PROPERTY(QVariantMap manifest READ manifest CONSTANT)
    Q_PROPERTY(QVariantMap capabilities READ capabilities CONSTANT)
    Q_PROPERTY(QVariantMap settings READ settings NOTIFY settingsChanged)
    Q_PROPERTY(QString backendPath READ backendPath CONSTANT)
    Q_PROPERTY(QString notificationError READ notificationError
               NOTIFY notificationErrorChanged)
    Q_PROPERTY(QVariantMap pendingNotificationActivation
               READ pendingNotificationActivation
               NOTIFY pendingNotificationActivationChanged)

public:
    explicit ApplicationHost(QObject *parent = nullptr);
    ApplicationHost(QString manifestPath, QString backendPath,
                    QString settingsPath, QObject *parent = nullptr);
    ApplicationHost(QString manifestPath, QString backendPath,
                    QString settingsPath,
                    std::unique_ptr<NotificationPlatform> notificationPlatform,
                    QObject *parent = nullptr);

    QVariantMap manifest() const { return m_manifest; }
    QVariantMap capabilities() const { return m_capabilities; }
    QVariantMap settings() const { return m_settings; }
    QString backendPath() const { return m_backendPath; }
    QString notificationError() const;
    QVariantMap pendingNotificationActivation() const
    {
        return m_pendingNotificationActivation;
    }

    Q_INVOKABLE bool openExternal(const QString &urlOrPath);
    Q_INVOKABLE bool setClipboard(const QString &text);
    Q_INVOKABLE bool showNotification(const QString &id, const QString &title,
                                      const QString &body, const QString &accountId,
                                      const QString &messageId);
    Q_INVOKABLE QVariantMap takePendingNotificationActivation();
    Q_INVOKABLE void hide();
    Q_INVOKABLE void quit();
    Q_INVOKABLE bool updateSettings(const QVariantMap &settings);
    Q_INVOKABLE QString environment(const QString &name) const;
    Q_INVOKABLE QString configPath(const QString &name) const;
    Q_INVOKABLE QString cachePath(const QString &name) const;
    Q_INVOKABLE QString localFilePath(const QUrl &url) const;

signals:
    void settingsChanged();
    void hideRequested();
    void notificationErrorChanged();
    void pendingNotificationActivationChanged();
    void notificationActivated(const QString &accountId, const QString &messageId);

private:
    void loadManifest(const QString &path);
    void activateFromNotification(const QString &accountId, const QString &messageId);

    QVariantMap m_manifest;
    QVariantMap m_capabilities;
    QVariantMap m_settings;
    QString m_backendPath;
    SettingsStore m_store;
    std::unique_ptr<NotificationService> m_notifications;
    QVariantMap m_pendingNotificationActivation;
};
