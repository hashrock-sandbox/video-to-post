#!/usr/bin/env npx tsx
/**
 * MP4動画からMP3を抽出し、whisper.cppで文字起こしを行うスクリプト
 * タイムスタンプ付きVTT形式で出力
 *
 * 必要: brew install whisper-cpp ffmpeg
 */

import { spawn } from "child_process";
import { existsSync } from "fs";
import { basename, dirname, join } from "path";

function runCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: "inherit" });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    proc.on("error", reject);
  });
}

async function extractAudio(videoPath: string, wavPath: string): Promise<void> {
  console.log(`音声抽出中: ${videoPath} -> ${wavPath}`);

  // whisper.cppは16kHz WAVが必要
  await runCommand("ffmpeg", [
    "-i", videoPath,
    "-ar", "16000",
    "-ac", "1",
    "-c:a", "pcm_s16le",
    "-y",
    wavPath,
  ]);

  console.log("音声抽出完了");
}

async function transcribe(wavPath: string, outputBase: string): Promise<void> {
  console.log(`文字起こし中: ${wavPath}`);

  // whisper-cli（Homebrew版whisper-cpp）
  // -ovtt: VTT形式（タイムスタンプ付き）
  await runCommand("whisper-cli", [
    "-m", "/opt/homebrew/share/whisper-cpp/models/ggml-large-v3-turbo.bin",
    "-l", "ja",
    "-ovtt",
    "-of", outputBase,
    wavPath,
  ]);

  console.log("文字起こし完了");
}

async function main(): Promise<void> {
  const videoPath = process.argv[2];

  if (!videoPath) {
    console.log("使い方: npx tsx transcribe.ts <video.mp4>");
    console.log("\n必要なツール:");
    console.log("  brew install whisper-cpp ffmpeg");
    console.log("  whisper-cpp-download-ggml-model large-v3-turbo");
    process.exit(1);
  }

  if (!existsSync(videoPath)) {
    console.error(`エラー: ファイルが見つかりません: ${videoPath}`);
    process.exit(1);
  }

  const baseName = basename(videoPath, ".mp4");
  const dir = dirname(videoPath) || ".";
  const wavPath = join(dir, `${baseName}.wav`);
  const outputBase = join(dir, baseName);

  await extractAudio(videoPath, wavPath);
  await transcribe(wavPath, outputBase);

  console.log(`\n完了！`);
  console.log(`文字起こし: ${outputBase}.vtt`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
