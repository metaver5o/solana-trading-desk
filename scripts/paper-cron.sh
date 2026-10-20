#!/bin/bash
# Cron wrapper for the paper forward-test. Runs one round (open new live signals,
# re-price open positions, close on TP/SL/expiry) and appends output to a log.
# Cron has a minimal PATH, so we use absolute paths and cd into the project.

# Override NODE if cron can't find it, e.g. NODE=/opt/homebrew/bin/node.
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${NODE:-$(command -v node || echo /opt/homebrew/bin/node)}"
LOG="$PROJECT/data/paper-cron.log"
mkdir -p "$PROJECT/data"

cd "$PROJECT" || exit 1
echo "===== $(date '+%Y-%m-%d %H:%M:%S') =====" >> "$LOG"
"$NODE" src/paper.js >> "$LOG" 2>&1
