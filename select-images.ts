#!/usr/bin/env npx tsx
/**
 * 抽出したフレームから代表的な4枚を選出するスクリプト
 * - 時間的に4分割してバランスよく選出
 * - シャープネス・明るさでスコアリング
 */

import { readdirSync, mkdirSync, copyFileSync } from "fs";
import { join, basename } from "path";
import sharp from "sharp";

interface ImageScore {
  path: string;
  sharpness: number;
  brightness: number;
  score: number;
}

async function analyzeImage(imagePath: string): Promise<ImageScore> {
  const image = sharp(imagePath);
  const { data, info } = await image
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // 明るさ（平均輝度）
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i];
  }
  const brightness = sum / data.length / 255;

  // シャープネス（ラプラシアン分散の近似）
  let variance = 0;
  const width = info.width;
  for (let i = 1; i < data.length - 1; i++) {
    if (i % width === 0 || i % width === width - 1) continue;
    const laplacian = -4 * data[i] + data[i - 1] + data[i + 1] + data[i - width] + data[i + width];
    variance += laplacian * laplacian;
  }
  const sharpness = Math.sqrt(variance / data.length) / 255;

  // スコア計算
  // - 明るさは0.3-0.7が理想
  // - シャープネスは高いほど良い
  const brightnessPenalty = Math.abs(brightness - 0.5) * 2;
  const score = sharpness * (1 - brightnessPenalty);

  return { path: imagePath, sharpness, brightness, score };
}

async function selectBestImages(
  framesDir: string,
  outputDir: string,
  numImages: number = 4
): Promise<string[]> {
  console.log(`画像分析中: ${framesDir}`);

  // 画像一覧取得
  const files = readdirSync(framesDir)
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .map((f) => join(framesDir, f));

  if (files.length === 0) {
    throw new Error("画像が見つかりません");
  }

  console.log(`対象画像: ${files.length}枚`);

  // 全画像を分析
  const scores: ImageScore[] = [];
  for (let i = 0; i < files.length; i++) {
    if (i % 10 === 0) {
      process.stdout.write(`\r分析中: ${i + 1}/${files.length}`);
    }
    const score = await analyzeImage(files[i]);
    scores.push(score);
  }
  console.log(`\r分析完了: ${files.length}枚`);

  // 時間的にnumImages個のグループに分割
  const groupSize = Math.ceil(files.length / numImages);
  const selected: string[] = [];

  for (let g = 0; g < numImages; g++) {
    const start = g * groupSize;
    const end = Math.min(start + groupSize, files.length);
    const group = scores.slice(start, end);

    // グループ内で最高スコアの画像を選出
    const best = group.reduce((a, b) => (a.score > b.score ? a : b));
    selected.push(best.path);

    console.log(
      `グループ${g + 1}: ${basename(best.path)} ` +
        `(score=${best.score.toFixed(3)}, sharp=${best.sharpness.toFixed(3)}, bright=${best.brightness.toFixed(2)})`
    );
  }

  // 出力ディレクトリにコピー
  mkdirSync(outputDir, { recursive: true });
  const outputPaths: string[] = [];

  for (let i = 0; i < selected.length; i++) {
    const outputPath = join(outputDir, `selected_${i + 1}.jpg`);
    copyFileSync(selected[i], outputPath);
    outputPaths.push(outputPath);
  }

  return outputPaths;
}

async function main(): Promise<void> {
  const framesDir = process.argv[2];
  const numImages = parseInt(process.argv[3] || "4", 10);

  if (!framesDir) {
    console.log("使い方: npx tsx select-images.ts <frames_dir> [枚数=4]");
    process.exit(1);
  }

  const outputDir = framesDir.replace(/_frames$/, "_selected");
  const selected = await selectBestImages(framesDir, outputDir, numImages);

  console.log(`\n完了！`);
  console.log(`出力先: ${outputDir}`);
  selected.forEach((p, i) => console.log(`  ${i + 1}. ${basename(p)}`));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
