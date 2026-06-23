#!/usr/bin/env bash
# List the PDF files in a folder (default: ./papers), one per line.
# Usage: list-pdfs.sh [dir]
set -euo pipefail
DIR="${1:-./examples/lit-review/papers}"
if [ ! -d "$DIR" ]; then
  echo "No such directory: $DIR" >&2
  exit 1
fi
count=$(find "$DIR" -type f -iname '*.pdf' | wc -l | tr -d ' ')
echo "Found $count PDF(s) in $DIR:"
find "$DIR" -type f -iname '*.pdf' | sort
