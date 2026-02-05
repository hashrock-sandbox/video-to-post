#!/bin/bash
set -e

echo "=== video-to-post セットアップ ==="

# OS検出
OS="$(uname -s)"
echo "OS: $OS"

# パッケージマネージャー検出・インストール関数
install_package() {
  local pkg="$1"

  if [ "$OS" = "Darwin" ]; then
    if ! command -v brew &> /dev/null; then
      echo "エラー: Homebrewがインストールされていません"
      echo "https://brew.sh からインストールしてください"
      exit 1
    fi
    brew install "$pkg"
  elif [ "$OS" = "Linux" ]; then
    if command -v apt-get &> /dev/null; then
      sudo apt-get update && sudo apt-get install -y "$pkg"
    elif command -v dnf &> /dev/null; then
      sudo dnf install -y "$pkg"
    elif command -v pacman &> /dev/null; then
      sudo pacman -S --noconfirm "$pkg"
    else
      echo "エラー: サポートされているパッケージマネージャーが見つかりません (apt/dnf/pacman)"
      exit 1
    fi
  else
    echo "エラー: サポートされていないOS: $OS"
    exit 1
  fi
}

# ffmpeg
if ! command -v ffmpeg &> /dev/null; then
  echo "ffmpegをインストール中..."
  install_package ffmpeg
else
  echo "✓ ffmpeg インストール済み"
fi

# whisper-cpp
if ! command -v whisper-cli &> /dev/null; then
  echo "whisper-cppをインストール中..."
  if [ "$OS" = "Darwin" ]; then
    if ! command -v brew &> /dev/null; then
      echo "エラー: Homebrewがインストールされていません"
      exit 1
    fi
    brew install whisper-cpp
  elif [ "$OS" = "Linux" ]; then
    echo "whisper-cppをソースからビルドします..."

    # ビルド依存のインストール
    echo "ビルド依存をインストール中..."
    if command -v apt-get &> /dev/null; then
      sudo apt-get update && sudo apt-get install -y git build-essential
    elif command -v dnf &> /dev/null; then
      sudo dnf install -y git gcc-c++ make
    elif command -v pacman &> /dev/null; then
      sudo pacman -S --noconfirm git base-devel
    fi

    # 一時ディレクトリでビルド
    WHISPER_BUILD_DIR="/tmp/whisper-cpp-build"
    rm -rf "$WHISPER_BUILD_DIR"
    git clone --depth 1 https://github.com/ggerganov/whisper.cpp "$WHISPER_BUILD_DIR"
    cd "$WHISPER_BUILD_DIR"

    # CMakeがあればCMakeビルド、なければMakefileビルド
    if command -v cmake &> /dev/null; then
      cmake -B build
      cmake --build build --config Release -j$(nproc)
      sudo cp build/bin/whisper-cli /usr/local/bin/whisper-cli
    else
      make -j$(nproc)
      sudo cp main /usr/local/bin/whisper-cli
    fi

    # クリーンアップ
    cd -
    rm -rf "$WHISPER_BUILD_DIR"
    echo "✓ whisper-cpp ビルド完了"
  fi
else
  echo "✓ whisper-cpp インストール済み"
fi

# モデルディレクトリ設定
if [ "$OS" = "Darwin" ]; then
  MODEL_DIR="/opt/homebrew/share/whisper-cpp/models"
else
  MODEL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/whisper-cpp/models"
fi
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
