#!/bin/bash
set -e

echo "=== video-to-post セットアップ ==="

# Homebrew確認
if ! command -v brew &> /dev/null; then
  echo "エラー: Homebrewがインストールされていません"
  echo "https://brew.sh からインストールしてください"
  exit 1
fi

# ffmpeg
if ! command -v ffmpeg &> /dev/null; then
  echo "ffmpegをインストール中..."
  brew install ffmpeg
else
  echo "✓ ffmpeg インストール済み"
fi

# whisper-cpp
if ! command -v whisper-cli &> /dev/null; then
  echo "whisper-cppをインストール中..."
  brew install whisper-cpp
else
  echo "✓ whisper-cpp インストール済み"
fi

# モデルダウンロード
MODEL_DIR="/opt/homebrew/share/whisper-cpp/models"
MODEL_PATH="$MODEL_DIR/ggml-large-v3-turbo.bin"

if [ ! -f "$MODEL_PATH" ]; then
  echo "Whisperモデルをダウンロード中..."
  mkdir -p "$MODEL_DIR"
  curl -L "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin" \
    -o "$MODEL_PATH"
else
  echo "✓ Whisperモデル ダウンロード済み"
fi

# npm依存
echo "npm依存をインストール中..."
npm install

echo ""
echo "=== セットアップ完了 ==="
echo "使い方: npx tsx transcribe.ts <video.mp4>"
