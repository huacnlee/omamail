#include "notifications.h"

#include <QCoreApplication>
#include <QMetaObject>

#include <windows.h>
#include <roapi.h>
#include <winrt/Windows.Data.Xml.Dom.h>
#include <winrt/Windows.UI.Notifications.h>
#include <winrt/base.h>

#include <functional>
#include <map>
#include <memory>
#include <string_view>

namespace {
using namespace winrt;
using namespace Windows::Data::Xml::Dom;
using namespace Windows::UI::Notifications;

class WindowsNotificationPlatform;

struct WindowsNotificationState {
    WindowsNotificationPlatform *owner = nullptr;
};

hstring toHString(const QString &value)
{
    return hstring(std::wstring_view(
        reinterpret_cast<const wchar_t *>(value.utf16()), value.size()));
}

QString fromHString(const hstring &value)
{
    return QString::fromWCharArray(value.c_str(), static_cast<qsizetype>(value.size()));
}

void onQtThread(const std::shared_ptr<WindowsNotificationState> &state,
                std::function<void(WindowsNotificationPlatform *)> callback)
{
    QCoreApplication *application = QCoreApplication::instance();
    if (!application) return;
    QMetaObject::invokeMethod(application,
        [state, callback = std::move(callback)] {
            if (state->owner) callback(state->owner);
        }, Qt::QueuedConnection);
}

class WindowsNotificationPlatform final : public NotificationPlatform {
public:
    WindowsNotificationPlatform()
        : m_state(std::make_shared<WindowsNotificationState>())
    {
        m_state->owner = this;
        const HRESULT initialized = RoInitialize(RO_INIT_MULTITHREADED);
        m_uninitialize = SUCCEEDED(initialized);
        if (FAILED(initialized) && initialized != RPC_E_CHANGED_MODE) return;
        try {
            m_notifier = ToastNotificationManager::CreateToastNotifier(
                L"com.omamail.app");
            m_ready = true;
        } catch (const hresult_error &) {
            m_ready = false;
        }
    }

    ~WindowsNotificationPlatform() override
    {
        m_state->owner = nullptr;
        for (auto &[token, entry] : m_entries) {
            Q_UNUSED(token)
            entry.toast.Activated(entry.activated);
            entry.toast.Failed(entry.failed);
        }
        if (m_uninitialize) RoUninitialize();
    }

    bool available() const override { return m_ready; }

    bool show(const NativeNotification &notification, QString *error) override
    {
        if (!m_ready) {
            if (error) *error = QStringLiteral("Windows notifications are unavailable");
            return false;
        }
        if (notification.title.contains(QChar::Null)
            || notification.body.contains(QChar::Null)) {
            if (error) *error = QStringLiteral("Desktop notification text contains NUL");
            return false;
        }

        try {
            if (m_notifier.Setting() != NotificationSetting::Enabled) {
                if (error)
                    *error = QStringLiteral(
                        "Notifications are disabled in Windows Settings");
                return false;
            }

            XmlDocument document;
            const XmlElement toastElement = document.CreateElement(L"toast");
            toastElement.SetAttribute(L"launch", toHString(notification.token));
            document.AppendChild(toastElement);
            const XmlElement visualElement = document.CreateElement(L"visual");
            toastElement.AppendChild(visualElement);
            const XmlElement bindingElement = document.CreateElement(L"binding");
            bindingElement.SetAttribute(L"template", L"ToastGeneric");
            visualElement.AppendChild(bindingElement);
            appendText(document, bindingElement, notification.title);
            appendText(document, bindingElement, notification.body);

            ToastNotification toast(document);
            toast.Tag(toHString(notification.token));
            toast.Group(L"omamail");
            const auto state = m_state;
            const QString token = notification.token;
            const event_token activated = toast.Activated(
                [state, token](const ToastNotification &, const IInspectable &) {
                    onQtThread(state, [token](WindowsNotificationPlatform *owner) {
                        owner->activateToken(token);
                    });
                });
            const event_token failed = toast.Failed(
                [state](const ToastNotification &, const ToastFailedEventArgs &args) {
                    const QString detail = QStringLiteral("0x%1").arg(
                        static_cast<quint32>(args.ErrorCode().value), 8, 16,
                        QLatin1Char('0'));
                    onQtThread(state, [detail](WindowsNotificationPlatform *owner) {
                        owner->reportFailure(QStringLiteral(
                            "Windows notification delivery failed: %1").arg(detail));
                    });
                });

            const std::wstring key = toHString(notification.token).c_str();
            const auto existing = m_entries.find(key);
            if (existing != m_entries.end()) {
                existing->second.toast.Activated(existing->second.activated);
                existing->second.toast.Failed(existing->second.failed);
                m_entries.erase(existing);
            }
            m_notifier.Show(toast);
            m_entries.emplace(key, Entry{toast, activated, failed});
            return true;
        } catch (const hresult_error &failure) {
            if (error) {
                *error = QStringLiteral("Windows notification delivery failed: %1")
                    .arg(fromHString(failure.message()));
            }
            return false;
        }
    }

    void activateToken(const QString &token) { emit activated(token); }
    void reportFailure(const QString &error) { emit failed(error); }

private:
    struct Entry {
        ToastNotification toast{nullptr};
        event_token activated{};
        event_token failed{};
    };

    static void appendText(const XmlDocument &document, const XmlElement &binding,
                           const QString &text)
    {
        const XmlElement element = document.CreateElement(L"text");
        element.AppendChild(document.CreateTextNode(toHString(text)));
        binding.AppendChild(element);
    }

    ToastNotifier m_notifier{nullptr};
    std::shared_ptr<WindowsNotificationState> m_state;
    std::map<std::wstring, Entry> m_entries;
    bool m_ready = false;
    bool m_uninitialize = false;
};
}

std::unique_ptr<NotificationPlatform> createNotificationPlatform()
{
    return std::make_unique<WindowsNotificationPlatform>();
}
