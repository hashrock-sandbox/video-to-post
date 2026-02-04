#!/usr/bin/env npx tsx
/**
 * 文字起こしと画像からHTMLブログポストを生成
 * - Geminiでコンテンツタイプ判定
 * - 4セクション構成の記事生成
 */

import "dotenv/config";
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join, basename, dirname } from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

type ContentType = "blog" | "lp" | "tutorial";

interface GeneratedContent {
  type: ContentType;
  title: string;
  sections: {
    heading: string;
    body: string;
    imageIndex: number;
  }[];
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

async function generateArticle(
  transcript: string,
  images: string[],
  contentType: ContentType
): Promise<GeneratedContent> {
  console.log(`記事生成中（タイプ: ${contentType}）...`);

  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  const styleGuide = {
    blog: "読みやすいブログ記事風。親しみやすい口調で、読者に語りかけるように。",
    lp: "魅力的なランディングページ風。ベネフィットを強調し、行動を促す。",
    tutorial: "分かりやすいチュートリアル風。ステップバイステップで丁寧に説明。",
  };

  const prompt = `以下の文字起こしから、${styleGuide[contentType]}のHTMLコンテンツを生成してください。

要件:
- タイトル1つ
- 4つのセクション（各セクションに見出しと本文）
- 各セクションに画像を1枚配置（imageIndex: 0-3）
- JSON形式で出力

文字起こし:
${transcript}

出力形式（このJSON形式で出力）:
{
  "title": "記事タイトル",
  "sections": [
    { "heading": "セクション1見出し", "body": "本文（HTMLタグ可）", "imageIndex": 0 },
    { "heading": "セクション2見出し", "body": "本文", "imageIndex": 1 },
    { "heading": "セクション3見出し", "body": "本文", "imageIndex": 2 },
    { "heading": "セクション4見出し", "body": "本文", "imageIndex": 3 }
  ]
}

JSON:`;

  const result = await model.generateContent(prompt);
  const responseText = result.response.text();

  // JSONを抽出
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("JSON生成に失敗しました");
  }

  const parsed = JSON.parse(jsonMatch[0]);
  return { type: contentType, ...parsed };
}

function buildHTML(content: GeneratedContent, images: string[]): string {
  const templates = {
    blog: { bg: "#ffffff", accent: "#2563eb", font: "serif" },
    lp: { bg: "#f8fafc", accent: "#059669", font: "sans-serif" },
    tutorial: { bg: "#fffbeb", accent: "#d97706", font: "monospace" },
  };

  const style = templates[content.type];

  const sectionsHTML = content.sections
    .map(
      (section, i) => `
    <section class="section">
      <img src="${images[section.imageIndex] || images[i] || ""}" alt="${section.heading}" class="section-image">
      <div class="section-content">
        <h2>${section.heading}</h2>
        <div class="body">${section.body}</div>
      </div>
    </section>`
    )
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
    .section {
      margin-bottom: 3rem;
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
  const transcriptPath = process.argv[2];
  const imagesDir = process.argv[3];

  if (!transcriptPath || !imagesDir) {
    console.log("使い方: npx tsx generate-html.ts <transcript.txt> <selected_images_dir>");
    console.log("例: npx tsx generate-html.ts 'GUITV Vol_4.txt' 'GUITV Vol_4_selected'");
    process.exit(1);
  }

  // 環境変数チェック
  if (!process.env.GEMINI_API_KEY) {
    console.error("エラー: GEMINI_API_KEY環境変数を設定してください");
    process.exit(1);
  }

  // ファイル読み込み
  const transcript = readFileSync(transcriptPath, "utf-8");
  const images = readdirSync(imagesDir)
    .filter((f) => f.endsWith(".jpg") || f.endsWith(".png"))
    .sort()
    .map((f) => join(imagesDir, f));

  console.log(`文字起こし: ${transcript.length}文字`);
  console.log(`画像: ${images.length}枚`);

  // コンテンツタイプ判定
  const contentType = await classifyContent(transcript);
  console.log(`判定結果: ${contentType}`);

  // 記事生成
  const content = await generateArticle(transcript, images, contentType);

  // HTML生成
  const html = buildHTML(content, images);

  // 出力
  const outputPath = transcriptPath.replace(/\.txt$/, ".html");
  writeFileSync(outputPath, html);

  console.log(`\n完了！`);
  console.log(`出力: ${outputPath}`);
  console.log(`タイプ: ${contentType}`);
  console.log(`タイトル: ${content.title}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
