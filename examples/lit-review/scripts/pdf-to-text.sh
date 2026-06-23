#!/usr/bin/env bash
# Extract text from a single PDF and print up to maxChars characters.
# Usage: pdf-to-text.sh <file.pdf> [maxChars]
set -euo pipefail
FILE="${1:?Usage: pdf-to-text.sh <file.pdf> [maxChars]}"
MAX="${2:-6000}"
if [ ! -f "$FILE" ]; then
  echo "No such file: $FILE" >&2
  exit 1
fi
if ! command -v pdftotext >/dev/null 2>&1; then
  echo "pdftotext not found. Install poppler-utils:" >&2
  echo "  Debian/Ubuntu: apt-get install -y poppler-utils" >&2
  echo "  macOS:         brew install poppler" >&2
  exit 127
fi
echo "=== text of $FILE (first $MAX chars) ==="
pdftotext -q "$FILE" - | head -c "$MAX"
echo
