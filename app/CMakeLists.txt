cmake_minimum_required(VERSION 3.21)

project(omamail-app VERSION 0.10.1 LANGUAGES CXX)

set(CMAKE_AUTOMOC ON)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Qt6 6.5 REQUIRED COMPONENTS
  Core Gui Qml Quick QuickControls2 Network Test)

qt_standard_project_setup(REQUIRES 6.5)

set(OMAMAIL_NATIVE_SOURCES
  src/application_host.cpp
  src/application_host.h
  src/file_store.cpp
  src/file_store.h
  src/process.cpp
  src/process.h
  src/resource_check.cpp
  src/resource_check.h
)

qt_add_library(omamail_native STATIC)
qt_add_qml_module(omamail_native
  URI Omamail.Native
  VERSION 1.0
  OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/qml/Omamail/Native"
  SOURCES ${OMAMAIL_NATIVE_SOURCES}
)
target_link_libraries(omamail_native PUBLIC
  Qt6::Core Qt6::Gui Qt6::Qml Qt6::Network)
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

qt_add_executable(omamail-app src/main.cpp)
target_compile_definitions(omamail-app PRIVATE OMAMAIL_APP_VERSION="${PROJECT_VERSION}")
target_link_libraries(omamail-app PRIVATE
  omamail_nativeplugin Qt6::Quick Qt6::QuickControls2)

if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/qml/Main.qml")
  file(GLOB_RECURSE OMAMAIL_STANDALONE_QML CONFIGURE_DEPENDS
    "${CMAKE_CURRENT_SOURCE_DIR}/qml/*.qml"
    "${CMAKE_CURRENT_SOURCE_DIR}/qml/*.js"
    "${CMAKE_CURRENT_SOURCE_DIR}/qml/qmldir")
  qt_add_resources(omamail-app standalone_qml
    PREFIX "/omamail/app"
    BASE "${CMAKE_CURRENT_SOURCE_DIR}/qml"
    FILES ${OMAMAIL_STANDALONE_QML}
  )
endif()

include(CTest)
if(BUILD_TESTING)
  find_package(Python3 REQUIRED COMPONENTS Interpreter)
  function(omamail_native_test name source)
    qt_add_executable(${name} "tests/native/${source}")
    target_link_libraries(${name} PRIVATE omamail_native Qt6::Test)
    add_test(NAME ${name} COMMAND ${name})
  endfunction()

  omamail_native_test(tst_process tst_process.cpp)
  omamail_native_test(tst_settings tst_settings.cpp)
  omamail_native_test(tst_resources tst_resources.cpp)

  target_compile_definitions(tst_process PRIVATE
    PYTHON_EXECUTABLE="${Python3_EXECUTABLE}"
    RPC_BACKEND_FIXTURE="${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/rpc_backend.py")
  set_tests_properties(tst_resources PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen")
endif()
