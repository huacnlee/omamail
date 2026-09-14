#include "notifications.h"

namespace {
class UnavailableNotificationPlatform final : public NotificationPlatform {
public:
    bool available() const override { return false; }
    bool show(const NativeNotification &, QString *error) override
    {
        if (error) *error = QStringLiteral("Desktop notifications are unavailable");
        return false;
    }
};
}

std::unique_ptr<NotificationPlatform> createNotificationPlatform()
{
    return std::make_unique<UnavailableNotificationPlatform>();
}

void initializeNotificationActivation() {}
