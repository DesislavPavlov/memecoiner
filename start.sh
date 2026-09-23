#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env. Add PUMPPORTAL_API_KEY, then run ./start.sh again."
  exit 1
fi

if [ ! -d node_modules ]; then
  npm install
fi

npm run app
