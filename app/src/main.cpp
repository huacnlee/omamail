#include "app_icon.h"
#include "application_host.h"
#include "notifications.h"
#include "resource_check.h"
#include "single_instance.h"
#include "window.h"

#include <QCoreApplication>
#include <QDir>
#include <QFileInfo>
#include <QGuiApplication>
#include <QIcon>
#include <QJsonDocument>
#include <QJsonObject>
#include <QQmlApplicationEngine>
#include <QQuickStyle>
#include <QQuickWindow>
#include <QTextStream>
#include <QWindow>

namespace {
int reportResourceCheck(const ResourcePaths &paths)
{
    const ResourceCheck result = checkResources(paths);
    if (result.ok) return 0;
    QTextStream stream(stderr);
    for (const QString &error : result.errors) stream << error << Qt::endl;
    return 1;
}

// One Omamail per session; see single_instance.h.
QString instanceName()
{
    return QStringLiteral("omamail-app-") + qEnvironmentVariable("USER", QStringLiteral("user"));
}

// The payload the window opens with: a mailto: link becomes a draft, as the
// shell plugin's mailto.sh does. Anything else opens the window as it is.
QString openPayload(const QString &mailto)
{
    if (!mailto.startsWith(QStringLiteral("mailto:"), Qt::CaseInsensitive)) return QStringLiteral("{}");
    return QString::fromUtf8(QJsonDocument(QJsonObject{{QStringLiteral("mailto"), mailto}})
                                 .toJson(QJsonDocument::Compact));
}

}

int main(int argc, char *argv[])
{
    bool checkOnly = false;
    QString readyFile;
    QString mailto;
    for (int i = 1; i < argc; ++i) {
        const QString argument = QString::fromLocal8Bit(argv[i]);
        if (argument == QStringLiteral("--check-resources")) checkOnly = true;
        else if (argument == QStringLiteral("--smoke-test") && i + 1 < argc)
            readyFile = QString::fromLocal8Bit(argv[++i]);
        else if (argument.startsWith(QStringLiteral("mailto:"), Qt::CaseInsensitive)) mailto = argument;
    }

    QCoreApplication::setOrganizationName(QStringLiteral("Omamail"));
    QCoreApplication::setApplicationName(QStringLiteral("Omamail"));
    QCoreApplication::setApplicationVersion(QStringLiteral(OMAMAIL_APP_VERSION));

    if (checkOnly && readyFile.isEmpty()) {
        QCoreApplication application(argc, argv);
        return reportResourceCheck(defaultResourcePaths({}, developmentResourcesEnabled()));
    }

    if (!readyFile.isEmpty() && qEnvironmentVariableIsEmpty("QT_QPA_PLATFORM"))
        qputenv("QT_QPA_PLATFORM", "offscreen");
    QQuickWindow::setDefaultAlphaBuffer(false);
    QGuiApplication application(argc, argv);
    // The host decides when the process ends: the app menu's Quit, or the
    // shell hiding a window it has no way to bring back. Qt's own reflex of
    // quitting once the last window is hidden would turn Cmd+W into Cmd+Q.
    application.setQuitOnLastWindowClosed(false);
    // macOS shows the bundle's CFBundleIconFile — the plated omamail.icns —
    // in Finder, and a window icon set here replaces that Dock image with the
    // bare logo. Leave the bundle icon alone there. A development run has no
    // bundle and would sit in the Dock as a generic executable, so it takes
    // the same plated icon from the resource instead. The other platforms
    // take their window icon from the SVG.
#ifdef Q_OS_MACOS
    if (!QCoreApplication::applicationDirPath().endsWith(QStringLiteral(".app/Contents/MacOS")))
        application.setWindowIcon(iconFromIcnsFile(QStringLiteral(
            ":/omamail/app/resources/macos/omamail.icns")));
#else
    application.setWindowIcon(QIcon(QStringLiteral(
        ":/omamail/app/resources/icons/omamail.svg")));
#endif
    const ResourcePaths paths = defaultResourcePaths({}, developmentResourcesEnabled());
    if (!readyFile.isEmpty()) {
        QString error;
        if (runSmokeTest(paths, readyFile, &error)) return 0;
        QTextStream(stderr) << error << Qt::endl;
        return 1;
    }
    if (const int status = reportResourceCheck(paths); status != 0) return status;
    // Settled before QML or the backend load, so two launches at once cannot
    // both start one.
    SingleInstance instance(instanceName());
    switch (instance.claimOrForward(openPayload(mailto))) {
    case SingleInstance::Launch::Forwarded:
        return 0;
    case SingleInstance::Launch::Failed:
        QTextStream(stderr) << "Another Omamail is starting and did not answer" << Qt::endl;
        return 1;
    case SingleInstance::Launch::Owner:
        break;
    }
    initializeNotificationActivation();

    // Native platform styles can draw a light system scrollbar over a dark
    // Omarchy palette. Keep controls in the standalone process on our small
    // semantic style; the shell plugin continues to use the shell's style.
    QQuickStyle::setStyle(QStringLiteral("Omamail"));
    QQuickStyle::setFallbackStyle(QStringLiteral("Basic"));

    QQmlApplicationEngine engine;
    engine.addImportPath(QFileInfo(paths.sharedUi).absolutePath());
    engine.addImportPath(paths.standaloneQml.startsWith(QStringLiteral(":"))
        ? QStringLiteral("qrc:/omamail/app/qml/imports")
        : QFileInfo(paths.standaloneQml).dir().filePath(QStringLiteral("imports")));
    engine.addImportPath(paths.standaloneQml.startsWith(QStringLiteral(":"))
        ? QStringLiteral("qrc:/omamail/app/qml/styles")
        : QFileInfo(paths.standaloneQml).dir().filePath(QStringLiteral("styles")));
    const QUrl mainUrl = paths.standaloneQml.startsWith(QStringLiteral(":"))
        ? QUrl(QStringLiteral("qrc") + paths.standaloneQml)
        : QUrl::fromLocalFile(paths.standaloneQml);
    engine.load(mainUrl);
    if (engine.rootObjects().isEmpty()) return 1;
    auto *host = engine.singletonInstance<ApplicationHost *>(
        QStringLiteral("Omamail.Native"), QStringLiteral("NativeHost"));
    if (host && !mailto.isEmpty()) host->requestOpen(openPayload(mailto));
    for (QObject *object : engine.rootObjects()) {
        if (auto *window = qobject_cast<QWindow *>(object)) {
            prepareNativeWindow(window);
            if (host) watchNativeCloseChord(window, [host] { host->requestClose(); });
        }
    }
    QObject::connect(&instance, &SingleInstance::openRequested, &instance, [host](const QString &payload) {
        if (host) host->requestOpen(payload);
    });
    if (!instance.listen())
        QTextStream(stderr) << "Omamail could not listen for later launches" << Qt::endl;
    return application.exec();
}
