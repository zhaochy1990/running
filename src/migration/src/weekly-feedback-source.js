import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

function sqlitePath(dataDir, userId) {
  return join(dataDir, userId, "coros.db");
}

export function makeWeeklyFeedbackSource(dataDir) {
  return {
    async listSQLite(userId) {
      const path = sqlitePath(dataDir, userId);
      if (!existsSync(path)) return [];
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'weekly_feedback'").get();
        if (!table) return [];
        return db.prepare("SELECT week, content_md, created_at, updated_at FROM weekly_feedback").all()
          .map((row) => ({ ...row }));
      } finally {
        db.close();
      }
    },

    async listMarkdown(userId) {
      const logs = join(dataDir, userId, "logs");
      if (!existsSync(logs)) return [];
      const rows = [];
      for (const folder of readdirSync(logs)) {
        const path = join(logs, folder, "feedback.md");
        if (!existsSync(path)) continue;
        const metadata = statSync(path);
        if (!metadata.isFile()) continue;
        rows.push({
          folder,
          name: join(userId, "logs", folder, "feedback.md"),
          text: readFileSync(path, "utf8"),
          lastModified: metadata.mtime,
        });
      }
      return rows;
    },
  };
}
