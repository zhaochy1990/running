#!/usr/bin/env bash
# Fixes the "tapping a TextField shows a floating IME picker instead of the
# Gboard soft keyboard" bug seen on fresh Pixel/Android 16 AVDs.
#
# Root cause: the AutofillInputMethodServiceProxy and Voice IME hijack focus
# from Gboard. Disabling them restores normal keyboard behavior.
#
# Run after `emulator -avd <name>` boots.

set -euo pipefail

DEVICE="${1:-emulator-5554}"
ADB="${ADB:-adb}"

if ! "$ADB" -s "$DEVICE" shell true >/dev/null 2>&1; then
  echo "error: device $DEVICE not reachable. Try 'adb devices'." >&2
  exit 1
fi

echo "Disabling Autofill IME..."
"$ADB" -s "$DEVICE" shell ime disable \
  com.google.android.gms/.autofill.service.AutofillInputMethodServiceProxy || true

echo "Disabling Voice IME..."
"$ADB" -s "$DEVICE" shell ime disable \
  com.google.android.tts/com.google.android.apps.speech.tts.googletts.settings.asr.voiceime.VoiceInputMethodService || true

echo "Forcing Gboard as default IME..."
"$ADB" -s "$DEVICE" shell ime set \
  com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME

echo "Showing software keyboard even with hardware keyboard plugged..."
"$ADB" -s "$DEVICE" shell settings put secure show_ime_with_hard_keyboard 1

echo "Done. Tap any TextField in your app — Gboard should appear."
