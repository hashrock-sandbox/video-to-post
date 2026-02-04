#!/usr/bin/env npx tsx
/**
 * 選出画像をGemini画像生成でコンテンツに合った画像に変換
 */

import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "fs";
import { join, basename } from "path";

const ai = new GoogleGenAI({});

async function transformImage(
  imagePath: string,
  prompt: string,
  outputPath: string
): Promise<void> {
  const imageData = readFileSync(imagePath);
  const base64Image = imageData.toString("base64");

  const contents = [
    { text: prompt },
    {
      inlineData: {
        mimeType: "image/jpeg",
        data: base64Image,
      },
    },
  ];

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-image",
    contents,
  });

  for (const part of response.candidates![0].content!.parts!) {
    if (part.inlineData) {
      const buffer = Buffer.from(part.inlineData.data!, "base64");
      writeFileSync(outputPath, buffer);
      return;
    }
  }

  throw new Error("画像が生成されませんでした");
}

async function main(): Promise<void> {
  const selectedDir = process.argv[2];
  const style = process.argv[3] || "blog";

  if (!selectedDir) {
    console.log("使い方: npx tsx transform-images.ts <selected_dir> [style]");
    console.log("style: blog, lp, tutorial");
    process.exit(1);
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error("エラー: GEMINI_API_KEY環境変数を設定してください");
    process.exit(1);
  }

  const stylePrompts: Record<string, string> = {
    blog: "この画像をブログ記事用のクリーンでプロフェッショナルな見た目に変換してください。明るく読みやすい雰囲気で。",
    lp: "この画像をランディングページ用の魅力的でインパクトのある見た目に変換してください。モダンでスタイリッシュに。",
    tutorial: "この画像をチュートリアル用の分かりやすい見た目に変換してください。重要な部分が強調されるように。",
  };

  const prompt = stylePrompts[style] || stylePrompts.blog;

  // 画像一覧取得
  const images = readdirSync(selectedDir)
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .map((f) => join(selectedDir, f));

  // 出力ディレクトリ
  const outputDir = selectedDir.replace(/_selected$/, "_transformed");
  mkdirSync(outputDir, { recursive: true });

  console.log(`画像変換中 (style: ${style})`);
  console.log(`入力: ${selectedDir}`);
  console.log(`出力: ${outputDir}`);

  for (let i = 0; i < images.length; i++) {
    const inputPath = images[i];
    const outputPath = join(outputDir, `transformed_${i + 1}.png`);

    console.log(`\n[${i + 1}/${images.length}] ${basename(inputPath)}`);

    try {
      await transformImage(inputPath, prompt, outputPath);
      console.log(`  → ${basename(outputPath)}`);
    } catch (err) {
      console.error(`  エラー: ${(err as Error).message}`);
    }
  }

  console.log(`\n完了！`);
  console.log(`出力先: ${outputDir}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
