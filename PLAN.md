# 実装計画

## アーキテクチャ

```
video.mp4
    │
    ├──► [ffmpeg] ──► audio.wav ──► [whisper-cpp] ──► transcript.vtt (タイムスタンプ付き)
    │
    └──► [ffmpeg] ──► frames/frame_HH_MM_SS.jpg (時刻付きファイル名、100枚)
                          │
                          ▼
              transcript.vtt + frames/
                          │
                          ▼
                    [Gemini API]
                     ├── コンテンツタイプ判定
                     ├── 4セクション生成（時刻・画像プロンプト付き）
                     │
                     ▼
              各セクションの時刻に近い画像を選定
                     │
                     ▼
              [Gemini 2.5 Flash Image]
              主題を強調した画像に変換
                     │
                     ▼
                 output.html
```

## フェーズ

### Phase 1: 音声処理 ✅
- [x] MP4 → WAV変換（ffmpeg）
- [x] WAV → VTT（whisper-cpp、タイムスタンプ付き）
- [x] install.sh

### Phase 2: 画像抽出 ✅
- [x] MP4 → JPG連番出力（ffmpeg）
- [x] 時刻付きファイル名（frame_HH_MM_SS.jpg）
- [x] 出力先: `{basename}_frames/` ディレクトリ

### Phase 3: HTML生成（統合） ✅
- [x] VTT解析
- [x] コンテンツタイプ判定（blog/lp/tutorial）
- [x] 4セクション生成（時刻・画像プロンプト付き）
- [x] 各セクションの時刻に近い画像を選定（シャープネス分析）
- [x] Gemini画像生成で主題を強調した画像に変換
- [x] HTML出力（タイムスタンプ表示）

## ファイル構成

```
video-to-post/
├── index.ts           # メインエントリ
├── transcribe.ts      # 文字起こし（VTT出力）
├── extract-frames.ts  # 画像抽出（時刻付きファイル名）
├── generate-html.ts   # HTML生成（画像選定・変換含む）
├── install.sh         # セットアップスクリプト
├── .env               # GEMINI_API_KEY
└── output/
    ├── {name}.vtt           # 文字起こし
    ├── {name}_frames/       # 抽出フレーム(100枚)
    │   ├── frame_00_00_00.jpg
    │   ├── frame_00_00_57.jpg
    │   └── ...
    ├── {name}_output/       # 変換済み画像
    │   ├── section_1.png
    │   ├── section_2.png
    │   ├── section_3.png
    │   └── section_4.png
    └── {name}.html          # 最終出力
```

## 使い方

```bash
# セットアップ
./install.sh

# 実行
npx tsx index.ts video.mp4

# または個別実行
npx tsx transcribe.ts video.mp4
npx tsx extract-frames.ts video.mp4 100
npx tsx generate-html.ts video.vtt video_frames
```
