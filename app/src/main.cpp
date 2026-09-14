#include "resource_check.h"
#include "notifications.h"

#include <QCoreApplication>
#include <QDir>
#include <QFileInfo>
#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QTextStream>

namespace {
int reportResourceCheck(const ResourcePaths &paths)
{
    const ResourceCheck result = checkResources(paths);
    if (result.ok) return 0;
    QTextStream stream(stderr);
    for (const QString &error : result.errors) stream << error << Qt::endl;
    return 1;
}
}

int main(int argc, char *argv[])
{
    bool checkOnly = false;
    QString readyFile;
    for (int i = 1; i < argc; ++i) {
        const QString argument = QString::fromLocal8Bit(argv[i]);
        if (argument == QStringLiteral("--check-resources")) checkOnly = true;
        else if (argument == QStringLiteral("--smoke-test") && i + 1 < argc)
            readyFile = QString::fromLocal8Bit(argv[++i]);
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
    QGuiApplication application(argc, argv);
    const ResourcePaths paths = defaultResourcePaths({}, developmentResourcesEnabled());
    if (!readyFile.isEmpty()) {
        QString error;
        if (runSmokeTest(paths, readyFile, &error)) return 0;
        QTextStream(stderr) << error << Qt::endl;
        return 1;
    }
    if (const int status = reportResourceCheck(paths); status != 0) return status;
    initializeNotificationActivation();

    QQmlApplicationEngine engine;
    engine.addImportPath(QFileInfo(paths.sharedUi).absolutePath());
    engine.addImportPath(paths.standaloneQml.startsWith(QStringLiteral(":"))
        ? QStringLiteral("qrc:/omamail/app/qml/imports")
        : QFileInfo(paths.standaloneQml).dir().filePath(QStringLiteral("imports")));
    const QUrl mainUrl = paths.standaloneQml.startsWith(QStringLiteral(":"))
        ? QUrl(QStringLiteral("qrc") + paths.standaloneQml)
        : QUrl::fromLocalFile(paths.standaloneQml);
    engine.load(mainUrl);
    if (engine.rootObjects().isEmpty()) return 1;
    return application.exec();
}
