#!/usr/bin/env bash
# Find which PDFs in a folder mention a pattern (case-insensitive).
# Usage: grep-pdfs.sh <dir> <pattern>
set -euo pipefail
DIR="${1:?Usage: grep-pdfs.sh <dir> <pattern>}"
PATTERN="${2:?Usage: grep-pdfs.sh <dir> <pattern>}"
if ! command -v pdftotext >/dev/null 2>&1; then
  echo "pdftotext required (install poppler-utils)." >&2
  exit 127
fi
matches=0
while IFS= read -r -d '' f; do
  if pdftotext -q "$f" - 2>/dev/null | grep -i -q -- "$PATTERN"; then
    echo "MATCH: $f"
    matches=$((matches + 1))
  fi
done < <(find "$DIR" -type f -iname '*.pdf' -print0)
echo "($matches PDF(s) matched \"$PATTERN\")"
