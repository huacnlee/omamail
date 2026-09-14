#include "notifications.h"

#include <QCoreApplication>
#include <QMetaObject>

#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>

#include <functional>
#include <memory>

class MacNotificationPlatform;

struct MacNotificationState {
    MacNotificationPlatform *owner = nullptr;
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

class MacNotificationPlatform final : public NotificationPlatform {
public:
    MacNotificationPlatform()
        : m_state(std::make_shared<MacNotificationState>())
    {
        m_state->owner = this;
        m_bundleReady = NSBundle.mainBundle.bundleIdentifier.length > 0;
    }

    ~MacNotificationPlatform() override
    {
        m_state->owner = nullptr;
        if (m_delegate) {
            if (m_center.delegate == m_delegate) m_center.delegate = nil;
            m_delegate->state.reset();
            [m_delegate release];
        }
    }

    bool available() const override { return m_bundleReady; }

    bool show(const NativeNotification &notification, QString *error) override
    {
        if (!ensureCenter(error)) {
            return false;
        }

        const auto state = m_state;
        const NativeNotification copy = notification;
        UNUserNotificationCenter *center = m_center;
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
                    onQtThread(state, [](MacNotificationPlatform *owner) {
                        owner->reportFailure(QStringLiteral(
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
                        onQtThread(state, [detail](MacNotificationPlatform *owner) {
                            owner->reportFailure(QStringLiteral(
                                "macOS notification authorization failed: %1").arg(detail));
                        });
                    }];
            }];
        return true;
    }

    void submit(const NativeNotification &notification)
    {
        @autoreleasepool {
            UNMutableNotificationContent *content =
                [[UNMutableNotificationContent alloc] init];
            content.title = toNSString(notification.title);
            content.body = toNSString(notification.body);
            UNNotificationRequest *request = [UNNotificationRequest
                requestWithIdentifier:toNSString(notification.token)
                content:content trigger:nil];
            const auto state = m_state;
            [m_center addNotificationRequest:request
                withCompletionHandler:^(NSError *deliveryError) {
                    if (!deliveryError) return;
                    const QString detail = fromNSString(deliveryError.localizedDescription);
                    onQtThread(state, [detail](MacNotificationPlatform *owner) {
                        owner->reportFailure(QStringLiteral(
                            "macOS notification delivery failed: %1").arg(detail));
                    });
                }];
            [content release];
        }
    }

    void activateToken(const QString &token) { emit activated(token); }
    void reportFailure(const QString &error) { emit failed(error); }

private:
    bool ensureCenter(QString *error)
    {
        if (m_center) return true;
        if (!m_bundleReady) {
            if (error)
                *error = QStringLiteral(
                    "macOS notifications require an application bundle identifier");
            return false;
        }
        @try {
            m_center = [UNUserNotificationCenter currentNotificationCenter];
            m_delegate = [[OmamailNotificationDelegate alloc] init];
            m_delegate->state = m_state;
            m_center.delegate = m_delegate;
            return true;
        } @catch (NSException *exception) {
            if (error) {
                *error = QStringLiteral("macOS notification center failed: %1")
                    .arg(fromNSString(exception.reason));
            }
            return false;
        }
    }

    UNUserNotificationCenter *m_center = nil;
    OmamailNotificationDelegate *m_delegate = nil;
    std::shared_ptr<MacNotificationState> m_state;
    bool m_bundleReady = false;
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
        onQtThread(callbackState, [token](MacNotificationPlatform *owner) {
            owner->activateToken(token);
        });
    }
    completionHandler();
}
@end

std::unique_ptr<NotificationPlatform> createNotificationPlatform()
{
    return std::make_unique<MacNotificationPlatform>();
}
