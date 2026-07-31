import { SEASON_AGE_BUCKETS } from "./constants";
import { normalizeBans } from "./stats";
import type {
  AppSettings,
  FactorConfig,
  MatchRecord,
  PredictionContribution,
  PredictionResult,
  PredictionRow,
  PredictionTier,
} from "./types";

export { normalizeBans, banSignature } from "./stats";

export type PredictionQuery = {
  map: string;
  bans: string[];
  /** 検索時点のシーズン。シーズン補正の基準に使う。 */
  season?: string;
};

/** 1件の登録データを評価するときに、各ファクターへ渡される情報。 */
export type FactorContext = {
  record: MatchRecord;
  query: PredictionQuery;
  /** 検索条件のBANと一致したサバイバー */
  matchedBans: string[];
  banMatchCount: number;
  mapMatched: boolean;
  /** 0 = 最新シーズン、SEASON_AGE_BUCKETS-1 = それ以前 */
  seasonAge: number;
  /** サバイバー別のBAN率（0〜1） */
  banRate: Map<string, number>;
  config: FactorConfig;
  settings: AppSettings;
};

/**
 * ファクターの評価結果。
 * add      … 基礎スコアへの加算（一致の強さ）
 * multiply … 合計スコアへの倍率（補正）
 * exclude  … このデータを予測から除外する
 * note     … 採用理由として利用者へ表示する短い説明
 */
export type FactorResult = {
  add?: number;
  multiply?: number;
  exclude?: boolean;
  note?: string;
};

/** 採用理由の表示用。小数は2桁までに丸め、加算値には符号を付ける。 */
function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function signed(value: number) {
  const rounded = round2(value);
  return rounded >= 0 ? `+${rounded}` : `${rounded}`;
}

function times(value: number) {
  return `×${round2(value)}`;
}

export type FactorParamSpec = {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  hint?: string;
};

export type FactorSeriesSpec = {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  hint?: string;
  /** 各要素の見出し。BAN人数やシーズン名に追随させるため関数で受け取る。 */
  labels: (settings: AppSettings) => string[];
};

/**
 * 予測の評価要素。新しい要素を足すときは、このリストへ1件追加し
 * defaultPredictionConfig() に既定値を足すだけでよい（管理画面は自動生成）。
 */
export type PredictionFactor = {
  id: string;
  label: string;
  description: string;
  params: FactorParamSpec[];
  series: FactorSeriesSpec[];
  score: (context: FactorContext) => FactorResult;
};

export const PREDICTION_FACTORS: PredictionFactor[] = [
  {
    id: "banMatch",
    label: "Ban一致",
    description:
      "検索条件と同じサバイバーがBANされているデータを高く評価します。BANの順番は問いません。",
    params: [],
    series: [
      {
        key: "weights",
        label: "一致数ごとの重み",
        min: 0,
        max: 200,
        step: 1,
        labels: (settings) =>
          Array.from(
            { length: settings.banSlots + 1 },
            (_, index) => `${index}一致`,
          ),
      },
    ],
    score: ({ banMatchCount, config }) => {
      const add = config.series.weights?.[banMatchCount] ?? 0;
      return {
        add,
        note:
          banMatchCount > 0
            ? `BAN${banMatchCount}一致 ${signed(add)}`
            : "BAN一致なし",
      };
    },
  },
  {
    id: "mapMatch",
    label: "マップ補正",
    description:
      "マップが一致したデータへ重みを加算します。マップは絞り込み条件ではなく、加点要素として働きます。",
    params: [
      {
        key: "weight",
        label: "マップ一致時の加算値",
        min: 0,
        max: 200,
        step: 1,
      },
    ],
    series: [],
    score: ({ mapMatched, config }) => {
      if (!mapMatched) return { add: 0, note: "マップ不一致" };
      const add = config.params.weight ?? 0;
      return { add, note: `マップ一致 ${signed(add)}` };
    },
  },
  {
    id: "rareBan",
    label: "希少Ban補正",
    description:
      "BAN率が低いサバイバーほど特徴的な情報として、一致時の評価を引き上げます。倍率は最大値までの範囲で希少度に比例します。",
    params: [
      {
        key: "maxBonus",
        label: "最大加算倍率",
        min: 0,
        max: 3,
        step: 0.05,
        hint: "0.5 なら最大 1.5 倍",
      },
    ],
    series: [],
    score: ({ matchedBans, banRate, config }) => {
      if (!matchedBans.length) return { multiply: 1 };
      const rarity =
        matchedBans.reduce(
          (total, ban) => total + (1 - Math.min(1, banRate.get(ban) ?? 0)),
          0,
        ) / matchedBans.length;
      const multiply = 1 + (config.params.maxBonus ?? 0) * rarity;
      return {
        multiply,
        note:
          Math.abs(multiply - 1) < 0.005
            ? undefined
            : `希少Ban補正 ${times(multiply)}`,
      };
    },
  },
  {
    id: "season",
    label: "シーズン補正",
    description:
      "新しいシーズンのデータを優先します。倍率が 0 のシーズンはデータが使われません。",
    params: [],
    series: [
      {
        key: "weights",
        label: "シーズンごとの倍率",
        min: 0,
        max: 3,
        step: 0.05,
        labels: (settings) =>
          Array.from({ length: SEASON_AGE_BUCKETS }, (_, index) => {
            if (index === SEASON_AGE_BUCKETS - 1) return "それ以前";
            const name = settings.seasons[index];
            const prefix = index === 0 ? "最新" : `${index}つ前`;
            return name ? `${prefix}（${name}）` : prefix;
          }),
      },
    ],
    score: ({ seasonAge, config }) => {
      const multiply = config.series.weights?.[seasonAge] ?? 1;
      return {
        multiply,
        note:
          Math.abs(multiply - 1) < 0.005
            ? undefined
            : `シーズン補正 ${times(multiply)}`,
      };
    },
  },
];

const EMPTY_FACTOR_CONFIG: FactorConfig = {
  enabled: false,
  params: {},
  series: {},
};

function seasonAgeOf(season: string, settings: AppSettings) {
  const index = settings.seasons.indexOf(season);
  if (index < 0) return SEASON_AGE_BUCKETS - 1;
  return Math.min(index, SEASON_AGE_BUCKETS - 1);
}

function tierLabel(banMatchCount: number, mapMatched: boolean, matched: boolean) {
  if (!matched) return "一致なし（全体傾向）";
  const parts: string[] = [];
  if (banMatchCount > 0) parts.push(`BAN${banMatchCount}一致`);
  if (mapMatched) parts.push("マップ一致");
  return parts.length ? parts.join(" + ") : "一致なし（全体傾向）";
}

/** 合計がちょうど 100 になるように整数化する（最大剰余方式）。 */
function toPercentages(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return values.map(() => 0);
  const exact = values.map((value) => (value / total) * 100);
  const floors = exact.map((value) => Math.floor(value));
  let remainder = 100 - floors.reduce((sum, value) => sum + value, 0);
  const byFraction = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);
  const result = [...floors];
  for (let i = 0; i < byFraction.length && remainder > 0; i += 1, remainder -= 1) {
    result[byFraction[i].index] += 1;
  }
  return result;
}

type ScoredRecord = {
  record: MatchRecord;
  score: number;
  /** ファクターによる加算の合計。0 なら「類似していない」データ。 */
  relevance: number;
  banMatchCount: number;
  mapMatched: boolean;
  /** 各ファクターが返した採用理由。 */
  notes: string[];
};

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

/**
 * ハンター1体ぶんの「採用されたデータ」一覧を、影響の大きい順に組み立てる。
 * usingFallback（類似データ無し）のときは、一致ではなく全体傾向として使われた旨を示す。
 */
function buildContributions(
  items: ScoredRecord[],
  totalScore: number,
  usingFallback: boolean,
): PredictionContribution[] {
  return [...items]
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.banMatchCount - a.banMatchCount ||
        Number(b.mapMatched) - Number(a.mapMatched),
    )
    .map((item) => {
      const notes = usingFallback
        ? ["全体傾向として使用", ...item.notes]
        : item.notes;
      return {
        record: item.record,
        score: round1(item.score),
        share: totalScore > 0 ? round1((item.score / totalScore) * 100) : 0,
        banMatchCount: item.banMatchCount,
        mapMatched: item.mapMatched,
        reason: notes.length ? notes.join(" / ") : "基礎スコアのみ",
      };
    });
}

function scoreRecord(
  record: MatchRecord,
  query: PredictionQuery,
  settings: AppSettings,
  banRate: Map<string, number>,
  queryBans: Set<string>,
): ScoredRecord {
  const recordBans = normalizeBans(record.bans);
  const matchedBans = recordBans.filter((ban) => queryBans.has(ban));
  const mapMatched = Boolean(query.map) && record.map === query.map;
  const config = settings.prediction;

  const context: Omit<FactorContext, "config"> = {
    record,
    query,
    matchedBans,
    banMatchCount: matchedBans.length,
    mapMatched,
    seasonAge: seasonAgeOf(record.season, settings),
    banRate,
    settings,
  };

  let add = 0;
  let multiply = 1;
  let excluded = false;
  const notes: string[] = [];

  PREDICTION_FACTORS.forEach((factor) => {
    const factorConfig = config.factors[factor.id] ?? EMPTY_FACTOR_CONFIG;
    if (!factorConfig.enabled) return;
    const result = factor.score({ ...context, config: factorConfig });
    if (result.exclude) excluded = true;
    add += result.add ?? 0;
    multiply *= result.multiply ?? 1;
    if (result.note) notes.push(result.note);
  });

  const score = excluded
    ? 0
    : Math.max(0, (config.baseWeight + add) * multiply);

  return {
    record,
    score,
    relevance: excluded ? 0 : add,
    banMatchCount: matchedBans.length,
    mapMatched,
    notes,
  };
}

/**
 * マップでは一切絞り込まず、登録されている全データを対象にスコアリングし、
 * ハンターごとの予測率（合計100%）を返す。
 * マップは検索条件ではなく加点要素として扱うため、マップが違うデータでも
 * BANが一致していれば予測に採用される。
 * BANを指定した検索では、BANが1人も一致しないデータは評価対象外とする。
 * 完全一致データが無い場合も、一致度の低いデータを重み付けして必ず結果を返す。
 */
export function buildPrediction(
  records: MatchRecord[],
  query: PredictionQuery,
  settings: AppSettings,
  banRate: Map<string, number>,
): PredictionResult {
  const empty: PredictionResult = {
    rows: [],
    total: 0,
    exactCount: 0,
    basis: "データがありません",
    tiers: [],
  };
  if (!records.length) return empty;

  const queryBans = new Set(normalizeBans(query.bans));
  // マップでの絞り込みは行わない。全データをスコアリングの対象にする。
  const scored = records.map((record) =>
    scoreRecord(record, query, settings, banRate, queryBans),
  );

  // BANを指定しているときは、BANが1人も一致しないデータを評価対象外にする。
  // （マップだけが一致したデータがBAN1一致より上に来るのを防ぐ）
  const matched = scored.filter(
    (item) =>
      item.relevance > 0 &&
      item.score > 0 &&
      (queryBans.size === 0 || item.banMatchCount > 0),
  );
  let used = matched;
  let usingFallback = false;

  if (!used.length) {
    // 類似データが1件も無いときは、全データの傾向から予測する。
    usingFallback = true;
    used = scored.filter((item) => item.score > 0);
  }
  if (!used.length) {
    // 補正で全データのスコアが 0 になった場合は、均等重みで最低限の結果を返す。
    usingFallback = true;
    used = scored.map((item) => ({ ...item, score: 1 }));
  }

  const byHunter = new Map<
    string,
    { score: number; count: number; items: ScoredRecord[] }
  >();
  used.forEach((item) => {
    const hunter = item.record.hunter;
    if (!hunter) return;
    const bucket = byHunter.get(hunter) ?? { score: 0, count: 0, items: [] };
    bucket.score += item.score;
    bucket.count += 1;
    bucket.items.push(item);
    byHunter.set(hunter, bucket);
  });

  if (!byHunter.size) return empty;

  const entries = [...byHunter.entries()].sort(
    (a, b) =>
      b[1].score - a[1].score ||
      b[1].count - a[1].count ||
      a[0].localeCompare(b[0], "ja"),
  );
  const percentages = toPercentages(entries.map(([, value]) => value.score));

  const rows: PredictionRow[] = entries.map(([hunter, value], index) => ({
    hunter,
    count: value.count,
    score: round1(value.score),
    probability: percentages[index],
    contributions: buildContributions(value.items, value.score, usingFallback),
  }));

  const tierMap = new Map<string, PredictionTier>();
  used.forEach((item) => {
    const label = tierLabel(
      item.banMatchCount,
      item.mapMatched,
      !usingFallback && item.relevance > 0,
    );
    const tier = tierMap.get(label) ?? { label, count: 0, score: 0 };
    tier.count += 1;
    tier.score += item.score;
    tierMap.set(label, tier);
  });
  const tiers = [...tierMap.values()].sort(
    (a, b) => b.score / b.count - a.score / a.count,
  );

  const fullBanCount = queryBans.size;
  const exactCount = used.filter(
    (item) =>
      item.mapMatched &&
      item.banMatchCount === fullBanCount &&
      normalizeBans(item.record.bans).length === fullBanCount,
  ).length;

  const basis = usingFallback
    ? "類似データが無いため、全データの傾向から予測しています"
    : exactCount > 0
      ? `完全一致 ${exactCount}件を中心に予測しています`
      : `${tiers[0]?.label ?? "類似データ"}を中心に予測しています`;

  return { rows, total: used.length, exactCount, basis, tiers };
}
