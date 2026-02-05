import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// プロジェクトテーブル
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(), // UUID
  name: text("name").notNull(), // 元のファイル名
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),

  // ファイルパス（プロジェクトディレクトリからの相対パス）
  videoPath: text("video_path"), // video.mp4
  wavPath: text("wav_path"), // video.wav
  vttPath: text("vtt_path"), // video.vtt
  htmlPath: text("html_path"), // video.html
  framesDir: text("frames_dir"), // frames/
  outputDir: text("output_dir"), // output/

  // ファイルサイズ
  videoSize: integer("video_size"),

  // 処理状態
  status: text("status", {
    enum: ["pending", "transcribing", "extracting", "generating", "completed", "error"],
  })
    .notNull()
    .default("pending"),
  errorMessage: text("error_message"),

  // 各ステップの完了状態
  transcribeCompleted: integer("transcribe_completed", { mode: "boolean" })
    .notNull()
    .default(false),
  extractCompleted: integer("extract_completed", { mode: "boolean" })
    .notNull()
    .default(false),
  generateCompleted: integer("generate_completed", { mode: "boolean" })
    .notNull()
    .default(false),
});

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
