#pragma once

#include <QHash>
#include <QList>
#include <QObject>
#include <QString>
#include <QStringList>

#include <memory>

struct NativeNotification {
    QString token;
    quint64 revision = 0;
    QString title;
    QString body;
};

inline constexpr qsizetype maximumNativeNotificationEntries = 256;

class NotificationPlatform : public QObject {
    Q_OBJECT

public:
    using QObject::QObject;
    ~NotificationPlatform() override = default;

    virtual bool available() const = 0;
    virtual bool show(const NativeNotification &notification, QString *error) = 0;
    virtual QStringList takePendingActivations();
    virtual QString activationNamespace() const { return {}; }

signals:
    void activated(const QString &token);
    void activationAliasAssigned(const QString &token, quint64 revision,
                                 const QString &alias,
                                 const QString &activationNamespace);
    void activationNamespaceChanged(const QString &activationNamespace);
    void delivered(const QString &token, quint64 revision);
    void failed(const QString &token, quint64 revision, const QString &error);

protected:
    void deliverActivation(const QString &token);

private:
    QStringList m_pendingActivations;
};

std::unique_ptr<NotificationPlatform> createNotificationPlatform();
void initializeNotificationActivation();

QString notificationToken(const QString &id);
QString notificationPlatformAlias(const QString &activationNamespace,
                                  quint64 nativeId);
QString normalizeNotificationText(QString text);
QString notificationMarkupText(const QString &text);

class NotificationService final : public QObject {
    Q_OBJECT
    Q_PROPERTY(bool available READ available CONSTANT)
    Q_PROPERTY(QString error READ error NOTIFY errorChanged)

public:
    explicit NotificationService(
        std::unique_ptr<NotificationPlatform> platform = {},
        QString routingPath = {}, QObject *parent = nullptr);
    ~NotificationService() override;

    bool available() const;
    QString error() const { return m_error; }
    bool show(const QString &id, const QString &title, const QString &body,
              const QString &accountId, const QString &messageId);

signals:
    void activated(const QString &accountId, const QString &messageId);
    void errorChanged();

private:
    struct Target {
        QString accountId;
        QString messageId;
        QString rootToken;
        QString activationNamespace;
    };

    void setError(const QString &error);
    void setDeliveryError(const QString &token, quint64 revision,
                          const QString &error);
    void deliverySucceeded(const QString &token, quint64 revision);
    void deliveryFailed(const QString &token, quint64 revision,
                        const QString &error);
    void invalidateActivationNamespace(const QString &activationNamespace);
    void removeRouteFamily(const QString &rootToken);
    void touchTarget(const QString &token);
    void touchRevision(const QString &token, quint64 revision);
    void routeActivation(const QString &token);
    bool loadRoutes(QString *error);
    bool saveRoutes(QString *error) const;
    bool persistRouteRemoval(QString *error) const;

    std::unique_ptr<NotificationPlatform> m_platform;
    QHash<QString, Target> m_targets;
    QList<QString> m_targetOrder;
    QHash<QString, quint64> m_revisions;
    QList<QString> m_revisionOrder;
    QString m_routingPath;
    QString m_error;
    QString m_errorToken;
    quint64 m_errorRevision = 0;
    quint64 m_nextRevision = 0;
    QString m_lastActivatedToken;
    qint64 m_lastActivationTime = 0;
};
