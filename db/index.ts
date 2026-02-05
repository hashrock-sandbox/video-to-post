import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { projects } from "./schema.js";
import { eq } from "drizzle-orm";
import { mkdirSync } from "fs";

// データディレクトリ
export const DATA_DIR = "./data";
export const PROJECTS_DIR = `${DATA_DIR}/projects`;

// ディレクトリ作成
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(PROJECTS_DIR, { recursive: true });

// DB接続
const sqlite = new Database(`${DATA_DIR}/video-to-post.db`);
export const db = drizzle(sqlite);

// マイグレーション（テーブル作成）
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    video_path TEXT,
    wav_path TEXT,
    vtt_path TEXT,
    html_path TEXT,
    frames_dir TEXT,
    output_dir TEXT,
    video_size INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    transcribe_completed INTEGER NOT NULL DEFAULT 0,
    extract_completed INTEGER NOT NULL DEFAULT 0,
    generate_completed INTEGER NOT NULL DEFAULT 0
  )
`);

// プロジェクトのパスを取得
export function getProjectDir(projectId: string): string {
  return `${PROJECTS_DIR}/${projectId}`;
}

// ヘルパー関数
export async function getAllProjects() {
  return db.select().from(projects).orderBy(projects.createdAt);
}

export async function getProject(id: string) {
  const result = await db.select().from(projects).where(eq(projects.id, id));
  return result[0] || null;
}

export async function createProject(project: typeof projects.$inferInsert) {
  await db.insert(projects).values(project);
  return getProject(project.id);
}

export async function updateProject(
  id: string,
  data: Partial<typeof projects.$inferInsert>
) {
  await db
    .update(projects)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(projects.id, id));
  return getProject(id);
}

export async function deleteProject(id: string) {
  await db.delete(projects).where(eq(projects.id, id));
}
