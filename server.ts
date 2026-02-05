#!/usr/bin/env npx tsx
/**
 * video-to-post API Server
 * Honoベースのサーバー + Drizzle ORM + SQLite
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
  rmSync,
  readdirSync,
  readFileSync,
  createWriteStream,
} from "fs";
import { join, dirname } from "path";
import archiver from "archiver";
import { randomUUID } from "crypto";
import {
  db,
  getProjectDir,
  getAllProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  PROJECTS_DIR,
} from "./db/index.js";

const app = new Hono();

// CORSを有効化
app.use("*", cors());

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

// プロジェクト一覧
app.get("/api/projects", async (c) => {
  const projects = await getAllProjects();
  return c.json(projects);
});

// プロジェクト詳細
app.get("/api/projects/:id", async (c) => {
  const project = await getProject(c.req.param("id"));
  if (!project) {
    return c.json({ error: "プロジェクトが見つかりません" }, 404);
  }
  return c.json(project);
});

// 動画アップロード（新規プロジェクト作成）
app.post("/api/projects/upload", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return c.json({ error: "ファイルが指定されていません" }, 400);
  }

  // プロジェクトID生成
  const projectId = randomUUID();
  const projectDir = getProjectDir(projectId);

  // プロジェクトディレクトリ作成
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(projectDir, "frames"), { recursive: true });
  mkdirSync(join(projectDir, "output"), { recursive: true });

  // 動画ファイル保存
  const videoPath = join(projectDir, "video.mp4");
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const writeStream = createWriteStream(videoPath);
  writeStream.write(buffer);
  writeStream.end();

  await new Promise<void>((resolve, reject) => {
    writeStream.on("finish", resolve);
    writeStream.on("error", reject);
  });

  // DBにプロジェクト作成
  const now = new Date();
  const project = await createProject({
    id: projectId,
    name: file.name,
    createdAt: now,
    updatedAt: now,
    videoPath: "video.mp4",
    framesDir: "frames",
    outputDir: "output",
    videoSize: buffer.length,
    status: "pending",
  });

  return c.json(project);
});

// プロジェクト削除
app.delete("/api/projects/:id", async (c) => {
  const id = c.req.param("id");
  const project = await getProject(id);

  if (!project) {
    return c.json({ error: "プロジェクトが見つかりません" }, 404);
  }

  // ディレクトリ削除
  const projectDir = getProjectDir(id);
  if (existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }

  // DB削除
  await deleteProject(id);

  return c.json({ success: true });
});

// ステップ実行（SSE）
app.get("/api/projects/:id/run/:step", async (c) => {
  const id = c.req.param("id");
  const step = c.req.param("step");

  const project = await getProject(id);
  if (!project) {
    return c.json({ error: "プロジェクトが見つかりません" }, 404);
  }

  const projectDir = getProjectDir(id);
  const videoPath = join(projectDir, "video.mp4");

  if (!existsSync(videoPath)) {
    return c.json({ error: "動画ファイルが見つかりません" }, 404);
  }

  return streamSSE(c, async (stream) => {
    const sendMessage = async (type: string, data: string) => {
      await stream.writeSSE({
        data: JSON.stringify({ type, data }),
        event: "message",
      });
    };

    try {
      const vttPath = join(projectDir, "video.vtt");
      const framesDir = join(projectDir, "frames");

      switch (step) {
        case "transcribe":
          await updateProject(id, { status: "transcribing" });
          await sendMessage("status", "文字起こし開始...");
          await runScript("transcribe.ts", [videoPath], (data) => {
            sendMessage("output", data);
          });
          await updateProject(id, {
            transcribeCompleted: true,
            vttPath: "video.vtt",
            wavPath: "video.wav",
            status: "pending",
          });
          await sendMessage("status", "文字起こし完了");
          break;

        case "extract":
          await updateProject(id, { status: "extracting" });
          await sendMessage("status", "フレーム抽出開始...");
          await runScript("extract-frames.ts", [videoPath, "100"], (data) => {
            sendMessage("output", data);
          });
          await updateProject(id, {
            extractCompleted: true,
            status: "pending",
          });
          await sendMessage("status", "フレーム抽出完了");
          break;

        case "generate":
          await updateProject(id, { status: "generating" });
          await sendMessage("status", "HTML生成開始...");
          await runScript("generate-html.ts", [vttPath, framesDir], (data) => {
            sendMessage("output", data);
          });
          await updateProject(id, {
            generateCompleted: true,
            htmlPath: "video.html",
            status: "completed",
          });
          await sendMessage("status", "HTML生成完了");
          break;

        case "all":
          // 全ステップ実行
          await updateProject(id, { status: "transcribing" });
          await sendMessage("status", "処理開始: 文字起こし...");
          await runScript("transcribe.ts", [videoPath], (data) => {
            sendMessage("output", data);
          });
          await updateProject(id, {
            transcribeCompleted: true,
            vttPath: "video.vtt",
            wavPath: "video.wav",
          });
          await sendMessage("progress", "33");

          await updateProject(id, { status: "extracting" });
          await sendMessage("status", "処理中: フレーム抽出...");
          await runScript("extract-frames.ts", [videoPath, "100"], (data) => {
            sendMessage("output", data);
          });
          await updateProject(id, { extractCompleted: true });
          await sendMessage("progress", "66");

          await updateProject(id, { status: "generating" });
          await sendMessage("status", "処理中: HTML生成...");
          await runScript("generate-html.ts", [vttPath, framesDir], (data) => {
            sendMessage("output", data);
          });
          await updateProject(id, {
            generateCompleted: true,
            htmlPath: "video.html",
            status: "completed",
          });
          await sendMessage("progress", "100");
          await sendMessage("status", "全処理完了！");
          break;

        default:
          await sendMessage("error", `不明なステップ: ${step}`);
      }

      await sendMessage("done", "完了");
    } catch (err) {
      await updateProject(id, {
        status: "error",
        errorMessage: (err as Error).message,
      });
      await sendMessage("error", (err as Error).message);
    }
  });
});

// 生成されたHTMLを取得
app.get("/api/projects/:id/html", async (c) => {
  const project = await getProject(c.req.param("id"));
  if (!project || !project.htmlPath) {
    return c.json({ error: "HTMLが見つかりません" }, 404);
  }

  const htmlPath = join(getProjectDir(project.id), project.htmlPath);
  if (!existsSync(htmlPath)) {
    return c.json({ error: "HTMLファイルが見つかりません" }, 404);
  }

  const html = readFileSync(htmlPath, "utf-8");
  return c.html(html);
});

// ZIPダウンロード
app.get("/api/projects/:id/download", async (c) => {
  const project = await getProject(c.req.param("id"));
  if (!project) {
    return c.json({ error: "プロジェクトが見つかりません" }, 404);
  }

  const projectDir = getProjectDir(project.id);
  const htmlPath = project.htmlPath ? join(projectDir, project.htmlPath) : null;

  if (!htmlPath || !existsSync(htmlPath)) {
    return c.json({ error: "生成データが見つかりません" }, 404);
  }

  // ZIPを作成
  const archive = archiver("zip", { zlib: { level: 9 } });
  const chunks: Buffer[] = [];

  archive.on("data", (chunk) => chunks.push(chunk));

  // HTMLファイルを追加
  archive.file(htmlPath, { name: "index.html" });

  // 出力画像を追加
  const outputDir = join(projectDir, "output");
  if (existsSync(outputDir)) {
    archive.directory(outputDir, "output");
  }

  // VTTファイルを追加
  if (project.vttPath) {
    const vttPath = join(projectDir, project.vttPath);
    if (existsSync(vttPath)) {
      archive.file(vttPath, { name: "video.vtt" });
    }
  }

  await archive.finalize();

  // すべてのチャンクを結合
  const buffer = Buffer.concat(chunks);

  const safeName = project.name.replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/\.mp4$/i, "");

  return new Response(buffer, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${safeName}.zip"`,
    },
  });
});

// 静的ファイル配信（プロジェクトの出力画像など）
app.get("/data/*", serveStatic({ root: "./" }));

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

    .project-list { display: flex; flex-direction: column; gap: 1rem; }
    .project-card {
      background: white;
      border-radius: 8px;
      padding: 1.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .project-card h3 { color: #1f2937; margin-bottom: 0.5rem; word-break: break-all; }
    .project-card .meta { color: #6b7280; font-size: 0.875rem; margin-bottom: 1rem; }
    .project-card .status-badge {
      display: inline-block;
      padding: 0.25rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 500;
      margin-bottom: 1rem;
    }
    .status-pending { background: #e5e7eb; color: #374151; }
    .status-transcribing, .status-extracting, .status-generating {
      background: #fef3c7; color: #92400e;
    }
    .status-completed { background: #d1fae5; color: #065f46; }
    .status-error { background: #fee2e2; color: #991b1b; }

    .steps { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
    .steps span {
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
    }
    .step-done { background: #d1fae5; color: #065f46; }
    .step-pending { background: #e5e7eb; color: #6b7280; }

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
    <h1>video-to-post</h1>

    <div class="upload-zone" id="upload-zone">
      <input type="file" id="file-input" accept="video/mp4" hidden>
      <p>クリックまたはドラッグで動画をアップロード</p>
      <p style="color: #6b7280; font-size: 0.875rem; margin-top: 0.5rem">MP4ファイル対応</p>
      <div class="progress-bar" id="upload-progress">
        <div class="progress-bar-fill" id="upload-progress-fill"></div>
      </div>
    </div>

    <div class="project-list" id="project-list"></div>
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

      const xhr = new XMLHttpRequest();
      xhr.open('POST', API + '/projects/upload');

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = (e.loaded / e.total) * 100;
          progressFill.style.width = pct + '%';
        }
      };

      xhr.onload = () => {
        progressBar.style.display = 'none';
        fileInput.value = '';
        if (xhr.status === 200) {
          loadProjects();
        } else {
          alert('アップロード失敗');
        }
      };

      xhr.send(formData);
    }

    // プロジェクト一覧読み込み
    async function loadProjects() {
      const res = await fetch(API + '/projects');
      const projects = await res.json();

      const list = document.getElementById('project-list');
      list.innerHTML = projects.reverse().map(p => {
        const statusLabels = {
          pending: '待機中',
          transcribing: '文字起こし中...',
          extracting: 'フレーム抽出中...',
          generating: 'HTML生成中...',
          completed: '完了',
          error: 'エラー'
        };

        return \`
        <div class="project-card" id="card-\${p.id}">
          <h3>\${p.name}</h3>
          <div class="meta">\${formatSize(p.videoSize)} · \${formatDate(p.createdAt)}</div>
          <span class="status-badge status-\${p.status}">\${statusLabels[p.status] || p.status}</span>
          <div class="steps">
            <span class="\${p.transcribeCompleted ? 'step-done' : 'step-pending'}">文字起こし</span>
            <span class="\${p.extractCompleted ? 'step-done' : 'step-pending'}">フレーム抽出</span>
            <span class="\${p.generateCompleted ? 'step-done' : 'step-pending'}">HTML生成</span>
          </div>
          <div class="actions">
            <button class="btn-primary" onclick="runStep('\${p.id}', 'all')" \${isProcessing(p.status) ? 'disabled' : ''}>全処理実行</button>
            <button class="btn-secondary" onclick="runStep('\${p.id}', 'transcribe')" \${isProcessing(p.status) ? 'disabled' : ''}>文字起こし</button>
            <button class="btn-secondary" onclick="runStep('\${p.id}', 'extract')" \${isProcessing(p.status) ? 'disabled' : ''}>フレーム抽出</button>
            <button class="btn-secondary" onclick="runStep('\${p.id}', 'generate')" \${isProcessing(p.status) ? 'disabled' : ''}>HTML生成</button>
            \${p.generateCompleted ? \`
              <button class="btn-secondary" onclick="previewHtml('\${p.id}')">プレビュー</button>
              <button class="btn-secondary" onclick="downloadZip('\${p.id}')">ZIPダウンロード</button>
            \` : ''}
            <button class="btn-danger" onclick="deleteProject('\${p.id}')">削除</button>
          </div>
          <div class="output-log" id="log-\${p.id}"></div>
        </div>
      \`}).join('');
    }

    function isProcessing(status) {
      return ['transcribing', 'extracting', 'generating'].includes(status);
    }

    // ステップ実行
    async function runStep(id, step) {
      const logEl = document.getElementById('log-' + id);
      logEl.style.display = 'block';
      logEl.textContent = '処理開始...\\n';

      const eventSource = new EventSource(API + '/projects/' + id + '/run/' + step);

      eventSource.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'output' || msg.type === 'status') {
          logEl.textContent += msg.data;
          logEl.scrollTop = logEl.scrollHeight;
        }
        if (msg.type === 'done' || msg.type === 'error') {
          eventSource.close();
          loadProjects();
        }
      };

      eventSource.onerror = () => {
        eventSource.close();
        loadProjects();
      };
    }

    // 削除
    async function deleteProject(id) {
      if (!confirm('削除しますか？関連するすべてのファイルが削除されます。')) return;
      await fetch(API + '/projects/' + id, { method: 'DELETE' });
      loadProjects();
    }

    // プレビュー
    function previewHtml(id) {
      document.getElementById('modal-title').textContent = 'プレビュー';
      document.getElementById('preview-frame').src = API + '/projects/' + id + '/html';
      document.getElementById('preview-modal').classList.add('active');
    }

    function closeModal() {
      document.getElementById('preview-modal').classList.remove('active');
      document.getElementById('preview-frame').src = '';
    }

    // ZIPダウンロード
    function downloadZip(id) {
      window.location.href = API + '/projects/' + id + '/download';
    }

    // ユーティリティ
    function formatSize(bytes) {
      if (!bytes) return '-';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
      return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
    }

    function formatDate(timestamp) {
      if (!timestamp) return '-';
      // タイムスタンプが秒単位の場合は1000倍する
      const date = new Date(typeof timestamp === 'number' && timestamp < 10000000000 ? timestamp * 1000 : timestamp);
      return date.toLocaleString('ja-JP');
    }

    // 初期読み込み
    loadProjects();
  </script>
</body>
</html>`;
  return c.html(html);
});

// サーバー起動
const port = parseInt(process.env.PORT || "3000", 10);
console.log(`Server running at http://localhost:${port}`);
serve({ fetch: app.fetch, port });
