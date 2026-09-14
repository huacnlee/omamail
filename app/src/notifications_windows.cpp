#include "notifications.h"

#include <QCoreApplication>
#include <QMetaObject>

#include <windows.h>
#include <roapi.h>
#include <winrt/Windows.Data.Xml.Dom.h>
#include <winrt/Windows.UI.Notifications.h>
#include <winrt/base.h>

#include <atomic>
#include <cwchar>
#include <functional>
#include <map>
#include <memory>
#include <new>
#include <string_view>

typedef struct NOTIFICATION_USER_INPUT_DATA {
    LPCWSTR Key;
    LPCWSTR Value;
} NOTIFICATION_USER_INPUT_DATA;

MIDL_INTERFACE("53E31837-6600-4A81-9395-75CFFE746F94")
INotificationActivationCallback : public IUnknown {
public:
    virtual HRESULT STDMETHODCALLTYPE Activate(
        LPCWSTR appUserModelId, LPCWSTR invokedArgs,
        const NOTIFICATION_USER_INPUT_DATA *data, ULONG dataCount) = 0;
};

namespace {
using namespace winrt;
using namespace Windows::Data::Xml::Dom;
using namespace Windows::UI::Notifications;

class WindowsNotificationPlatform;

struct WindowsNotificationState {
    WindowsNotificationPlatform *owner = nullptr;
    QStringList pendingActivations;
    DWORD classRegistration = 0;
    bool initializationAttempted = false;
    bool comRegistered = false;
    bool uninitializeRuntime = false;
};

constexpr wchar_t applicationId[] = L"com.omamail.app";
const CLSID notificationActivatorClsid{
    0x6e420bbe, 0xa800, 0x4ff9,
    {0xbd, 0x65, 0x47, 0x2c, 0xc5, 0x39, 0x22, 0xca}};

std::shared_ptr<WindowsNotificationState> windowsNotificationState()
{
    static const auto state = std::make_shared<WindowsNotificationState>();
    return state;
}

bool validActivationToken(LPCWSTR value)
{
    if (!value || std::wcslen(value) != 64) return false;
    for (size_t index = 0; index < 64; ++index) {
        const wchar_t character = value[index];
        if (!((character >= L'0' && character <= L'9')
              || (character >= L'a' && character <= L'f'))) return false;
    }
    return true;
}

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

void dispatchActivation(const std::shared_ptr<WindowsNotificationState> &state,
                        const QString &token);

class NotificationActivationCallback final
    : public INotificationActivationCallback {
public:
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void **object) override
    {
        if (!object) return E_POINTER;
        *object = nullptr;
        if (IsEqualIID(iid, __uuidof(IUnknown))
            || IsEqualIID(iid, __uuidof(INotificationActivationCallback))) {
            *object = static_cast<INotificationActivationCallback *>(this);
            AddRef();
            return S_OK;
        }
        return E_NOINTERFACE;
    }

    ULONG STDMETHODCALLTYPE AddRef() override { return ++m_references; }

    ULONG STDMETHODCALLTYPE Release() override
    {
        const ULONG references = --m_references;
        if (!references) delete this;
        return references;
    }

    HRESULT STDMETHODCALLTYPE Activate(
        LPCWSTR appUserModelId, LPCWSTR invokedArgs,
        const NOTIFICATION_USER_INPUT_DATA *, ULONG) override
    {
        if (!appUserModelId || std::wcscmp(appUserModelId, applicationId) != 0)
            return E_ACCESSDENIED;
        if (!validActivationToken(invokedArgs)) return E_INVALIDARG;
        dispatchActivation(windowsNotificationState(),
                           QString::fromWCharArray(invokedArgs, 64));
        return S_OK;
    }

private:
    std::atomic<ULONG> m_references{1};
};

class NotificationActivationFactory final : public IClassFactory {
public:
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void **object) override
    {
        if (!object) return E_POINTER;
        *object = nullptr;
        if (IsEqualIID(iid, __uuidof(IUnknown))
            || IsEqualIID(iid, __uuidof(IClassFactory))) {
            *object = static_cast<IClassFactory *>(this);
            AddRef();
            return S_OK;
        }
        return E_NOINTERFACE;
    }

    ULONG STDMETHODCALLTYPE AddRef() override { return ++m_references; }

    ULONG STDMETHODCALLTYPE Release() override
    {
        const ULONG references = --m_references;
        if (!references) delete this;
        return references;
    }

    HRESULT STDMETHODCALLTYPE CreateInstance(IUnknown *outer, REFIID iid,
                                             void **object) override
    {
        if (outer) return CLASS_E_NOAGGREGATION;
        auto *activation = new (std::nothrow) NotificationActivationCallback;
        if (!activation) return E_OUTOFMEMORY;
        const HRESULT result = activation->QueryInterface(iid, object);
        activation->Release();
        return result;
    }

    HRESULT STDMETHODCALLTYPE LockServer(BOOL) override { return S_OK; }

private:
    std::atomic<ULONG> m_references{1};
};

void shutdownNotificationActivation()
{
    const auto state = windowsNotificationState();
    state->owner = nullptr;
    if (state->classRegistration) {
        CoRevokeClassObject(state->classRegistration);
        state->classRegistration = 0;
    }
    if (state->uninitializeRuntime) {
        RoUninitialize();
        state->uninitializeRuntime = false;
    }
    state->comRegistered = false;
}

void installNotificationActivator()
{
    const auto state = windowsNotificationState();
    if (state->initializationAttempted) return;
    state->initializationAttempted = true;
    const HRESULT initialized = RoInitialize(RO_INIT_MULTITHREADED);
    state->uninitializeRuntime = SUCCEEDED(initialized);
    if (FAILED(initialized) && initialized != RPC_E_CHANGED_MODE) return;
    auto *factory = new (std::nothrow) NotificationActivationFactory;
    if (!factory) return;
    const HRESULT registration = CoRegisterClassObject(
        notificationActivatorClsid, factory, CLSCTX_LOCAL_SERVER,
        REGCLS_MULTIPLEUSE, &state->classRegistration);
    factory->Release();
    state->comRegistered = SUCCEEDED(registration);
    if (state->comRegistered) qAddPostRoutine(shutdownNotificationActivation);
}

class WindowsNotificationPlatform final : public NotificationPlatform {
public:
    WindowsNotificationPlatform()
        : m_state(windowsNotificationState())
    {
        installNotificationActivator();
        m_state->owner = this;
        if (!m_state->comRegistered) return;
        try {
            m_notifier = ToastNotificationManager::CreateToastNotifier(
                hstring(applicationId));
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
    }

    bool available() const override { return m_ready; }

    QStringList takePendingActivations() override
    {
        QStringList pending = NotificationPlatform::takePendingActivations();
        pending.append(m_state->pendingActivations);
        m_state->pendingActivations.clear();
        return pending;
    }

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
                    dispatchActivation(state, token);
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
            emit delivered(notification.token);
            return true;
        } catch (const hresult_error &failure) {
            if (error) {
                *error = QStringLiteral("Windows notification delivery failed: %1")
                    .arg(fromHString(failure.message()));
            }
            return false;
        }
    }

    void activateToken(const QString &token) { deliverActivation(token); }
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
};

void dispatchActivation(const std::shared_ptr<WindowsNotificationState> &state,
                        const QString &token)
{
    QCoreApplication *application = QCoreApplication::instance();
    if (!application) return;
    QMetaObject::invokeMethod(application, [state, token] {
        if (state->owner) state->owner->activateToken(token);
        else state->pendingActivations.append(token);
    }, Qt::QueuedConnection);
}
}

std::unique_ptr<NotificationPlatform> createNotificationPlatform()
{
    return std::make_unique<WindowsNotificationPlatform>();
}

void initializeNotificationActivation()
{
    installNotificationActivator();
}
