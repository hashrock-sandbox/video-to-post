#!/usr/bin/env npx tsx
/**
 * video-to-post API Server
 * Honoベースのサーバー
 */

import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { streamSSE } from "hono/streaming";
import { cors } from "hono/cors";
import { spawn } from "child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  createReadStream,
  createWriteStream,
  readFileSync,
} from "fs";
import { join, basename, dirname } from "path";
import archiver from "archiver";

const app = new Hono();
const UPLOAD_DIR = "./uploads";

// CORSを有効化
app.use("*", cors());

// アップロードディレクトリ作成
mkdirSync(UPLOAD_DIR, { recursive: true });

// 動画一覧を取得
function getVideos(): { id: string; name: string; size: number; createdAt: Date; status: VideoStatus }[] {
  if (!existsSync(UPLOAD_DIR)) return [];

  return readdirSync(UPLOAD_DIR)
    .filter((f) => f.endsWith(".mp4"))
    .map((f) => {
      const fullPath = join(UPLOAD_DIR, f);
      const stat = statSync(fullPath);
      const id = basename(f, ".mp4");
      return {
        id,
        name: f,
        size: stat.size,
        createdAt: stat.birthtime,
        status: getVideoStatus(id),
      };
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

// 動画のステータス
interface VideoStatus {
  hasVtt: boolean;
  hasFrames: boolean;
  hasOutput: boolean;
  hasHtml: boolean;
}

function getVideoStatus(id: string): VideoStatus {
  return {
    hasVtt: existsSync(join(UPLOAD_DIR, `${id}.vtt`)),
    hasFrames: existsSync(join(UPLOAD_DIR, `${id}_frames`)),
    hasOutput: existsSync(join(UPLOAD_DIR, `${id}_output`)),
    hasHtml: existsSync(join(UPLOAD_DIR, `${id}.html`)),
  };
}

// スクリプト実行（ストリーミング出力付き）
function runScript(
  script: string,
  args: string[],
  onOutput: (data: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("npx", ["tsx", script, ...args], {
      cwd: dirname(new URL(import.meta.url).pathname),
    });

    proc.stdout.on("data", (data) => onOutput(data.toString()));
    proc.stderr.on("data", (data) => onOutput(data.toString()));

    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} failed with code ${code}`));
    });
    proc.on("error", reject);
  });
}

// ===== API Routes =====

// 動画一覧
app.get("/api/videos", (c) => {
  return c.json(getVideos());
});

// 動画アップロード（チャンクアップロード対応）
app.post("/api/videos/upload", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return c.json({ error: "ファイルが指定されていません" }, 400);
  }

  const fileName = file.name;
  const filePath = join(UPLOAD_DIR, fileName);

  // ファイルを保存
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const writeStream = createWriteStream(filePath);
  writeStream.write(buffer);
  writeStream.end();

  await new Promise<void>((resolve, reject) => {
    writeStream.on("finish", resolve);
    writeStream.on("error", reject);
  });

  const id = basename(fileName, ".mp4");
  return c.json({
    success: true,
    id,
    name: fileName,
    size: buffer.length,
  });
});

// 動画削除
app.delete("/api/videos/:id", (c) => {
  const id = c.req.param("id");
  const basePath = join(UPLOAD_DIR, id);

  // 関連ファイルを削除
  const toDelete = [
    `${basePath}.mp4`,
    `${basePath}.mp3`,
    `${basePath}.wav`,
    `${basePath}.vtt`,
    `${basePath}.html`,
    `${basePath}_frames`,
    `${basePath}_output`,
  ];

  for (const path of toDelete) {
    if (existsSync(path)) {
      rmSync(path, { recursive: true, force: true });
    }
  }

  return c.json({ success: true });
});

// ステップ実行（SSE）
app.get("/api/videos/:id/run/:step", async (c) => {
  const id = c.req.param("id");
  const step = c.req.param("step");
  const videoPath = join(UPLOAD_DIR, `${id}.mp4`);

  if (!existsSync(videoPath)) {
    return c.json({ error: "動画が見つかりません" }, 404);
  }

  return streamSSE(c, async (stream) => {
    const sendMessage = async (type: string, data: string) => {
      await stream.writeSSE({ data: JSON.stringify({ type, data }), event: "message" });
    };

    try {
      const vttPath = join(UPLOAD_DIR, `${id}.vtt`);
      const framesDir = join(UPLOAD_DIR, `${id}_frames`);

      switch (step) {
        case "transcribe":
          await sendMessage("status", "文字起こし開始...");
          await runScript("transcribe.ts", [videoPath], (data) => {
            sendMessage("output", data);
          });
          await sendMessage("status", "文字起こし完了");
          break;

        case "extract":
          await sendMessage("status", "フレーム抽出開始...");
          await runScript("extract-frames.ts", [videoPath, "100"], (data) => {
            sendMessage("output", data);
          });
          await sendMessage("status", "フレーム抽出完了");
          break;

        case "generate":
          await sendMessage("status", "HTML生成開始...");
          await runScript("generate-html.ts", [vttPath, framesDir], (data) => {
            sendMessage("output", data);
          });
          await sendMessage("status", "HTML生成完了");
          break;

        case "all":
          // 全ステップ実行
          await sendMessage("status", "処理開始: 文字起こし...");
          await runScript("transcribe.ts", [videoPath], (data) => {
            sendMessage("output", data);
          });
          await sendMessage("progress", "33");

          await sendMessage("status", "処理中: フレーム抽出...");
          await runScript("extract-frames.ts", [videoPath, "100"], (data) => {
            sendMessage("output", data);
          });
          await sendMessage("progress", "66");

          await sendMessage("status", "処理中: HTML生成...");
          await runScript("generate-html.ts", [vttPath, framesDir], (data) => {
            sendMessage("output", data);
          });
          await sendMessage("progress", "100");
          await sendMessage("status", "全処理完了！");
          break;

        default:
          await sendMessage("error", `不明なステップ: ${step}`);
      }

      await sendMessage("done", "完了");
    } catch (err) {
      await sendMessage("error", (err as Error).message);
    }
  });
});

// 生成されたHTMLを取得
app.get("/api/videos/:id/html", (c) => {
  const id = c.req.param("id");
  const htmlPath = join(UPLOAD_DIR, `${id}.html`);

  if (!existsSync(htmlPath)) {
    return c.json({ error: "HTMLが見つかりません" }, 404);
  }

  const html = readFileSync(htmlPath, "utf-8");
  return c.html(html);
});

// ZIPダウンロード
app.get("/api/videos/:id/download", async (c) => {
  const id = c.req.param("id");
  const basePath = join(UPLOAD_DIR, id);

  const htmlPath = `${basePath}.html`;
  const outputDir = `${basePath}_output`;

  if (!existsSync(htmlPath)) {
    return c.json({ error: "生成データが見つかりません" }, 404);
  }

  // ZIPを作成
  const archive = archiver("zip", { zlib: { level: 9 } });
  const chunks: Buffer[] = [];

  archive.on("data", (chunk) => chunks.push(chunk));

  // HTMLファイルを追加
  archive.file(htmlPath, { name: `${id}.html` });

  // 出力画像を追加
  if (existsSync(outputDir)) {
    archive.directory(outputDir, `${id}_output`);
  }

  // VTTファイルを追加
  const vttPath = `${basePath}.vtt`;
  if (existsSync(vttPath)) {
    archive.file(vttPath, { name: `${id}.vtt` });
  }

  await archive.finalize();

  // すべてのチャンクを結合
  const buffer = Buffer.concat(chunks);

  return new Response(buffer, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${id}.zip"`,
    },
  });
});

// 出力画像の静的配信
app.get("/uploads/*", serveStatic({ root: "./" }));

// フロントエンド（シンプルなHTML）
app.get("/", (c) => {
  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>video-to-post</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #f3f4f6; min-height: 100vh; }
    .container { max-width: 900px; margin: 0 auto; padding: 2rem; }
    h1 { color: #1f2937; margin-bottom: 2rem; }

    .upload-zone {
      border: 2px dashed #d1d5db;
      border-radius: 8px;
      padding: 3rem;
      text-align: center;
      background: white;
      cursor: pointer;
      transition: border-color 0.2s;
      margin-bottom: 2rem;
    }
    .upload-zone:hover { border-color: #2563eb; }
    .upload-zone.dragover { border-color: #2563eb; background: #eff6ff; }

    .progress-bar {
      width: 100%;
      height: 8px;
      background: #e5e7eb;
      border-radius: 4px;
      margin-top: 1rem;
      display: none;
    }
    .progress-bar-fill {
      height: 100%;
      background: #2563eb;
      border-radius: 4px;
      width: 0%;
      transition: width 0.3s;
    }

    .video-list { display: flex; flex-direction: column; gap: 1rem; }
    .video-card {
      background: white;
      border-radius: 8px;
      padding: 1.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .video-card h3 { color: #1f2937; margin-bottom: 0.5rem; }
    .video-card .meta { color: #6b7280; font-size: 0.875rem; margin-bottom: 1rem; }
    .video-card .status { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
    .video-card .status span {
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
    }
    .status-done { background: #d1fae5; color: #065f46; }
    .status-pending { background: #e5e7eb; color: #6b7280; }

    .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    button {
      padding: 0.5rem 1rem;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.875rem;
      transition: background 0.2s;
    }
    .btn-primary { background: #2563eb; color: white; }
    .btn-primary:hover { background: #1d4ed8; }
    .btn-primary:disabled { background: #93c5fd; cursor: not-allowed; }
    .btn-secondary { background: #e5e7eb; color: #374151; }
    .btn-secondary:hover { background: #d1d5db; }
    .btn-danger { background: #fecaca; color: #991b1b; }
    .btn-danger:hover { background: #fca5a5; }

    .output-log {
      margin-top: 1rem;
      background: #1f2937;
      color: #d1d5db;
      padding: 1rem;
      border-radius: 4px;
      font-family: monospace;
      font-size: 0.75rem;
      max-height: 200px;
      overflow-y: auto;
      white-space: pre-wrap;
      display: none;
    }

    .modal {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.5);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 100;
    }
    .modal.active { display: flex; }
    .modal-content {
      background: white;
      border-radius: 8px;
      width: 90%;
      max-width: 1000px;
      max-height: 90vh;
      overflow: auto;
    }
    .modal-header {
      padding: 1rem;
      border-bottom: 1px solid #e5e7eb;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .modal-body { padding: 0; }
    .modal-body iframe { width: 100%; height: 70vh; border: none; }
  </style>
</head>
<body>
  <div class="container">
    <h1>📹 video-to-post</h1>

    <div class="upload-zone" id="upload-zone">
      <input type="file" id="file-input" accept="video/mp4" hidden>
      <p>クリックまたはドラッグで動画をアップロード</p>
      <p style="color: #6b7280; font-size: 0.875rem; margin-top: 0.5rem">MP4ファイル対応</p>
      <div class="progress-bar" id="upload-progress">
        <div class="progress-bar-fill" id="upload-progress-fill"></div>
      </div>
    </div>

    <div class="video-list" id="video-list"></div>
  </div>

  <div class="modal" id="preview-modal">
    <div class="modal-content">
      <div class="modal-header">
        <h3 id="modal-title">プレビュー</h3>
        <button class="btn-secondary" onclick="closeModal()">閉じる</button>
      </div>
      <div class="modal-body">
        <iframe id="preview-frame"></iframe>
      </div>
    </div>
  </div>

  <script>
    const API = '/api';

    // ファイルアップロード
    const uploadZone = document.getElementById('upload-zone');
    const fileInput = document.getElementById('file-input');
    const progressBar = document.getElementById('upload-progress');
    const progressFill = document.getElementById('upload-progress-fill');

    uploadZone.onclick = () => fileInput.click();

    uploadZone.ondragover = (e) => {
      e.preventDefault();
      uploadZone.classList.add('dragover');
    };
    uploadZone.ondragleave = () => uploadZone.classList.remove('dragover');
    uploadZone.ondrop = (e) => {
      e.preventDefault();
      uploadZone.classList.remove('dragover');
      if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
    };
    fileInput.onchange = () => {
      if (fileInput.files[0]) uploadFile(fileInput.files[0]);
    };

    async function uploadFile(file) {
      progressBar.style.display = 'block';
      progressFill.style.width = '0%';

      const formData = new FormData();
      formData.append('file', file);

      // XHRでアップロード（進捗表示のため）
      const xhr = new XMLHttpRequest();
      xhr.open('POST', API + '/videos/upload');

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = (e.loaded / e.total) * 100;
          progressFill.style.width = pct + '%';
        }
      };

      xhr.onload = () => {
        progressBar.style.display = 'none';
        if (xhr.status === 200) {
          loadVideos();
        } else {
          alert('アップロード失敗');
        }
      };

      xhr.send(formData);
    }

    // 動画一覧読み込み
    async function loadVideos() {
      const res = await fetch(API + '/videos');
      const videos = await res.json();

      const list = document.getElementById('video-list');
      list.innerHTML = videos.map(v => \`
        <div class="video-card" id="card-\${v.id}">
          <h3>\${v.name}</h3>
          <div class="meta">\${formatSize(v.size)} · \${formatDate(v.createdAt)}</div>
          <div class="status">
            <span class="\${v.status.hasVtt ? 'status-done' : 'status-pending'}">文字起こし</span>
            <span class="\${v.status.hasFrames ? 'status-done' : 'status-pending'}">フレーム抽出</span>
            <span class="\${v.status.hasHtml ? 'status-done' : 'status-pending'}">HTML生成</span>
          </div>
          <div class="actions">
            <button class="btn-primary" onclick="runStep('\${v.id}', 'all')">全処理実行</button>
            <button class="btn-secondary" onclick="runStep('\${v.id}', 'transcribe')">文字起こし</button>
            <button class="btn-secondary" onclick="runStep('\${v.id}', 'extract')">フレーム抽出</button>
            <button class="btn-secondary" onclick="runStep('\${v.id}', 'generate')">HTML生成</button>
            \${v.status.hasHtml ? \`
              <button class="btn-secondary" onclick="previewHtml('\${v.id}')">プレビュー</button>
              <button class="btn-secondary" onclick="downloadZip('\${v.id}')">ZIPダウンロード</button>
            \` : ''}
            <button class="btn-danger" onclick="deleteVideo('\${v.id}')">削除</button>
          </div>
          <div class="output-log" id="log-\${v.id}"></div>
        </div>
      \`).join('');
    }

    // ステップ実行
    async function runStep(id, step) {
      const logEl = document.getElementById('log-' + id);
      logEl.style.display = 'block';
      logEl.textContent = '処理開始...\\n';

      const eventSource = new EventSource(API + '/videos/' + id + '/run/' + step);

      eventSource.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'output' || msg.type === 'status') {
          logEl.textContent += msg.data;
          logEl.scrollTop = logEl.scrollHeight;
        }
        if (msg.type === 'done' || msg.type === 'error') {
          eventSource.close();
          loadVideos();
        }
      };

      eventSource.onerror = () => {
        eventSource.close();
        loadVideos();
      };
    }

    // 削除
    async function deleteVideo(id) {
      if (!confirm('削除しますか？')) return;
      await fetch(API + '/videos/' + id, { method: 'DELETE' });
      loadVideos();
    }

    // プレビュー
    function previewHtml(id) {
      document.getElementById('modal-title').textContent = id + '.html';
      document.getElementById('preview-frame').src = API + '/videos/' + id + '/html';
      document.getElementById('preview-modal').classList.add('active');
    }

    function closeModal() {
      document.getElementById('preview-modal').classList.remove('active');
      document.getElementById('preview-frame').src = '';
    }

    // ZIPダウンロード
    function downloadZip(id) {
      window.location.href = API + '/videos/' + id + '/download';
    }

    // ユーティリティ
    function formatSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
      return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
    }

    function formatDate(date) {
      return new Date(date).toLocaleString('ja-JP');
    }

    // 初期読み込み
    loadVideos();
  </script>
</body>
</html>`;
  return c.html(html);
});

// サーバー起動
const port = parseInt(process.env.PORT || "3000", 10);
console.log(`🚀 Server running at http://localhost:${port}`);
serve({ fetch: app.fetch, port });
