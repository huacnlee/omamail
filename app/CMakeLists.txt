cmake_minimum_required(VERSION 3.21)

project(omamail-app VERSION 0.10.3 LANGUAGES CXX)

if(WIN32)
  enable_language(RC)
endif()

set(CMAKE_AUTOMOC ON)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Qt6 6.5 REQUIRED COMPONENTS
  Core Gui Qml Quick QuickControls2 Network Test)

qt_standard_project_setup(REQUIRES 6.5)

set(OMAMAIL_NATIVE_SOURCES
  src/app_icon.cpp
  src/app_icon.h
  src/application_host.cpp
  src/application_host.h
  src/file_store.cpp
  src/file_store.h
  src/notifications.cpp
  src/notifications.h
  src/process.cpp
  src/process.h
  src/resource_check.cpp
  src/resource_check.h
)

if(APPLE)
  enable_language(OBJCXX)
  list(APPEND OMAMAIL_NATIVE_SOURCES src/notifications_macos.mm)
elseif(WIN32)
  list(APPEND OMAMAIL_NATIVE_SOURCES src/notifications_windows.cpp)
elseif(UNIX)
  find_package(Qt6 6.5 REQUIRED COMPONENTS DBus)
  list(APPEND OMAMAIL_NATIVE_SOURCES src/notifications_linux.cpp)
else()
  list(APPEND OMAMAIL_NATIVE_SOURCES src/notifications_stub.cpp)
endif()

qt_add_library(omamail_native STATIC)
qt_add_qml_module(omamail_native
  URI Omamail.Native
  VERSION 1.0
  OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/qml/Omamail/Native"
  SOURCES ${OMAMAIL_NATIVE_SOURCES}
)
target_link_libraries(omamail_native PUBLIC
  Qt6::Core Qt6::Gui Qt6::Qml Qt6::Network)
if(APPLE)
  target_link_libraries(omamail_native PUBLIC
    "-framework Foundation" "-framework UserNotifications")
elseif(WIN32)
  target_link_libraries(omamail_native PUBLIC
    crypt32 ole32 runtimeobject windowsapp)
elseif(UNIX)
  target_link_libraries(omamail_native PUBLIC Qt6::DBus)
endif()
if(WIN32)
  target_compile_definitions(omamail_native PRIVATE
    _WIN32_WINNT=0x0A00 WINVER=0x0A00)
endif()
target_include_directories(omamail_native PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_compile_definitions(omamail_native PUBLIC
  OMAMAIL_APP_VERSION="${PROJECT_VERSION}"
  OMAMAIL_SOURCE_ROOT="${CMAKE_CURRENT_SOURCE_DIR}/.."
)
if(DEFINED OMAMAIL_BACKEND AND NOT OMAMAIL_BACKEND STREQUAL "")
  get_filename_component(OMAMAIL_BACKEND_ABSOLUTE "${OMAMAIL_BACKEND}" ABSOLUTE)
  target_compile_definitions(omamail_native PUBLIC
    OMAMAIL_BACKEND_PATH="${OMAMAIL_BACKEND_ABSOLUTE}")
else()
  target_compile_definitions(omamail_native PUBLIC OMAMAIL_BACKEND_PATH="")
endif()

set(OMAMAIL_APP_SOURCES src/main.cpp src/window.h)
if(APPLE)
  list(APPEND OMAMAIL_APP_SOURCES src/window_macos.mm)
else()
  list(APPEND OMAMAIL_APP_SOURCES src/window_stub.cpp)
endif()
if(WIN32)
  configure_file(resources/windows/omamail.rc.in
    "${CMAKE_CURRENT_BINARY_DIR}/omamail.rc" @ONLY)
  list(APPEND OMAMAIL_APP_SOURCES "${CMAKE_CURRENT_BINARY_DIR}/omamail.rc")
endif()
qt_add_executable(omamail-app ${OMAMAIL_APP_SOURCES})
target_compile_definitions(omamail-app PRIVATE OMAMAIL_APP_VERSION="${PROJECT_VERSION}")
target_link_libraries(omamail-app PRIVATE
  omamail_nativeplugin Qt6::Quick Qt6::QuickControls2)
if(APPLE)
  target_link_libraries(omamail-app PRIVATE "-framework AppKit")
endif()

if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/qml/Main.qml")
  file(GLOB_RECURSE OMAMAIL_STANDALONE_QML CONFIGURE_DEPENDS
    "${CMAKE_CURRENT_SOURCE_DIR}/qml/*.qml"
    "${CMAKE_CURRENT_SOURCE_DIR}/qml/*.js"
    "${CMAKE_CURRENT_SOURCE_DIR}/qml/qmldir"
    "${CMAKE_CURRENT_SOURCE_DIR}/assets/fonts/*"
    "${CMAKE_CURRENT_SOURCE_DIR}/../ui/*.qml"
    "${CMAKE_CURRENT_SOURCE_DIR}/../ui/*.js"
    "${CMAKE_CURRENT_SOURCE_DIR}/../ui/assets/*")
  list(FILTER OMAMAIL_STANDALONE_QML EXCLUDE REGEX "/ui/tests/")
  qt_add_resources(omamail-app standalone_qml
    PREFIX "/omamail"
    BASE "${CMAKE_CURRENT_SOURCE_DIR}/.."
    FILES ${OMAMAIL_STANDALONE_QML} "${CMAKE_CURRENT_SOURCE_DIR}/../manifest.json"
  )
  qt_add_resources(omamail-app standalone_brand
    PREFIX "/omamail/app"
    BASE "${CMAKE_CURRENT_SOURCE_DIR}"
    FILES "${CMAKE_CURRENT_SOURCE_DIR}/resources/icons/omamail.svg"
      "${CMAKE_CURRENT_SOURCE_DIR}/resources/macos/omamail.icns"
  )
endif()

include(CTest)
if(BUILD_TESTING)
  find_package(Python3 REQUIRED COMPONENTS Interpreter)
  function(omamail_native_test name source)
    qt_add_executable(${name} "tests/native/${source}")
    if(WIN32)
      set_target_properties(${name} PROPERTIES WIN32_EXECUTABLE FALSE)
    endif()
    target_link_libraries(${name} PRIVATE omamail_native Qt6::Test)
    if(WIN32)
      add_test(NAME ${name} COMMAND "${Python3_EXECUTABLE}"
        "${CMAKE_CURRENT_SOURCE_DIR}/tests/run_native_test.py"
        "$<TARGET_FILE:${name}>")
    else()
      add_test(NAME ${name} COMMAND ${name})
    endif()
  endfunction()

  omamail_native_test(tst_process tst_process.cpp)
  omamail_native_test(tst_settings tst_settings.cpp)
  omamail_native_test(tst_resources tst_resources.cpp)
  omamail_native_test(tst_notifications tst_notifications.cpp)

  target_compile_definitions(tst_process PRIVATE
    PYTHON_EXECUTABLE="${Python3_EXECUTABLE}"
    RPC_BACKEND_FIXTURE="${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/rpc_backend.py")
  set_tests_properties(tst_resources tst_notifications PROPERTIES
    ENVIRONMENT "QT_QPA_PLATFORM=offscreen")
  add_test(NAME notification_source_boundary
    COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/test_notification_sources.py")
  add_test(NAME application_identity
    COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/test_identity.py")

  find_program(QMLTESTRUNNER_EXECUTABLE qmltestrunner HINTS "${QT6_INSTALL_PREFIX}/bin")
  if(QMLTESTRUNNER_EXECUTABLE)
    add_test(NAME tst_standalone_composition COMMAND ${QMLTESTRUNNER_EXECUTABLE}
      -import "${CMAKE_CURRENT_SOURCE_DIR}/qml/imports"
      -import "${CMAKE_CURRENT_SOURCE_DIR}/qml/styles"
      -import "${CMAKE_BINARY_DIR}/qml"
      -import "${CMAKE_CURRENT_SOURCE_DIR}/tests/qml/imports"
      -input "${CMAKE_CURRENT_SOURCE_DIR}/tests/qml/tst_standalone_composition.qml")
    set_tests_properties(tst_standalone_composition PROPERTIES
      ENVIRONMENT "QT_QPA_PLATFORM=offscreen;OMAMAIL_DEVELOPMENT_RESOURCES=1;QT_QUICK_CONTROLS_STYLE=Omamail;QT_QUICK_CONTROLS_FALLBACK_STYLE=Basic")
  endif()
endif()
