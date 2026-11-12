#!/bin/sh
set -eu

rm -rf dist
mkdir -p dist
cp -r www/. dist/
cp -r server dist/server
cp -r src dist/src
rm -f dist/server/research/submissions.json
cp package.json dist/package.json
cp run.sh dist/run.sh
chmod +x dist/run.sh
