const MASTER_PLAN_COLUMNS = [
  "plan_id",
  "user_id",
  "content_version",
  "content",
  "goal_id",
  "status",
  "active_flag",
  "revision",
  "created_at",
  "updated_at",
];

const RACE_GOAL_COLUMNS = [
  "goal_id",
  "user_id",
  "status",
  "active_flag",
  "race_date",
  "race_distance",
  "race_name",
  "target_finish_time",
  "weekly_training_days",
  "available_time_slots",
  "strength_willingness",
  "race_location",
  "race_timezone",
  "created_at",
  "updated_at",
];

function insertSql(table, columns) {
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
}

function valuesFor(columns, row) {
  return columns.map((column) => row[column] ?? null);
}

function assertRevisionColumn(column) {
  if (column !== "version" && column !== "revision") {
    throw new Error(`unsupported master_plan revision column ${column}`);
  }
}

export function createMasterPlanTarget(conn, { revisionColumn = "revision" } = {}) {
  assertRevisionColumn(revisionColumn);
  const selectedRevision = `${revisionColumn} AS revision`;
  return {
    async listCurrentMasterPlans(userId) {
      const [rows] = await conn.execute(
        `SELECT plan_id, user_id, content_version, content, goal_id, status, active_flag, ${selectedRevision}, created_at, updated_at ` +
          "FROM master_plan WHERE user_id = ? AND (active_flag = 1 OR status = 'active') ORDER BY plan_id",
        [userId],
      );
      return rows.map((row) => ({
        ...row,
        revision: row.revision ?? row[revisionColumn] ?? null,
      }));
    },

    async listCurrentRaceGoals(userId) {
      const [rows] = await conn.execute(
        "SELECT goal_id, user_id, status, active_flag FROM race_goal " +
          "WHERE user_id = ? AND (active_flag = 1 OR status = 'active') ORDER BY goal_id",
        [userId],
      );
      return rows;
    },

    async transaction(_userId, operation) {
      await conn.beginTransaction();
      try {
        await operation({
          async insertRaceGoal(row) {
            await conn.execute(insertSql("race_goal", RACE_GOAL_COLUMNS), valuesFor(RACE_GOAL_COLUMNS, row));
          },
          async insertMasterPlan(row) {
            const physicalColumns = MASTER_PLAN_COLUMNS.map((column) =>
              column === "revision" ? revisionColumn : column,
            );
            await conn.execute(insertSql("master_plan", physicalColumns), valuesFor(MASTER_PLAN_COLUMNS, row));
          },
        });
        await conn.commit();
      } catch (error) {
        await conn.rollback();
        throw error;
      }
    },
  };
}

export function createMasterPlanSchemaAdapter(conn) {
  return {
    async inspect() {
      const [columns] = await conn.execute(
        "SELECT column_name, data_type, is_nullable FROM information_schema.columns " +
          "WHERE table_schema = DATABASE() AND table_name = 'master_plan' ORDER BY ordinal_position",
      );
      const [checks] = await conn.execute(
        "SELECT tc.constraint_name, cc.check_clause FROM information_schema.table_constraints tc " +
          "JOIN information_schema.check_constraints cc ON cc.constraint_schema = tc.constraint_schema " +
          "AND cc.constraint_name = tc.constraint_name " +
          "WHERE tc.table_schema = DATABASE() AND tc.table_name = 'master_plan' AND tc.constraint_type = 'CHECK'",
      );
      const [indexes] = await conn.execute(
        "SELECT index_name, non_unique, seq_in_index, column_name FROM information_schema.statistics " +
          "WHERE table_schema = DATABASE() AND table_name = 'master_plan' ORDER BY index_name, seq_in_index",
      );
      const uniqueIndexes = {};
      for (const index of indexes) {
        if (Number(index.non_unique) !== 0) continue;
        (uniqueIndexes[index.index_name] ??= []).push(index.column_name);
      }
      return {
        columns: columns.map((column) => column.column_name),
        revisionColumn: columns.find((column) => column.column_name === "revision") ?? null,
        checks: Object.fromEntries(checks.map((check) => [check.constraint_name, check.check_clause])),
        uniqueIndexes,
      };
    },

    async validateRows(column) {
      assertRevisionColumn(column);
      const [rows] = await conn.execute(
        `SELECT COUNT(*) AS invalid_count FROM master_plan WHERE ` +
          "content_version NOT IN (1, 2) OR " +
          `(content_version = 1 AND ${column} IS NOT NULL) OR ` +
          `(content_version = 2 AND (${column} IS NULL OR ${column} < 1)) OR ` +
          "(status = 'active' AND (active_flag IS NULL OR active_flag <> 1)) OR " +
          "(status <> 'active' AND active_flag IS NOT NULL)",
      );
      const invalidCount = Number(rows[0]?.invalid_count ?? 0);
      return { valid: invalidCount === 0, invalid_count: invalidCount };
    },

    async renameVersionAndReplaceChecks() {
      const [checks] = await conn.execute(
        "SELECT constraint_name FROM information_schema.table_constraints " +
          "WHERE table_schema = DATABASE() AND table_name = 'master_plan' AND constraint_type = 'CHECK'",
      );
      const names = new Set(checks.map((check) => check.constraint_name));
      const drops = [
        "ck_master_plan_content_version",
        "ck_master_plan_v2_version",
        "ck_master_plan_revision",
        "ck_master_plan_current_marker",
      ].filter((name) => names.has(name)).map((name) => `DROP CHECK ${name}`);
      const clauses = [
        "CHANGE COLUMN version revision BIGINT NULL",
        ...drops,
        "ADD CONSTRAINT ck_master_plan_content_version CHECK (content_version IN (1, 2))",
        "ADD CONSTRAINT ck_master_plan_revision CHECK ((content_version = 1 AND revision IS NULL) OR (content_version = 2 AND revision >= 1))",
        "ADD CONSTRAINT ck_master_plan_current_marker CHECK ((status = 'active' AND active_flag = 1) OR (status <> 'active' AND active_flag IS NULL))",
      ];
      await conn.query(`ALTER TABLE master_plan\n  ${clauses.join(",\n  ")}`);
    },
  };
}
