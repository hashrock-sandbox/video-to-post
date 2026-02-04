# video-to-post

動画をブログポストに自動変換するツール

## 概要

MP4動画から文字起こしと画像抽出を行い、AIがブログ記事やLPを自動生成します。

## 機能

- **文字起こし**: MP4 → WAV → テキスト（whisper.cpp）
- **画像抽出**: MP4 → フレーム画像（100枚程度）
- **画像選定**: 特徴ベクトルで分類し、代表的な4枚を選出
- **HTML生成**: Gemini APIで記事生成（4セクション構成）

## 出力形式

動画の内容に応じて自動判定：
- ブログ記事風
- LP風
- チュートリアル風

## セットアップ

```bash
./install.sh
```

## 使い方

```bash
npx tsx transcribe.ts <video.mp4>
```

## 必要なもの

- macOS（Apple Silicon）
- ffmpeg
- whisper-cpp
- Node.js
- Gemini API Key
