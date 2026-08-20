// master-plan-phase-enum.js — pure normalization logic for migrating
// master_plan.content phase names to the canonical English enum
// (base/build/speed/marathon/taper/recovery) plus back-filling
// weeks[].phase_name from each week's phase_id. No I/O; unit-tested.
//
// Prod master plans are authored by the Python coach (free-text Chinese phase
// names, weeks linked by phase_id with phase_name null). The TypeScript coach
// (src/coach_agent) requires the enum names, so each real user's free-text
// phase names are mapped by hand (reviewed) to the enum below.

export const PHASE_NAME_ENUM = [
  "base",
  "build",
  "speed",
  "marathon",
  "taper",
  "recovery",
];

// user UUID -> free-text phase name -> canonical enum name.
// Every phase of the user's active structured plan must appear here.
export const PHASE_NAME_MAP = {
  "f10bc353-01ab-4db1-af9f-d9305ea9a532": {
    "已完成的有氧基础期": "base",
    "夏季速度衔接期": "speed",
    "马拉松专项 build 期": "marathon",
    "马拉松专项峰值期": "marathon",
    "减量与比赛期": "taper",
  },
  "db2470c4-885b-496f-896a-764c0dedbaea": {
    "已完成基础期": "base",
    "速度期": "speed",
    "专项建设期": "build",
    "半马峰值期": "marathon",
    "减量比赛期": "taper",
  },
  "ba103cff-ad2c-4f9e-9920-983337544a2c": {
    "已完成基础期": "base",
    "夏训速度期": "speed",
    "马拉松专项建设期": "marathon",
    "马拉松峰值期": "marathon",
    "减量比赛期": "taper",
  },
  "bef8d1fe-c617-4cc4-9e6f-bf6a8ce79ba9": {
    "已完成基础期": "base",
    "速度专项期": "speed",
    "马拉松建设期": "marathon",
    "峰值演练期": "marathon",
    "减量比赛期": "taper",
  },
  "0a74ac88-629e-4b8e-97c8-d49ccf5a986b": {
    "已完成基础重建期": "base",
    "专项准备期": "build",
    "马拉松专项建设期": "marathon",
    "峰值巩固期": "marathon",
    "减量比赛期": "taper",
  },
};

export class PhaseNameMigrationError extends Error {}

/**
 * Normalize one structured master-plan content document in place of a new
 * copy. Idempotent: already-enum phases and already-filled phase_name weeks
 * produce no changes. Returns `{ content, changes }` where `changes` is an
 * empty array when the document already satisfies the enum contract.
 *
 * Throws PhaseNameMigrationError when a phase name has no mapping, a phase
 * lacks its id, or a week references an unknown phase_id.
 */
export function normalizePhaseNames(content, userId) {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw new PhaseNameMigrationError("content must be a JSON object");
  }
  const map = PHASE_NAME_MAP[userId];
  if (!map) throw new PhaseNameMigrationError(`no phase mapping for user ${userId}`);

  const phases = content.phases;
  const weeks = content.weeks;
  if (!Array.isArray(phases)) {
    throw new PhaseNameMigrationError("structured plan requires a phases array");
  }
  if (!Array.isArray(weeks)) {
    throw new PhaseNameMigrationError("structured plan requires a weeks array");
  }

  const enumByName = new Set(PHASE_NAME_ENUM);
  const phaseNameById = new Map();
  const changes = [];

  const newPhases = phases.map((phase) => {
    const id = phase?.id;
    if (typeof id !== "string" || id === "") {
      throw new PhaseNameMigrationError("every phase must carry an id");
    }
    const current = String(phase?.name ?? "");
    if (enumByName.has(current)) {
      phaseNameById.set(id, current);
      return phase;
    }
    const target = map[current];
    if (typeof target !== "string") {
      throw new PhaseNameMigrationError(
        `no phase-name mapping for "${current}" (phase ${id})`,
      );
    }
    if (!enumByName.has(target)) {
      throw new PhaseNameMigrationError(
        `mapped name "${target}" is not a canonical enum value`,
      );
    }
    phaseNameById.set(id, target);
    changes.push(`phase ${id} "${current}" -> "${target}"`);
    return { ...phase, name: target };
  });

  const newWeeks = weeks.map((week) => {
    const phaseId = week?.phase_id;
    const target = phaseNameById.get(phaseId);
    if (typeof target !== "string") {
      throw new PhaseNameMigrationError(
        `week ${week?.week_index ?? "?"} references unknown phase_id ${phaseId}`,
      );
    }
    if (week?.phase_name === target) return week;
    changes.push(`week ${week?.week_index ?? "?"} phase_name -> "${target}"`);
    return { ...week, phase_name: target };
  });

  if (changes.length === 0) return { content, changes };
  return { content: { ...content, phases: newPhases, weeks: newWeeks }, changes };
}