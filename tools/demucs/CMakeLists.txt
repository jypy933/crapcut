# Builds CrapCut's voice separator on top of demucs.cpp (MIT, https://github.com/sevagh/demucs.cpp)
# for Windows with MSVC, without patching the upstream sources:
#   cmake -S tools/demucs -B build-demucs -DDEMUCS_DIR=<checkout> -DDEMUCS_ARCH=AVX2
#   cmake --build build-demucs --config Release
# Static C runtime and no OpenMP, so the exe needs no extra DLLs. Parallelism
# comes from splitting the audio across threads (demucs.cpp threaded_inference).
cmake_minimum_required(VERSION 3.20)
project(crapcut_demucs C CXX)

set(DEMUCS_DIR "" CACHE PATH "Path to a demucs.cpp checkout (with vendor submodules)")
set(DEMUCS_ARCH "AVX2" CACHE STRING "MSVC /arch value: AVX2, AVX or SSE2")
if(NOT EXISTS "${DEMUCS_DIR}/src")
  message(FATAL_ERROR "Set DEMUCS_DIR to a demucs.cpp checkout")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")
add_compile_options(/O2 /Ob2 /fp:fast /EHsc /bigobj /utf-8 /W0 /DNDEBUG /D_CRT_SECURE_NO_WARNINGS)
if(NOT DEMUCS_ARCH STREQUAL "SSE2")
  add_compile_options(/arch:${DEMUCS_ARCH})
endif()

file(GLOB DEMUCS_SOURCES "${DEMUCS_DIR}/src/*.cpp")
add_library(demucs STATIC ${DEMUCS_SOURCES})
target_include_directories(demucs PUBLIC "${DEMUCS_DIR}/vendor/eigen" "${DEMUCS_DIR}/src")

set(LIBNYQUIST_BUILD_EXAMPLE OFF CACHE BOOL "" FORCE)
add_subdirectory("${DEMUCS_DIR}/vendor/libnyquist" libnyquist EXCLUDE_FROM_ALL)

add_executable(crapcut-separate crapcut_separate.cpp)
target_include_directories(crapcut-separate PRIVATE "${DEMUCS_DIR}/vendor/libnyquist/include" "${DEMUCS_DIR}/cli-apps")
target_link_libraries(crapcut-separate PRIVATE demucs libnyquist)
