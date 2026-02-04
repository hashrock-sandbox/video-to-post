#!/usr/bin/env npx tsx
/**
 * video-to-post: 動画からブログポストを自動生成
 *
 * 使い方: npx tsx index.ts <video.mp4>
 */

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
  1. 音声抽出・文字起こし (whisper-cpp)
  2. フレーム抽出 (ffmpeg)
  3. 画像選定 (シャープネス分析)
  4. HTML生成 (Gemini API)
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

  const wavPath = join(dir, `${baseName}.wav`);
  const transcriptPath = join(dir, `${baseName}.txt`);
  const framesDir = join(dir, `${baseName}_frames`);
  const selectedDir = join(dir, `${baseName}_selected`);
  const htmlPath = join(dir, `${baseName}.html`);

  console.log(`
╔════════════════════════════════════════════════╗
║         video-to-post                          ║
║         動画 → ブログポスト変換                 ║
╚════════════════════════════════════════════════╝

入力: ${videoPath}
出力: ${htmlPath}
`);

  // Step 1: 文字起こし
  await runScript("transcribe.ts", [videoPath]);

  // Step 2: フレーム抽出
  await runScript("extract-frames.ts", [videoPath, "100"]);

  // Step 3: 画像選定
  await runScript("select-images.ts", [framesDir, "4"]);

  // Step 4: HTML生成
  await runScript("generate-html.ts", [transcriptPath, selectedDir]);

  console.log(`
╔════════════════════════════════════════════════╗
║         完了！                                  ║
╚════════════════════════════════════════════════╝

生成ファイル:
  - 文字起こし: ${transcriptPath}
  - 選出画像:   ${selectedDir}/
  - HTML:       ${htmlPath}

ブラウザで開く:
  open "${htmlPath}"
`);
}

main().catch((err) => {
  console.error(`\nエラー: ${err.message}`);
  process.exit(1);
});
