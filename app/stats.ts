import { ALL_SEASONS, BAN_NONE } from "./constants";
import type {
  BanOrderMode,
  MapHunterStats,
  MatchRecord,
  RankingResult,
  RankingRow,
} from "./types";

export function normalizeBans(bans: string[]) {
  return bans
    .filter((ban) => ban && ban !== BAN_NONE)
    .filter((ban, index, all) => all.indexOf(ban) === index)
    .sort((a, b) => a.localeCompare(b, "ja"));
}

export function banSignature(bans: string[]) {
  return normalizeBans(bans).join("|");
}

/** season に ALL_SEASONS を渡すと絞り込みを行わない。 */
export function filterBySeason(records: MatchRecord[], season: string) {
  if (!season || season === ALL_SEASONS) return records;
  return records.filter((record) => record.season === season);
}

function toRanking(
  counts: Map<string, number>,
  totalMatches: number,
): RankingResult {
  const rows: RankingRow[] = [...counts.entries()]
    .map(([name, count]) => ({
      name,
      count,
      rate: totalMatches ? (count / totalMatches) * 100 : 0,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ja"));
  return { rows, totalMatches };
}

/**
 * BANされた回数のランキング。
 * Ban率は「集計対象の試合数のうち、そのサバイバーがBANされた試合の割合」。
 */
export function buildBanRanking(records: MatchRecord[]): RankingResult {
  const counts = new Map<string, number>();
  records.forEach((record) => {
    normalizeBans(record.bans).forEach((ban) => {
      counts.set(ban, (counts.get(ban) ?? 0) + 1);
    });
  });
  return toRanking(counts, records.length);
}

/** 実際にピックされたハンターの使用率ランキング。 */
export function buildHunterRanking(records: MatchRecord[]): RankingResult {
  const counts = new Map<string, number>();
  records.forEach((record) => {
    if (!record.hunter) return;
    counts.set(record.hunter, (counts.get(record.hunter) ?? 0) + 1);
  });
  return toRanking(counts, records.length);
}

/** マップごとのハンター使用率。データがあるマップだけを試合数の多い順に返す。 */
export function buildMapHunterStats(records: MatchRecord[]): MapHunterStats[] {
  const byMap = new Map<string, MatchRecord[]>();
  records.forEach((record) => {
    if (!record.map) return;
    const bucket = byMap.get(record.map);
    if (bucket) bucket.push(record);
    else byMap.set(record.map, [record]);
  });

  return [...byMap.entries()]
    .map(([map, mapRecords]) => {
      const ranking = buildHunterRanking(mapRecords);
      return { map, totalMatches: ranking.totalMatches, rows: ranking.rows };
    })
    .sort(
      (a, b) =>
        b.totalMatches - a.totalMatches || a.map.localeCompare(b.map, "ja"),
    );
}

/** 希少Ban補正とBan率順ソートで使う、サバイバー別のBAN率（0〜1）。 */
export function buildBanRateIndex(records: MatchRecord[]): Map<string, number> {
  const { rows, totalMatches } = buildBanRanking(records);
  const index = new Map<string, number>();
  if (!totalMatches) return index;
  rows.forEach((row) => index.set(row.name, row.count / totalMatches));
  return index;
}

/** 検索画面のBANドロップダウン用の並び替え。 */
export function orderSurvivors(
  survivors: string[],
  mode: BanOrderMode,
  banRate: Map<string, number>,
): string[] {
  if (mode !== "banRate") return survivors;
  const registeredOrder = new Map(survivors.map((name, index) => [name, index]));
  return [...survivors].sort((a, b) => {
    const diff = (banRate.get(b) ?? 0) - (banRate.get(a) ?? 0);
    if (Math.abs(diff) > 1e-9) return diff;
    return (registeredOrder.get(a) ?? 0) - (registeredOrder.get(b) ?? 0);
  });
}

/**
 * 集計画面のシーズン選択肢。
 * マスターの並び（新しい順）を優先し、マスター未登録のシーズンは末尾に足す。
 */
export function collectSeasons(
  records: MatchRecord[],
  masterSeasons: string[],
): string[] {
  const fromRecords = new Set(
    records.map((record) => record.season).filter(Boolean),
  );
  const extras = [...fromRecords]
    .filter((season) => !masterSeasons.includes(season))
    .sort((a, b) => b.localeCompare(a, "ja"));
  return [...masterSeasons, ...extras];
}

/** 登録者ドロップダウン用。表示名で重複を除いた一覧。 */
export function collectRegistrants(records: MatchRecord[]) {
  const byUid = new Map<string, string>();
  records.forEach((record) => {
    const key = record.registeredByUid || record.registeredByName;
    if (!key) return;
    if (!byUid.has(key)) byUid.set(key, record.registeredByName || "不明");
  });
  return [...byUid.entries()]
    .map(([uid, name]) => ({ uid, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "ja"));
}
