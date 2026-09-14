#pragma once

#include <QString>
#include <QStringList>

struct ResourcePaths {
    QString standaloneQml;
    QString sharedUi;
    QString platformPlugin;
    QString backend;
    QString manifest;
};

struct ResourceCheck {
    bool ok = false;
    QStringList errors;
};

struct SmokeMetrics {
    qsizetype maximumStdoutFrameBytes = 0;
    qsizetype maximumStderrTailBytes = 0;
};

bool developmentResourcesEnabled();
ResourcePaths defaultResourcePaths(const QString &executablePath = {},
                                   bool developmentMode = false);
ResourceCheck checkResources(const ResourcePaths &paths);
bool runSmokeTest(const ResourcePaths &paths, const QString &readyFile,
                  QString *error = nullptr, int shutdownTimeoutMilliseconds = 5000,
                  SmokeMetrics *metrics = nullptr);
