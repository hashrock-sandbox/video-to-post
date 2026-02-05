#!/usr/bin/env npx tsx
/**
 * video-to-post: 動画からブログポストを自動生成
 *
 * 使い方: npx tsx index.ts <video.mp4>
 */

import "dotenv/config";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { basename, dirname, join } from "path";

function runScript(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`\n${"=".repeat(50)}`);
    console.log(`実行: ${script} ${args.join(" ")}`);
    console.log("=".repeat(50));

    const proc = spawn("npx", ["tsx", script, ...args], {
      stdio: "inherit",
      cwd: dirname(new URL(import.meta.url).pathname),
    });

    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} failed with code ${code}`));
    });
    proc.on("error", reject);
  });
}

async function main(): Promise<void> {
  const videoPath = process.argv[2];

  if (!videoPath) {
    console.log(`
video-to-post: 動画からブログポストを自動生成

使い方:
  npx tsx index.ts <video.mp4>

必要な環境変数:
  GEMINI_API_KEY  Gemini APIキー

処理フロー:
  1. 音声抽出・文字起こし (whisper-cpp) → VTT（タイムスタンプ付き）
  2. フレーム抽出 (ffmpeg) → 時刻付きファイル名
  3. HTML生成 (Gemini API)
     - セクション分割（時刻付き）
     - 各セクションの時刻に近い画像を選定
     - Gemini画像生成で主題を強調
     - HTML出力
`);
    process.exit(1);
  }

  if (!existsSync(videoPath)) {
    console.error(`エラー: ファイルが見つかりません: ${videoPath}`);
    process.exit(1);
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error("エラー: GEMINI_API_KEY環境変数を設定してください");
    process.exit(1);
  }

  const baseName = basename(videoPath, ".mp4");
  const dir = dirname(videoPath) || ".";

  const vttPath = join(dir, `${baseName}.vtt`);
  const framesDir = join(dir, `${baseName}_frames`);
  const outputDir = join(dir, `${baseName}_output`);
  const htmlPath = join(dir, `${baseName}.html`);

  console.log(`
╔════════════════════════════════════════════════╗
║         video-to-post                          ║
║         動画 → ブログポスト変換                 ║
╚════════════════════════════════════════════════╝

入力: ${videoPath}
出力: ${htmlPath}
`);

  // Step 1: 文字起こし（VTT形式）
  await runScript("transcribe.ts", [videoPath]);

  // Step 2: フレーム抽出（時刻付きファイル名）
  await runScript("extract-frames.ts", [videoPath, "100"]);

  // Step 3: HTML生成（画像選定・変換も含む）
  await runScript("generate-html.ts", [vttPath, framesDir]);

  console.log(`
╔════════════════════════════════════════════════╗
║         完了！                                  ║
╚════════════════════════════════════════════════╝

生成ファイル:
  - 文字起こし: ${vttPath}
  - フレーム:   ${framesDir}/
  - 出力画像:   ${outputDir}/
  - HTML:       ${htmlPath}

ブラウザで開く:
  open "${htmlPath}"
`);
}

main().catch((err) => {
  console.error(`\nエラー: ${err.message}`);
  process.exit(1);
});
