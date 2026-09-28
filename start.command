#!/bin/zsh
set -e
cd "${0:A:h}"
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js 22.13 이상을 설치한 뒤 다시 실행해주세요.'
  exit 1
fi
if [[ ! -d node_modules ]]; then
  npm install
fi
npm run build
npm start
