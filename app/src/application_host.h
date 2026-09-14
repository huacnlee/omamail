#pragma once

#include "file_store.h"

#include <QObject>
#include <QVariantMap>
#include <QtQml/qqmlregistration.h>

class ApplicationHost final : public QObject {
    Q_OBJECT
    QML_NAMED_ELEMENT(NativeHost)
    QML_SINGLETON

    Q_PROPERTY(QVariantMap manifest READ manifest CONSTANT)
    Q_PROPERTY(QVariantMap capabilities READ capabilities CONSTANT)
    Q_PROPERTY(QVariantMap settings READ settings NOTIFY settingsChanged)
    Q_PROPERTY(QString backendPath READ backendPath CONSTANT)

public:
    explicit ApplicationHost(QObject *parent = nullptr);
    ApplicationHost(QString manifestPath, QString backendPath,
                    QString settingsPath, QObject *parent = nullptr);

    QVariantMap manifest() const { return m_manifest; }
    QVariantMap capabilities() const { return m_capabilities; }
    QVariantMap settings() const { return m_settings; }
    QString backendPath() const { return m_backendPath; }

    Q_INVOKABLE bool openExternal(const QString &urlOrPath);
    Q_INVOKABLE bool setClipboard(const QString &text);
    Q_INVOKABLE bool showNotification(const QString &id, const QString &title,
                                      const QString &body, const QString &accountId,
                                      const QString &messageId);
    Q_INVOKABLE void hide();
    Q_INVOKABLE void quit();
    Q_INVOKABLE bool updateSettings(const QVariantMap &settings);
    Q_INVOKABLE QString environment(const QString &name) const;

signals:
    void settingsChanged();
    void hideRequested();
    void notificationActivated(const QString &accountId, const QString &messageId);

private:
    void loadManifest(const QString &path);

    QVariantMap m_manifest;
    const QVariantMap m_capabilities{
        {QStringLiteral("agent"), false},
        {QStringLiteral("systemTray"), false},
        {QStringLiteral("notifications"), false}};
    QVariantMap m_settings;
    QString m_backendPath;
    SettingsStore m_store;
};
