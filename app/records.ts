import { BAN_NONE } from "./constants";
import type { MasterKind, MatchRecord, RenamePlan } from "./types";

export function emptyRenamePlan(): RenamePlan {
  return { survivors: {}, hunters: {}, maps: {}, seasons: {} };
}

/**
 * 「元の名称 → 現在の名称」の対応表を更新する。
 * 彫刻家 → ガラテア → 彫刻家 のように戻した場合は、変更なしとして記録から消す。
 */
export function planRename(
  plan: RenamePlan,
  kind: MasterKind,
  currentName: string,
  nextName: string,
): RenamePlan {
  const table = { ...plan[kind] };
  const origin =
    Object.keys(table).find((key) => table[key] === currentName) ?? currentName;

  if (origin === nextName) delete table[origin];
  else table[origin] = nextName;

  return { ...plan, [kind]: table };
}

/** 実際に名称が変わった組だけを取り出す。 */
export function activeRenames(plan: RenamePlan, kind: MasterKind) {
  return Object.entries(plan[kind]).filter(([from, to]) => from !== to && to);
}

export function hasRenames(plan: RenamePlan) {
  return (Object.keys(plan) as MasterKind[]).some(
    (kind) => activeRenames(plan, kind).length > 0,
  );
}

export function renameCount(plan: RenamePlan) {
  return (Object.keys(plan) as MasterKind[]).reduce(
    (total, kind) => total + activeRenames(plan, kind).length,
    0,
  );
}

function lookup(table: Record<string, string>, value: string) {
  const next = table[value];
  return next && next !== value ? next : value;
}

/**
 * 登録済みデータ1件へ名称変更を適用し、更新が必要なフィールドだけ返す。
 * 変更が無ければ null。BANなしはマスターに存在しないためそのまま残る。
 */
export function renameFieldsForRecord(
  record: MatchRecord,
  plan: RenamePlan,
): Partial<MatchRecord> | null {
  const changes: Partial<MatchRecord> = {};

  const nextMap = lookup(plan.maps, record.map);
  if (nextMap !== record.map) changes.map = nextMap;

  const nextHunter = lookup(plan.hunters, record.hunter);
  if (nextHunter !== record.hunter) changes.hunter = nextHunter;

  const nextSeason = lookup(plan.seasons, record.season);
  if (nextSeason !== record.season) changes.season = nextSeason;

  const nextBans = record.bans.map((ban) =>
    ban === BAN_NONE ? ban : lookup(plan.survivors, ban),
  );
  if (nextBans.some((ban, index) => ban !== record.bans[index])) {
    changes.bans = nextBans;
  }

  (["ban1", "ban2", "ban3"] as const).forEach((key) => {
    const current = record[key];
    const next = current === BAN_NONE ? current : lookup(plan.survivors, current);
    if (next !== current) changes[key] = next;
  });

  return Object.keys(changes).length ? changes : null;
}

/** ローカル（デモモード・キャッシュ）の一覧へ名称変更を反映する。 */
export function applyRenamesToRecords(
  records: MatchRecord[],
  plan: RenamePlan,
): MatchRecord[] {
  return records.map((record) => {
    const changes = renameFieldsForRecord(record, plan);
    return changes ? { ...record, ...changes } : record;
  });
}

/** Firestore の writeBatch 上限（500）に収まるよう分割する。 */
export function chunk<T>(items: T[], size = 400): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
