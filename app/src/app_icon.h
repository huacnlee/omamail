#pragma once

#include <QIcon>
#include <QByteArray>

// The plated application icon, read out of the macOS ICNS container.
//
// An ICNS file is a list of chunks, each a four-byte type, a big-endian
// length that includes the eight-byte header, and a payload; the modern
// chunk types carry a complete PNG. Reading it here rather than through
// QImageReader means the icon does not depend on the optional icns image
// plugin, which a Qt built without qtimageformats does not have.
QIcon iconFromIcns(const QByteArray &icns);
QIcon iconFromIcnsFile(const QString &path);
