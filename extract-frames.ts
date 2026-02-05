#!/usr/bin/env npx tsx
/**
 * MP4動画からフレーム画像を抽出するスクリプト
 * ファイル名に時刻を含める（例: frame_01_30_00.jpg = 1時間30分0秒）
 */

import { spawn } from "child_process";
import { existsSync, mkdirSync, readdirSync, renameSync } from "fs";
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

async function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ]);

    let output = "";
    proc.stdout.on("data", (data) => (output += data));
    proc.on("close", (code) => {
      if (code === 0) resolve(parseFloat(output.trim()));
      else reject(new Error("ffprobe failed"));
    });
    proc.on("error", reject);
  });
}

function secondsToTimecode(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h.toString().padStart(2, "0")}_${m.toString().padStart(2, "0")}_${s.toString().padStart(2, "0")}`;
}

async function extractFrames(
  videoPath: string,
  outputDir: string,
  targetFrames: number = 100
): Promise<string[]> {
  console.log(`フレーム抽出中: ${videoPath}`);

  // 出力ディレクトリ作成
  mkdirSync(outputDir, { recursive: true });

  // 動画の長さを取得
  const duration = await getVideoDuration(videoPath);
  console.log(`動画長: ${Math.floor(duration)}秒`);

  // フレームレート計算（targetFrames枚になるように）
  const fps = targetFrames / duration;
  const interval = duration / targetFrames;
  console.log(`抽出レート: ${fps.toFixed(3)} fps (目標${targetFrames}枚)`);

  // ffmpegでフレーム抽出（一時的に連番で）
  const tempPattern = join(outputDir, "temp_%04d.jpg");
  await runCommand("ffmpeg", [
    "-i", videoPath,
    "-vf", `fps=${fps}`,
    "-q:v", "2",
    "-y",
    tempPattern,
  ]);

  // ファイル名を時刻付きにリネーム
  const tempFiles = readdirSync(outputDir)
    .filter((f) => f.startsWith("temp_") && f.endsWith(".jpg"))
    .sort();

  const files: string[] = [];
  for (let i = 0; i < tempFiles.length; i++) {
    const seconds = i * interval;
    const timecode = secondsToTimecode(seconds);
    const oldPath = join(outputDir, tempFiles[i]);
    const newPath = join(outputDir, `frame_${timecode}.jpg`);
    renameSync(oldPath, newPath);
    files.push(newPath);
  }

  console.log(`抽出完了: ${files.length}枚`);
  return files;
}

async function main(): Promise<void> {
  const videoPath = process.argv[2];
  const targetFrames = parseInt(process.argv[3] || "100", 10);

  if (!videoPath) {
    console.log("使い方: npx tsx extract-frames.ts <video.mp4> [枚数=100]");
    process.exit(1);
  }

  if (!existsSync(videoPath)) {
    console.error(`エラー: ファイルが見つかりません: ${videoPath}`);
    process.exit(1);
  }

  const baseName = basename(videoPath, ".mp4");
  const dir = dirname(videoPath) || ".";
  const outputDir = join(dir, `${baseName}_frames`);

  const files = await extractFrames(videoPath, outputDir, targetFrames);

  console.log(`\n完了！`);
  console.log(`出力先: ${outputDir}`);
  console.log(`枚数: ${files.length}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
