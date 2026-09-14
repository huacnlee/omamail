#pragma once

#include <QHash>
#include <QList>
#include <QObject>
#include <QString>
#include <QStringList>

#include <memory>

struct NativeNotification {
    QString token;
    QString title;
    QString body;
};

class NotificationPlatform : public QObject {
    Q_OBJECT

public:
    using QObject::QObject;
    ~NotificationPlatform() override = default;

    virtual bool available() const = 0;
    virtual bool show(const NativeNotification &notification, QString *error) = 0;
    virtual QStringList takePendingActivations();

signals:
    void activated(const QString &token);
    void activationAliasAssigned(const QString &token, const QString &alias);
    void delivered(const QString &token);
    void failed(const QString &error);

protected:
    void deliverActivation(const QString &token);

private:
    QStringList m_pendingActivations;
};

std::unique_ptr<NotificationPlatform> createNotificationPlatform();
void initializeNotificationActivation();

QString notificationToken(const QString &id);
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
    };

    void setError(const QString &error);
    void routeActivation(const QString &token);
    bool loadRoutes(QString *error);
    bool saveRoutes(QString *error) const;

    std::unique_ptr<NotificationPlatform> m_platform;
    QHash<QString, Target> m_targets;
    QList<QString> m_targetOrder;
    QString m_routingPath;
    QString m_error;
    QString m_lastActivatedToken;
    qint64 m_lastActivationTime = 0;
};
