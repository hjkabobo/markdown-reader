#!/bin/bash
# 啟動 md-reader 本機 markdown 閱讀器
cd "$(dirname "$0")"
echo "啟動 Markdown 閱讀器…"
node server.js
