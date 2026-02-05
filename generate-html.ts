#!/usr/bin/env npx tsx
/**
 * VTT文字起こしと画像からHTMLブログポストを生成
 * 1. VTT解析 → セクション分割（時刻付き）
 * 2. 各セクションの時刻に近い画像を選定
 * 3. Gemini画像生成で主題を強調した画像に変換
 * 4. HTML出力
 */

import "dotenv/config";
import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync } from "fs";
import { join, basename, dirname } from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const imageAI = new GoogleGenAI({});

type ContentType = "blog" | "lp" | "tutorial";

interface VttCue {
  startTime: number; // 秒
  endTime: number;
  text: string;
}

interface Section {
  heading: string;
  body: string;
  startTime: number;
  imagePrompt: string;
}

interface GeneratedContent {
  type: ContentType;
  title: string;
  sections: Section[];
}

function parseVtt(vttContent: string): VttCue[] {
  const lines = vttContent.split("\n");
  const cues: VttCue[] = [];
  let i = 0;

  // Skip header
  while (i < lines.length && !lines[i].includes("-->")) i++;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.includes("-->")) {
      const [start, end] = line.split("-->").map((t) => {
        const parts = t.trim().split(":");
        if (parts.length === 3) {
          const [h, m, s] = parts;
          return parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s.replace(",", "."));
        }
        const [m, s] = parts;
        return parseInt(m) * 60 + parseFloat(s.replace(",", "."));
      });

      i++;
      let text = "";
      while (i < lines.length && lines[i].trim() && !lines[i].includes("-->")) {
        text += lines[i].trim() + " ";
        i++;
      }
      if (text.trim()) {
        cues.push({ startTime: start, endTime: end, text: text.trim() });
      }
    } else {
      i++;
    }
  }
  return cues;
}

function cuesToText(cues: VttCue[]): string {
  return cues.map((c) => c.text).join(" ");
}

async function classifyContent(transcript: string): Promise<ContentType> {
  console.log("コンテンツタイプを判定中...");
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  const prompt = `以下の文字起こしテキストを分析し、最も適切なコンテンツタイプを1つだけ回答してください。

タイプ:
- blog: 一般的な解説、レビュー、日記、雑談
- lp: 製品紹介、プロモーション、セールス
- tutorial: ハウツー、手順説明、チュートリアル

文字起こし:
${transcript.slice(0, 3000)}

回答（blog/lp/tutorialのいずれか1つのみ）:`;

  const result = await model.generateContent(prompt);
  const response = result.response.text().trim().toLowerCase();

  if (response.includes("tutorial")) return "tutorial";
  if (response.includes("lp")) return "lp";
  return "blog";
}

async function generateSections(
  cues: VttCue[],
  contentType: ContentType
): Promise<GeneratedContent> {
  console.log(`セクション生成中（タイプ: ${contentType}）...`);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  const transcript = cuesToText(cues);
  const duration = cues[cues.length - 1]?.endTime || 0;

  const styleGuide = {
    blog: "読みやすいブログ記事風。親しみやすい口調で。",
    lp: "魅力的なランディングページ風。ベネフィットを強調。",
    tutorial: "分かりやすいチュートリアル風。ステップバイステップで。",
  };

  const prompt = `以下の文字起こし（動画長: ${Math.floor(duration)}秒）から、${styleGuide[contentType]}のコンテンツを生成してください。

要件:
- タイトル1つ
- 4つのセクション
- 各セクションに: 見出し、本文、開始時刻（秒）、画像生成プロンプト
- 画像生成プロンプトは、そのセクションの内容を視覚的に表現する短い英語の説明（例: "Two developers discussing code on a screen"）

文字起こし:
${transcript}

JSON形式で出力:
{
  "title": "記事タイトル",
  "sections": [
    {
      "heading": "セクション見出し",
      "body": "本文（HTMLタグ可）",
      "startTime": 0,
      "imagePrompt": "English description for image generation"
    }
  ]
}

JSON:`;

  const result = await model.generateContent(prompt);
  const responseText = result.response.text();
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("JSON生成に失敗しました");

  const parsed = JSON.parse(jsonMatch[0]);
  return { type: contentType, ...parsed };
}

function timecodeToSeconds(timecode: string): number {
  // frame_01_30_00.jpg -> 5400秒
  const match = timecode.match(/(\d{2})_(\d{2})_(\d{2})/);
  if (!match) return 0;
  return parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]);
}

function findNearestFrame(frames: string[], targetTime: number): string {
  let nearest = frames[0];
  let minDiff = Infinity;

  for (const frame of frames) {
    const frameTime = timecodeToSeconds(basename(frame));
    const diff = Math.abs(frameTime - targetTime);
    if (diff < minDiff) {
      minDiff = diff;
      nearest = frame;
    }
  }
  return nearest;
}

async function analyzeAndSelectBestFrame(
  frames: string[],
  targetTime: number,
  windowSeconds: number = 120
): Promise<string> {
  // 時刻の前後windowSeconds秒の画像を候補として選ぶ
  const candidates = frames.filter((f) => {
    const t = timecodeToSeconds(basename(f));
    return Math.abs(t - targetTime) <= windowSeconds;
  });

  if (candidates.length === 0) {
    return findNearestFrame(frames, targetTime);
  }

  // シャープネスで最良の画像を選ぶ
  let best = candidates[0];
  let bestScore = 0;

  for (const frame of candidates) {
    const { data, info } = await sharp(frame)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let variance = 0;
    const width = info.width;
    for (let i = 1; i < data.length - 1; i++) {
      if (i % width === 0 || i % width === width - 1) continue;
      const laplacian = -4 * data[i] + data[i - 1] + data[i + 1] + data[i - width] + data[i + width];
      variance += laplacian * laplacian;
    }
    const score = Math.sqrt(variance / data.length);

    if (score > bestScore) {
      bestScore = score;
      best = frame;
    }
  }

  return best;
}

async function transformImage(
  imagePath: string,
  prompt: string,
  outputPath: string
): Promise<void> {
  const imageData = readFileSync(imagePath);
  const base64Image = imageData.toString("base64");

  const contents = [
    {
      text: `Transform this image to emphasize: ${prompt}. Make it clean, professional, and visually appealing for a blog post. Keep the main subject but enhance the visual presentation.`,
    },
    {
      inlineData: {
        mimeType: "image/jpeg",
        data: base64Image,
      },
    },
  ];

  const response = await imageAI.models.generateContent({
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

  // 画像生成失敗時は元画像をコピー
  copyFileSync(imagePath, outputPath);
}

function buildHTML(content: GeneratedContent, images: string[]): string {
  const templates = {
    blog: { bg: "#ffffff", accent: "#2563eb", font: "serif" },
    lp: { bg: "#f8fafc", accent: "#059669", font: "sans-serif" },
    tutorial: { bg: "#fffbeb", accent: "#d97706", font: "monospace" },
  };

  const style = templates[content.type];

  const sectionsHTML = content.sections
    .map((section, i) => {
      const time = new Date(section.startTime * 1000).toISOString().substr(11, 8);
      return `
    <section class="section">
      <div class="timestamp">${time}</div>
      <img src="${images[i] || ""}" alt="${section.heading}" class="section-image">
      <div class="section-content">
        <h2>${section.heading}</h2>
        <div class="body">${section.body}</div>
      </div>
    </section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${content.title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: ${style.font}, system-ui, sans-serif;
      background: ${style.bg};
      color: #1f2937;
      line-height: 1.8;
    }
    .container { max-width: 800px; margin: 0 auto; padding: 2rem; }
    h1 {
      font-size: 2.5rem;
      color: ${style.accent};
      margin-bottom: 2rem;
      text-align: center;
    }
    .section { margin-bottom: 3rem; position: relative; }
    .timestamp {
      position: absolute;
      top: 0.5rem;
      right: 0.5rem;
      background: rgba(0,0,0,0.7);
      color: white;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      font-size: 0.8rem;
      font-family: monospace;
    }
    .section-image {
      width: 100%;
      height: 400px;
      object-fit: cover;
      border-radius: 8px;
      margin-bottom: 1.5rem;
    }
    h2 {
      font-size: 1.5rem;
      color: ${style.accent};
      margin-bottom: 1rem;
      border-left: 4px solid ${style.accent};
      padding-left: 1rem;
    }
    .body { font-size: 1.1rem; }
    .body p { margin-bottom: 1rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${content.title}</h1>
    ${sectionsHTML}
  </div>
</body>
</html>`;
}

async function main(): Promise<void> {
  const vttPath = process.argv[2];
  const framesDir = process.argv[3];

  if (!vttPath || !framesDir) {
    console.log("使い方: npx tsx generate-html.ts <transcript.vtt> <frames_dir>");
    process.exit(1);
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error("エラー: GEMINI_API_KEY環境変数を設定してください");
    process.exit(1);
  }

  // VTT解析
  const vttContent = readFileSync(vttPath, "utf-8");
  const cues = parseVtt(vttContent);
  console.log(`VTT解析: ${cues.length}キュー`);

  // フレーム一覧
  const frames = readdirSync(framesDir)
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .map((f) => join(framesDir, f));
  console.log(`フレーム: ${frames.length}枚`);

  // コンテンツタイプ判定
  const contentType = await classifyContent(cuesToText(cues));
  console.log(`判定結果: ${contentType}`);

  // セクション生成
  const content = await generateSections(cues, contentType);
  console.log(`タイトル: ${content.title}`);

  // 出力ディレクトリ
  const outputDir = framesDir.replace(/_frames$/, "_output");
  mkdirSync(outputDir, { recursive: true });

  // 各セクションの画像を選定・変換
  const outputImages: string[] = [];
  for (let i = 0; i < content.sections.length; i++) {
    const section = content.sections[i];
    console.log(`\n[${i + 1}/4] ${section.heading}`);
    console.log(`  時刻: ${section.startTime}秒`);

    // 最適な画像を選定
    const selectedFrame = await analyzeAndSelectBestFrame(frames, section.startTime);
    console.log(`  選定: ${basename(selectedFrame)}`);

    // 画像変換
    const outputPath = join(outputDir, `section_${i + 1}.png`);
    console.log(`  変換中: ${section.imagePrompt}`);
    try {
      await transformImage(selectedFrame, section.imagePrompt, outputPath);
      console.log(`  → ${basename(outputPath)}`);
    } catch (err) {
      console.log(`  変換失敗、元画像を使用`);
      copyFileSync(selectedFrame, outputPath);
    }
    outputImages.push(outputPath);
  }

  // HTML生成
  const html = buildHTML(content, outputImages);
  const htmlPath = vttPath.replace(/\.vtt$/, ".html");
  writeFileSync(htmlPath, html);

  console.log(`\n完了！`);
  console.log(`出力: ${htmlPath}`);
  console.log(`画像: ${outputDir}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
