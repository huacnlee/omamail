#include "notifications.h"

#include <QCoreApplication>
#include <QMetaObject>

#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>

#include <functional>
#include <memory>

class MacNotificationPlatform;
@class OmamailNotificationDelegate;

struct MacNotificationState {
    MacNotificationPlatform *owner = nullptr;
    QStringList pendingActivations;
    UNUserNotificationCenter *center = nil;
    OmamailNotificationDelegate *delegate = nil;
    bool initializationAttempted = false;
    bool bundleReady = false;
};

@interface OmamailNotificationDelegate : NSObject<UNUserNotificationCenterDelegate> {
@public
    std::shared_ptr<MacNotificationState> state;
}
@end

static NSString *toNSString(const QString &value)
{
    return [NSString stringWithCharacters:
        reinterpret_cast<const unichar *>(value.utf16()) length:value.size()];
}

static QString fromNSString(NSString *value)
{
    if (!value) return {};
    QString result(value.length, Qt::Uninitialized);
    [value getCharacters:reinterpret_cast<unichar *>(result.data())
                    range:NSMakeRange(0, value.length)];
    return result;
}

static void onQtThread(const std::shared_ptr<MacNotificationState> &state,
                       std::function<void(MacNotificationPlatform *)> callback)
{
    QCoreApplication *application = QCoreApplication::instance();
    if (!application) return;
    QMetaObject::invokeMethod(application,
        [state, callback = std::move(callback)] {
            if (state->owner) callback(state->owner);
        }, Qt::QueuedConnection);
}

static std::shared_ptr<MacNotificationState> macNotificationState()
{
    static const auto state = std::make_shared<MacNotificationState>();
    return state;
}

static bool installNotificationDelegate(
    const std::shared_ptr<MacNotificationState> &state, QString *error = nullptr)
{
    if (state->center) return true;
    if (state->initializationAttempted) {
        if (error && !state->bundleReady)
            *error = QStringLiteral(
                "macOS notifications require an application bundle identifier");
        return false;
    }
    state->initializationAttempted = true;
    state->bundleReady = NSBundle.mainBundle.bundleIdentifier.length > 0;
    if (!state->bundleReady) {
        if (error)
            *error = QStringLiteral(
                "macOS notifications require an application bundle identifier");
        return false;
    }
    @try {
        state->center = [UNUserNotificationCenter currentNotificationCenter];
        state->delegate = [[OmamailNotificationDelegate alloc] init];
        state->delegate->state = state;
        state->center.delegate = state->delegate;
        return true;
    } @catch (NSException *exception) {
        if (error) {
            *error = QStringLiteral("macOS notification center failed: %1")
                .arg(fromNSString(exception.reason));
        }
        return false;
    }
}

class MacNotificationPlatform final : public NotificationPlatform {
public:
    MacNotificationPlatform()
        : m_state(macNotificationState())
    {
        installNotificationDelegate(m_state);
        m_state->owner = this;
    }

    ~MacNotificationPlatform() override
    {
        m_state->owner = nullptr;
    }

    bool available() const override { return m_state->center != nil; }

    QStringList takePendingActivations() override
    {
        QStringList pending = NotificationPlatform::takePendingActivations();
        pending.append(m_state->pendingActivations);
        m_state->pendingActivations.clear();
        return pending;
    }

    bool show(const NativeNotification &notification, QString *error) override
    {
        if (!ensureCenter(error)) {
            return false;
        }
        track(notification);

        const auto state = m_state;
        const NativeNotification copy = notification;
        UNUserNotificationCenter *center = m_state->center;
        [center getNotificationSettingsWithCompletionHandler:
            ^(UNNotificationSettings *settings) {
                const UNAuthorizationStatus status = settings.authorizationStatus;
                if (status == UNAuthorizationStatusAuthorized
                    || status == UNAuthorizationStatusProvisional) {
                    onQtThread(state, [copy](MacNotificationPlatform *owner) {
                        owner->submit(copy);
                    });
                    return;
                }
                if (status != UNAuthorizationStatusNotDetermined) {
                    onQtThread(state, [copy](MacNotificationPlatform *owner) {
                        owner->reportFailure(copy.token, copy.revision,
                            QStringLiteral(
                                "Notifications are disabled in macOS System Settings"));
                    });
                    return;
                }
                [center
                    requestAuthorizationWithOptions:UNAuthorizationOptionAlert
                    completionHandler:^(BOOL granted, NSError *authorizationError) {
                        if (granted) {
                            onQtThread(state, [copy](MacNotificationPlatform *owner) {
                                owner->submit(copy);
                            });
                            return;
                        }
                        const QString detail = authorizationError
                            ? fromNSString(authorizationError.localizedDescription)
                            : QStringLiteral("permission denied");
                        onQtThread(state, [copy, detail](MacNotificationPlatform *owner) {
                            owner->reportFailure(copy.token, copy.revision,
                                QStringLiteral(
                                    "macOS notification authorization failed: %1")
                                    .arg(detail));
                        });
                    }];
            }];
        return true;
    }

    void submit(const NativeNotification &notification)
    {
        if (!isCurrent(notification.token, notification.revision)) return;
        @autoreleasepool {
            UNMutableNotificationContent *content =
                [[UNMutableNotificationContent alloc] init];
            content.title = toNSString(notification.title);
            content.body = toNSString(notification.body);
            UNNotificationRequest *request = [UNNotificationRequest
                requestWithIdentifier:toNSString(notification.token)
                content:content trigger:nil];
            const auto state = m_state;
            const QString token = notification.token;
            const quint64 revision = notification.revision;
            [m_state->center addNotificationRequest:request
                withCompletionHandler:^(NSError *deliveryError) {
                    if (!deliveryError) {
                        onQtThread(state, [token, revision](
                            MacNotificationPlatform *owner) {
                                owner->reportDelivered(token, revision);
                            });
                        return;
                    }
                    const QString detail = fromNSString(deliveryError.localizedDescription);
                    onQtThread(state, [token, revision, detail](
                        MacNotificationPlatform *owner) {
                        owner->reportFailure(token, revision,
                            QStringLiteral("macOS notification delivery failed: %1")
                                .arg(detail));
                    });
                }];
            [content release];
        }
    }

    void activateToken(const QString &token) { deliverActivation(token); }
    void reportDelivered(const QString &token, quint64 revision)
    {
        if (!takeCurrent(token, revision)) return;
        emit delivered(token, revision);
    }
    void reportFailure(const QString &token, quint64 revision,
                       const QString &error)
    {
        if (!takeCurrent(token, revision)) return;
        emit failed(token, revision, error);
    }

private:
    void track(const NativeNotification &notification)
    {
        m_revisionOrder.removeAll(notification.token);
        m_revisionOrder.append(notification.token);
        m_revisions.insert(notification.token, notification.revision);
        while (m_revisionOrder.size() > maximumNativeNotificationEntries)
            m_revisions.remove(m_revisionOrder.takeFirst());
    }

    bool isCurrent(const QString &token, quint64 revision) const
    {
        return m_revisions.value(token) == revision;
    }

    bool takeCurrent(const QString &token, quint64 revision)
    {
        if (!isCurrent(token, revision)) return false;
        m_revisions.remove(token);
        m_revisionOrder.removeAll(token);
        return true;
    }

    bool ensureCenter(QString *error)
    {
        return installNotificationDelegate(m_state, error);
    }

    std::shared_ptr<MacNotificationState> m_state;
    QHash<QString, quint64> m_revisions;
    QList<QString> m_revisionOrder;
};

@implementation OmamailNotificationDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler
{
    Q_UNUSED(center)
    Q_UNUSED(notification)
    completionHandler(UNNotificationPresentationOptionBanner
                      | UNNotificationPresentationOptionList);
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
didReceiveNotificationResponse:(UNNotificationResponse *)response
         withCompletionHandler:(void (^)(void))completionHandler
{
    Q_UNUSED(center)
    if (![response.actionIdentifier isEqualToString:UNNotificationDismissActionIdentifier]) {
        const QString token = fromNSString(response.notification.request.identifier);
        const auto callbackState = state;
        QCoreApplication *application = QCoreApplication::instance();
        if (application) QMetaObject::invokeMethod(application, [callbackState, token] {
            if (callbackState->owner) callbackState->owner->activateToken(token);
            else {
                callbackState->pendingActivations.append(token);
                while (callbackState->pendingActivations.size()
                       > maximumNativeNotificationEntries)
                    callbackState->pendingActivations.removeFirst();
            }
        });
    }
    completionHandler();
}
@end

std::unique_ptr<NotificationPlatform> createNotificationPlatform()
{
    return std::make_unique<MacNotificationPlatform>();
}

void initializeNotificationActivation()
{
    installNotificationDelegate(macNotificationState());
}
