#!/bin/sh
# Verify the Termux/Android server build from this machine.
# Needs: rust target aarch64-linux-android + NDK at ~/.android/ndk
# (one-time: rustup target add aarch64-linux-android; NDK r27c lives there now).
set -e
NDK="${ANDROID_NDK_HOME:-$HOME/.android/ndk/android-ndk-r27c}"
TC="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin"
CLANG="$TC/aarch64-linux-android34-clang"
if [ ! -x "$CLANG" ]; then
  echo "missing NDK clang: $CLANG" >&2
  exit 1
fi
export CC_aarch64_linux_android="$CLANG"
export AR_aarch64_linux_android="$TC/llvm-ar"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$CLANG"
exec cargo check --manifest-path src-tauri/Cargo.toml --target aarch64-linux-android "$@"
