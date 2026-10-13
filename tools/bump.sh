#!/bin/sh
# Поднять версию приложения: VERSION в sw.js, <meta name="app-version"> и ?v= у файлов в index.html.
# Запускать перед каждым коммитом, который меняет файлы приложения (js, css, index.html).
set -e
cd "$(dirname "$0")/.."
old=$(sed -n "s/^const VERSION = '\([0-9]*\)';/\1/p" sw.js)
new=$((old + 1))
sed -i "s/^const VERSION = '$old';/const VERSION = '$new';/" sw.js
sed -i -e "s/?v=$old\"/?v=$new\"/g" -e "s/name=\"app-version\" content=\"$old\"/name=\"app-version\" content=\"$new\"/" index.html
echo "версия $old → $new"
