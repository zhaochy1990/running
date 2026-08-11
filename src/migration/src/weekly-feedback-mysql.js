function normalizeRows(rows) {
  return rows.map((row) => ({
    ...row,
    week_start: row.week_start instanceof Date ? row.week_start.toISOString().slice(0, 10) : String(row.week_start),
  }));
}

export function createWeeklyFeedbackTarget(connection) {
  const getIdentity = async () => {
    const [rows] = await connection.execute(
      "SELECT DATABASE() AS database_name, @@server_uuid AS server_uuid",
    );
    const row = rows[0] ?? {};
    return { database_name: String(row.database_name ?? ""), server_uuid: String(row.server_uuid ?? "") };
  };
  const listWeeklyFeedbackWithLock = async (userId, forUpdate) => {
    const [rows] = await connection.execute(
      "SELECT user_id, DATE_FORMAT(week_start, '%Y-%m-%d') AS week_start, content_md, " +
        "DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at, " +
        "DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s.%f') AS updated_at " +
        `FROM weekly_feedback WHERE user_id = ? ORDER BY week_start${forUpdate ? " FOR UPDATE" : ""}`,
      [userId],
    );
    return normalizeRows(rows);
  };
  const listWeeklyFeedback = (userId) => listWeeklyFeedbackWithLock(userId, false);
  const insertWeeklyFeedback = async (row) => {
    await connection.execute(
      "INSERT INTO weekly_feedback (user_id, week_start, content_md, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [row.user_id, row.week_start, row.content_md, row.created_at, row.updated_at],
    );
  };
  return {
    getIdentity,
    listWeeklyFeedback,
    async transaction(operation) {
      await connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await connection.beginTransaction();
      try {
        const result = await operation({
          getIdentity,
          listWeeklyFeedback: (userId) => listWeeklyFeedbackWithLock(userId, true),
          insertWeeklyFeedback,
        });
        await connection.commit();
        return result;
      } catch (error) {
        try {
          await connection.rollback();
        } catch (rollbackError) {
          error.cause ??= rollbackError;
        }
        throw error;
      }
    },
  };
}
