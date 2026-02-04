# 実装計画

## アーキテクチャ

```
video.mp4
    │
    ├──► [ffmpeg] ──► audio.wav ──► [whisper-cpp] ──► transcript.txt
    │
    └──► [ffmpeg] ──► frames/*.jpg (100枚)
                          │
                          ▼
                    [Gemini Embedding]
                          │
                          ▼
                    特徴ベクトル分類
                          │
                          ▼
                    選出画像 4枚
                          │
                          ▼
              transcript.txt + 画像4枚
                          │
                          ▼
                    [Gemini API]
                          │
                          ▼
                      output.html
```

## フェーズ

### Phase 1: 音声処理 ✅
- [x] MP4 → WAV変換（ffmpeg）
- [x] WAV → テキスト（whisper-cpp）
- [x] install.sh

### Phase 2: 画像抽出 ✅
- [x] MP4 → JPG連番出力（ffmpeg、動画長から自動計算）
- [x] 出力先: `{basename}_frames/` ディレクトリ

### Phase 3: 画像選定 ✅
- [x] 時間的に4グループに分割
- [x] シャープネス・明るさでスコアリング
- [x] 各グループから最高スコアの画像を選出

### Phase 3.5: 画像変換 (nanobanana) ✅
- [x] Gemini画像生成 (gemini-2.5-flash-preview-05-20)
- [x] スタイル別プロンプト (blog/lp/tutorial)
- [x] 元画像をベースに変換

### Phase 4: コンテンツ分類 ✅
- [x] Geminiでtranscriptを分析
- [x] 動画タイプを判定:
  - `blog`: 一般的な解説・レビュー
  - `lp`: 製品紹介・プロモーション
  - `tutorial`: ハウツー・手順説明

### Phase 5: HTML生成 ✅
- [x] タイプ別スタイル（blog/lp/tutorial）
- [x] Geminiで4セクション構成の記事生成
- [x] 画像配置
- [x] HTML出力
- [x] 統合スクリプト（index.ts）

## ファイル構成

```
video-to-post/
├── transcribe.ts      # 文字起こし
├── extract-frames.ts  # 画像抽出
├── select-images.ts   # 画像選定
├── generate-html.ts   # HTML生成
├── index.ts           # メインエントリ
├── templates/
│   ├── blog.html
│   ├── lp.html
│   └── tutorial.html
└── output/
    ├── frames/
    ├── selected/
    └── post.html
```

## API

### Gemini

```typescript
// 画像埋め込み
const embedding = await gemini.embedContent({
  model: "embedding-001",
  content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: base64 } }] }
});

// 記事生成
const result = await gemini.generateContent({
  model: "gemini-2.0-flash",
  contents: [{ parts: [
    { text: prompt },
    { text: transcript },
    { inlineData: { mimeType: "image/jpeg", data: img1 } },
    // ...
  ]}]
});
```

## 次のステップ

1. Phase 2: `extract-frames.ts` を実装
2. Gemini API SDKをインストール (`npm install @google/generative-ai`)
