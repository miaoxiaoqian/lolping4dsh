#!/bin/zsh
# Build the macOS global input helper.
#
# Compiles the pure state machine and the CGEventTap layer into one small
# executable that the desktop host spawns and talks to over stdin/stdout.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/../../build/input-helper}"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "input-helper 只在 macOS 上构建（需要 CGEventTap）。当前：$(uname -s)"
  exit 2
fi

mkdir -p "$(dirname "$OUT")"

/usr/bin/xcrun clang++ \
  -std=c++20 \
  -O2 \
  -arch arm64 \
  -mmacosx-version-min=12.0 \
  -fno-objc-arc \
  -Wall \
  -Wextra \
  -Wno-unused-parameter \
  -framework CoreGraphics \
  -framework CoreFoundation \
  -framework ApplicationServices \
  -o "$OUT" \
  "$HERE/decision.cpp" \
  "$HERE/protocol.cpp" \
  "$HERE/macos_input.cpp"

# Keep the helper's designated identifier stable across builds so macOS does not
# display a new hash-derived `input-helper-…` identity whenever the app is rebuilt.
# The app remains ad-hoc signed unless the release pipeline supplies a Developer ID.
/usr/bin/codesign --force --sign - --identifier com.deepseek.harness.quick-help.input-helper "$OUT"

echo "built $OUT ($(du -h "$OUT" | cut -f1))"
