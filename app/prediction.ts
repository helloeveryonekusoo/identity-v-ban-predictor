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
  /**
   * サバイバー側がBANしたハンター。一致度の計算には一切使わず、
   * 予測が終わったあとに候補から取り除くためだけに使う。
   */
  hunterBans?: string[];
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
 * add      … 一致度への加算（kind: "match" の要素だけが使う）
 * multiply … 同じ一致度の中での倍率（kind: "adjust" の要素だけが使う）
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

function round1(value: number) {
  return Math.round(value * 10) / 10;
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

/** 名称を複数選ばせる設定（例: 希少Ban扱いにするサバイバー）。 */
export type FactorPickSpec = {
  key: string;
  label: string;
  hint?: string;
  /** 選択肢。マスターデータから引く。 */
  options: (settings: AppSettings) => string[];
};

/**
 * 予測の評価要素。
 *
 * kind: "match"  … 一致度そのもの。マップとBANサバイバーだけがここに入る。
 *                  順位はまずこの合計値（一致度）で決まり、件数では逆転しない。
 * kind: "adjust" … 同じ一致度の中だけで効く補正。希少Ban・シーズンなど。
 *                  一致度をまたいで順位を入れ替えることはない。
 *
 * 新しい要素を足すときは、このリストへ1件追加し defaultPredictionConfig() に
 * 既定値を足すだけでよい（設定画面は自動生成される）。
 */
export type PredictionFactor = {
  id: string;
  label: string;
  description: string;
  kind: "match" | "adjust";
  params: FactorParamSpec[];
  series: FactorSeriesSpec[];
  picks: FactorPickSpec[];
  score: (context: FactorContext) => FactorResult;
};

export const PREDICTION_FACTORS: PredictionFactor[] = [
  {
    id: "banMatch",
    label: "Ban一致",
    description:
      "検索条件と同じサバイバーがBANされているデータを高く評価します。BANの順番は問いません。",
    kind: "match",
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
    picks: [],
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
    kind: "match",
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
    picks: [],
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
      "「基本設定」で選んだサバイバーがBANされていたデータを、特徴的な情報として引き上げます。選んでいないサバイバーには補正が掛かりません。",
    kind: "adjust",
    params: [
      {
        key: "bonus",
        label: "1人あたりの加算倍率",
        min: 0,
        max: 3,
        step: 0.05,
        hint: "0.5 なら1人一致で1.5倍、2人一致で2倍",
      },
    ],
    series: [],
    picks: [
      {
        key: "survivors",
        label: "希少Ban扱いにするサバイバー",
        hint: "検索条件と一致したBANのうち、ここで選んだサバイバーにだけ補正が掛かります。",
        options: (settings) => settings.survivors,
      },
    ],
    score: ({ matchedBans, config }) => {
      const rare = new Set(config.picks.survivors ?? []);
      if (!rare.size) return { multiply: 1 };
      const hits = matchedBans.filter((ban) => rare.has(ban));
      if (!hits.length) return { multiply: 1 };
      const multiply = 1 + (config.params.bonus ?? 0) * hits.length;
      return {
        multiply,
        note: `希少Ban補正（${hits.join("・")}）${times(multiply)}`,
      };
    },
  },
  {
    id: "season",
    label: "シーズン補正",
    description:
      "新しいシーズンのデータを優先します。倍率が 0 のシーズンはデータが使われません。",
    kind: "adjust",
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
    picks: [],
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
  picks: {},
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
  /** マップとBANだけで決まる一致度。順位はまずこの値で決まる。 */
  matchValue: number;
  /** 同じ一致度の中だけで効く補正倍率。 */
  multiplier: number;
  /** 一致度 × 補正。同じ一致度の中での比較に使う。 */
  weight: number;
  banMatchCount: number;
  mapMatched: boolean;
  notes: string[];
  excluded: boolean;
};

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

  let matchValue = 0;
  let multiplier = 1;
  let excluded = false;
  const notes: string[] = [];

  PREDICTION_FACTORS.forEach((factor) => {
    const factorConfig = config.factors[factor.id] ?? EMPTY_FACTOR_CONFIG;
    if (!factorConfig.enabled) return;
    const result = factor.score({ ...context, config: factorConfig });
    if (result.exclude) excluded = true;
    // 一致度と補正は別々に積む。補正が一致度をまたいで順位を変えることはない。
    if (factor.kind === "match") matchValue += result.add ?? 0;
    else multiplier *= result.multiply ?? 1;
    if (result.note) notes.push(result.note);
  });

  matchValue = Math.max(0, matchValue);
  multiplier = Math.max(0, multiplier);

  return {
    record,
    matchValue,
    multiplier,
    weight: (config.baseWeight + matchValue) * multiplier,
    banMatchCount: matchedBans.length,
    mapMatched,
    notes,
    excluded,
  };
}

/**
 * 同じ一致度の中で件数がどれだけ効くかの上限。
 * 「一致度の高いハンターが、件数の多い低一致度のハンターに逆転されない」ことを
 * 保証するため、隣り合う一致度の比率より必ず小さい値へ丸める。
 */
function safeCountWeight(matchValues: number[], config: { baseWeight: number; countWeight: number }) {
  const distinct = [...new Set(matchValues)].sort((a, b) => b - a);
  let limit = Infinity;
  for (let i = 1; i < distinct.length; i += 1) {
    const upper = config.baseWeight + distinct[i - 1];
    const lower = config.baseWeight + distinct[i];
    if (lower > 0) limit = Math.min(limit, upper / lower - 1);
  }
  const cap = Number.isFinite(limit) ? Math.max(0, limit * 0.9) : Infinity;
  return Math.min(Math.max(0, config.countWeight), cap);
}

function buildContributions(
  items: ScoredRecord[],
  totalWeight: number,
  usingFallback: boolean,
): PredictionContribution[] {
  return [...items]
    .sort(
      (a, b) =>
        b.weight - a.weight ||
        b.banMatchCount - a.banMatchCount ||
        Number(b.mapMatched) - Number(a.mapMatched),
    )
    .map((item) => {
      const notes = usingFallback
        ? ["全体傾向として使用", ...item.notes]
        : item.notes;
      return {
        record: item.record,
        score: round1(item.weight),
        share: totalWeight > 0 ? round1((item.weight / totalWeight) * 100) : 0,
        banMatchCount: item.banMatchCount,
        mapMatched: item.mapMatched,
        reason: notes.length ? notes.join(" / ") : "基礎スコアのみ",
      };
    });
}

/**
 * マップでは絞り込まず、登録されている全データを対象にスコアリングする。
 *
 * 順位の決め方は「一致度 ＞ 件数」。
 * 1. 各データの一致度（マップ＋BANサバイバーのみ）を求める。
 * 2. ハンターごとに、最も高い一致度のデータだけを採用する。
 * 3. 同じ一致度の中でのみ、件数と補正（希少Ban・シーズン）で差をつける。
 *    件数の影響は自動で上限が掛かるので、Ban2一致の大量データが
 *    Ban3一致を追い抜くことはない。
 * 4. ハンターBANで指定されたハンターを候補から完全に除外する。
 * 5. 残ったハンターだけで予測率（合計100%）を計算し直す。
 */
export function buildPrediction(
  records: MatchRecord[],
  query: PredictionQuery,
  settings: AppSettings,
  banRate: Map<string, number>,
): PredictionResult {
  const bannedHunters = new Set(normalizeBans(query.hunterBans ?? []));
  const empty: PredictionResult = {
    rows: [],
    total: 0,
    exactCount: 0,
    basis: "データがありません",
    tiers: [],
    excludedHunters: [],
  };
  if (!records.length) return empty;

  const queryBans = new Set(normalizeBans(query.bans));
  const scored = records.map((record) =>
    scoreRecord(record, query, settings, banRate, queryBans),
  );

  // BANを指定しているときは、BANが1人も一致しないデータを評価対象外にする。
  const usable = scored.filter(
    (item) =>
      !item.excluded &&
      item.weight > 0 &&
      item.matchValue > 0 &&
      (queryBans.size === 0 || item.banMatchCount > 0),
  );
  let pool = usable;
  let usingFallback = false;

  if (!pool.length) {
    // 類似データが1件も無いときは、全データの傾向から予測する。
    usingFallback = true;
    pool = scored.filter((item) => !item.excluded && item.weight > 0);
  }
  if (!pool.length) {
    usingFallback = true;
    pool = scored.map((item) => ({ ...item, weight: 1, matchValue: 0 }));
  }

  // ハンターごとに「最も高い一致度」を求め、その一致度のデータだけを採用する。
  const byHunter = new Map<string, ScoredRecord[]>();
  pool.forEach((item) => {
    const hunter = item.record.hunter;
    if (!hunter || bannedHunters.has(hunter)) return;
    const bucket = byHunter.get(hunter);
    if (bucket) bucket.push(item);
    else byHunter.set(hunter, [item]);
  });

  const excludedHunters = [...new Set(pool.map((item) => item.record.hunter))]
    .filter((hunter) => hunter && bannedHunters.has(hunter))
    .sort((a, b) => a.localeCompare(b, "ja"));

  if (!byHunter.size) {
    return {
      ...empty,
      basis: bannedHunters.size
        ? "BANしたハンター以外に候補がありません"
        : empty.basis,
      excludedHunters,
    };
  }

  type Bucket = {
    hunter: string;
    matchValue: number;
    items: ScoredRecord[];
    support: number;
  };

  const buckets: Bucket[] = [...byHunter.entries()].map(([hunter, items]) => {
    const matchValue = Math.max(...items.map((item) => item.matchValue));
    const best = items.filter((item) => item.matchValue === matchValue);
    return {
      hunter,
      matchValue,
      items: best,
      support: best.reduce((total, item) => total + item.weight, 0),
    };
  });

  const countWeight = safeCountWeight(
    buckets.map((bucket) => bucket.matchValue),
    settings.prediction,
  );

  const scoreOf = (bucket: Bucket) => {
    const tierScore = settings.prediction.baseWeight + bucket.matchValue;
    if (tierScore <= 0) return 0;
    // support（件数 × 補正）が増えるほど 0 → countWeight へ近づく。
    // 上限が countWeight なので、一致度の順位を追い越すことはない。
    const boost = countWeight * (bucket.support / (bucket.support + tierScore));
    return tierScore * (1 + boost);
  };

  const ranked = buckets
    .map((bucket) => ({ bucket, score: scoreOf(bucket) }))
    .sort(
      (a, b) =>
        b.bucket.matchValue - a.bucket.matchValue ||
        b.score - a.score ||
        b.bucket.items.length - a.bucket.items.length ||
        a.bucket.hunter.localeCompare(b.bucket.hunter, "ja"),
    );

  const percentages = toPercentages(ranked.map((entry) => entry.score));

  const rows: PredictionRow[] = ranked.map((entry, index) => ({
    hunter: entry.bucket.hunter,
    count: entry.bucket.items.length,
    score: round1(entry.score),
    matchValue: round1(entry.bucket.matchValue),
    matchLabel: tierLabel(
      entry.bucket.items[0].banMatchCount,
      entry.bucket.items[0].mapMatched,
      !usingFallback,
    ),
    probability: percentages[index],
    contributions: buildContributions(
      entry.bucket.items,
      entry.bucket.support,
      usingFallback,
    ),
  }));

  const used = ranked.flatMap((entry) => entry.bucket.items);

  const tierMap = new Map<string, PredictionTier>();
  used.forEach((item) => {
    const label = tierLabel(item.banMatchCount, item.mapMatched, !usingFallback);
    const tier = tierMap.get(label) ?? { label, count: 0, score: 0 };
    tier.count += 1;
    tier.score += item.weight;
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
      : `${rows[0]?.matchLabel ?? "類似データ"}を最上位として予測しています`;

  return {
    rows,
    total: used.length,
    exactCount,
    basis,
    tiers,
    excludedHunters,
  };
}
