import { BAN_NONE } from "./constants";
import type {
  MasterKind,
  MatchPayload,
  MatchRecord,
  RenamePlan,
} from "./types";

/**
 * 新規登録と修正で共通の保存内容を組み立てる。
 * ban1〜ban3 は集計・検索の互換性のため、BAN人数が3未満でも必ず埋める。
 */
export function buildMatchPayload(input: {
  map: string;
  bans: string[];
  hunter: string;
  season: string;
  banSlots: number;
}): MatchPayload {
  const padded = Array.from(
    { length: Math.max(3, input.banSlots) },
    (_, index) => input.bans[index] ?? BAN_NONE,
  );
  return {
    map: input.map,
    bans: padded.slice(0, input.banSlots),
    ban1: padded[0],
    ban2: padded[1],
    ban3: padded[2],
    hunter: input.hunter,
    season: input.season,
  };
}

/** 入力の不備を1件だけ日本語で返す。問題なければ null。 */
export function validateMatchInput(input: {
  map: string;
  bans: string[];
  hunter: string;
}): string | null {
  if (!input.map) return "マップを選択してください";
  if (!input.hunter) return "実際にピックされたハンターを選択してください";
  const active = input.bans.filter((ban) => ban && ban !== BAN_NONE);
  if (new Set(active).size !== active.length) {
    return "同じサバイバーが重複しています";
  }
  return null;
}

/** 保存内容が元データと同じなら true（無駄な書き込みを避ける）。 */
export function isSameMatch(record: MatchRecord, payload: MatchPayload) {
  return (
    record.map === payload.map &&
    record.hunter === payload.hunter &&
    record.season === payload.season &&
    record.bans.length === payload.bans.length &&
    record.bans.every((ban, index) => ban === payload.bans[index])
  );
}

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
