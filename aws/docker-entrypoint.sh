#!/bin/sh
set -e

export PAPERCLIP_HOME=/paperclip
export HOST=0.0.0.0
export PORT=3100

if [ ! -f /paperclip/instances/default/config.json ]; then
  echo "First boot: configuring Paperclip..."
  paperclipai onboard --yes || true
fi

exec paperclipai run
