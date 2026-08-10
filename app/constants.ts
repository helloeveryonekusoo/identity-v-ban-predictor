import type {
  AppSettings,
  BanOrderMode,
  MasterKind,
  PredictionConfig,
  SharedSettings,
  UserSettings,
} from "./types";

export const DEFAULT_MAPS = [
  "軍需工場",
  "赤の教会",
  "聖心病院",
  "湖景村",
  "月の河公園",
  "レオの思い出",
  "永眠町",
  "中華街",
  "罪の森",
] as const;

export const DEFAULT_SURVIVORS = [
  "幸運児",
  "医師",
  "弁護士",
  "泥棒",
  "庭師",
  "マジシャン",
  "冒険家",
  "傭兵",
  "祭司",
  "空軍",
  "機械技師",
  "オフェンス",
  "心眼",
  "調香師",
  "カウボーイ",
  "踊り子",
  "占い師",
  "納棺師",
  "探鉱者",
  "呪術師",
  "野人",
  "曲芸師",
  "一等航海士",
  "バーメイド",
  "ポストマン",
  "墓守",
  "囚人",
  "昆虫学者",
  "画家",
  "バッツマン",
  "玩具職人",
  "患者",
  "心理学者",
  "小説家",
  "少女",
  "泣きピエロ",
  "教授",
  "骨董商",
  "作曲家",
  "記者",
  "航空エンジニア",
  "応援団",
  "人形師",
  "火災調査員",
  "レディ・ファウロ",
  "騎士",
  "気象学者",
  "弓使い",
  "脱出マスター",
  "幻灯師",
  "闘牛士",
  "マイムアーティスト",
] as const;

export const DEFAULT_HUNTERS = [
  "復讐者",
  "道化師",
  "断罪狩人",
  "リッパー",
  "結魂者",
  "芸者",
  "白黒無常",
  "写真家",
  "狂眼",
  "血の女王",
  "ガードNo.26",
  "使徒",
  "ヴァイオリニスト",
  "彫刻家",
  "アンデッド",
  "破輪",
  "漁師",
  "蝋人形師",
  "悪夢",
  "「使徒」キーガン",
  "隠者",
  "イタカ",
  "サングリア",
  "フルゴ",
  "アイヴィ",
  "足萎え",
  "フラバルー",
  "雑貨商",
  "ビリプレ",
  "女王蜂",
  "歯医者",
  "心の獣",
] as const;

export const BAN_NONE = "BANなし";

/** 集計画面の「全シーズン」を表す番兵値。シーズン名として使えない文字を含める。 */
export const ALL_SEASONS = "__all__";

/** 削除・データ閲覧画面の「全ユーザー」を表す番兵値。 */
export const ALL_USERS = "__all__";

/** 削除・データ閲覧画面の「全ハンター」を表す番兵値。 */
export const ALL_HUNTERS = "__all__";

export const DEFAULT_SEASON = "現行シーズン";

export const MASTER_LABELS: Record<MasterKind, string> = {
  survivors: "サバイバー",
  hunters: "ハンター",
  maps: "マップ",
  seasons: "シーズン",
};

/** シーズン補正の世代数（最新 / 1つ前 / 2つ前 / それ以前）。 */
export const SEASON_AGE_BUCKETS = 4;

export const MAX_BAN_SLOTS = 6;

/** サバイバー側がBANできるハンターの数。ゲームのルールに合わせて3体固定。 */
export const HUNTER_BAN_SLOTS = 3;

/** BAN一致数ごとの既定重み。index が一致数。銀行スロット数に合わせて伸縮させる。 */
const DEFAULT_BAN_MATCH_WEIGHTS = [0, 3, 10, 30, 45, 60, 80];

export const BAN_ORDER_LABELS: Record<BanOrderMode, string> = {
  registered: "登録順",
  banRate: "Ban率順",
};

export function defaultBanMatchWeights(banSlots: number): number[] {
  return Array.from(
    { length: banSlots + 1 },
    (_, index) =>
      DEFAULT_BAN_MATCH_WEIGHTS[index] ??
      DEFAULT_BAN_MATCH_WEIGHTS[DEFAULT_BAN_MATCH_WEIGHTS.length - 1] +
        15 * (index - DEFAULT_BAN_MATCH_WEIGHTS.length + 1),
  );
}

export function defaultPredictionConfig(banSlots = 3): PredictionConfig {
  return {
    baseWeight: 1,
    countWeight: 0.5,
    factors: {
      banMatch: {
        enabled: true,
        params: {},
        series: { weights: defaultBanMatchWeights(banSlots) },
        picks: {},
      },
      // 既定値は「Ban3一致 > Ban2一致+マップ > Ban2一致 > Ban1一致+マップ」の
      // 順になるよう、BAN一致数の重み差より小さい値にしてある。
      mapMatch: {
        enabled: true,
        params: { weight: 6 },
        series: {},
        picks: {},
      },
      // 対象サバイバーは利用者が「基本設定」で選ぶ。既定は未選択＝補正なし。
      rareBan: {
        enabled: true,
        params: { bonus: 0.5 },
        series: {},
        picks: { survivors: [] },
      },
      season: {
        enabled: true,
        params: {},
        series: { weights: [1, 0.8, 0.6, 0.4] },
        picks: {},
      },
    },
  };
}

/** ログイン中のユーザーへ最初に適用する設定。 */
export const DEFAULT_USER_SETTINGS: UserSettings = {
  currentSeason: DEFAULT_SEASON,
  banOrderMode: "registered",
  defaultHunterBans: [],
};

/** 全ユーザーで共有する設定の初期値。 */
export const DEFAULT_SHARED_SETTINGS: SharedSettings = {
  maps: [...DEFAULT_MAPS],
  survivors: [...DEFAULT_SURVIVORS],
  hunters: [...DEFAULT_HUNTERS],
  seasons: [DEFAULT_SEASON],
  banSlots: 3,
  prediction: defaultPredictionConfig(3),
};

export const DEFAULT_SETTINGS: AppSettings = {
  ...DEFAULT_SHARED_SETTINGS,
  ...DEFAULT_USER_SETTINGS,
};

function uniqueStrings(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const cleaned = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  const seen = new Set<string>();
  const result: string[] = [];
  cleaned.forEach((item) => {
    if (seen.has(item)) return;
    seen.add(item);
    result.push(item);
  });
  return result.length ? result : [...fallback];
}

function numberOr(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function numberSeries(
  value: unknown,
  length: number,
  fallback: number[],
): number[] {
  const source = Array.isArray(value) ? value : [];
  return Array.from({ length }, (_, index) =>
    numberOr(source[index], fallback[index] ?? fallback[fallback.length - 1] ?? 0),
  );
}

/** 選択リスト（希少Ban対象など）。空の選択も正当な値なので fallback を返さない。 */
function pickList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  value.forEach((item) => {
    const name = typeof item === "string" ? item.trim() : "";
    if (!name || seen.has(name)) return;
    seen.add(name);
    result.push(name);
  });
  return result;
}

/**
 * Firestore から読んだ生データを、常に完全な AppSettings へ整える。
 * 旧バージョンのドキュメント（seasons や prediction を持たない）も安全に読める。
 */
export function normalizeSettings(raw: unknown): AppSettings {
  const data = (raw ?? {}) as Partial<AppSettings> & Record<string, unknown>;

  const banSlots = Math.min(
    MAX_BAN_SLOTS,
    Math.max(1, Math.round(numberOr(data.banSlots, DEFAULT_SETTINGS.banSlots))),
  );
  const currentSeason =
    typeof data.currentSeason === "string" && data.currentSeason.trim()
      ? data.currentSeason.trim()
      : DEFAULT_SETTINGS.currentSeason;

  const seasons = uniqueStrings(data.seasons, [currentSeason]);
  // 現在シーズンは必ず一覧の先頭（＝最新）に存在させる。
  const orderedSeasons = seasons.includes(currentSeason)
    ? seasons
    : [currentSeason, ...seasons];

  const fallbackPrediction = defaultPredictionConfig(banSlots);
  const rawPrediction = (data.prediction ?? {}) as Partial<PredictionConfig>;
  const rawFactors = (rawPrediction.factors ?? {}) as Record<string, unknown>;

  const factors: PredictionConfig["factors"] = {};
  Object.entries(fallbackPrediction.factors).forEach(([id, fallback]) => {
    const stored = (rawFactors[id] ?? {}) as Record<string, unknown>;
    const storedParams = (stored.params ?? {}) as Record<string, unknown>;
    const storedSeries = (stored.series ?? {}) as Record<string, unknown>;
    const storedPicks = (stored.picks ?? {}) as Record<string, unknown>;

    factors[id] = {
      enabled:
        typeof stored.enabled === "boolean" ? stored.enabled : fallback.enabled,
      params: Object.fromEntries(
        Object.entries(fallback.params).map(([key, value]) => [
          key,
          numberOr(storedParams[key], value),
        ]),
      ),
      series: Object.fromEntries(
        Object.entries(fallback.series).map(([key, value]) => [
          key,
          numberSeries(storedSeries[key], value.length, value),
        ]),
      ),
      picks: Object.fromEntries(
        Object.keys(fallback.picks).map((key) => [key, pickList(storedPicks[key])]),
      ),
    };
  });

  // 未知のファクター設定も保持しておく（将来の要素追加・巻き戻しでデータを失わない）。
  Object.entries(rawFactors).forEach(([id, value]) => {
    if (factors[id] || !value || typeof value !== "object") return;
    const stored = value as Record<string, unknown>;
    factors[id] = {
      enabled: stored.enabled !== false,
      params: (stored.params ?? {}) as Record<string, number>,
      series: (stored.series ?? {}) as Record<string, number[]>,
      picks: (stored.picks ?? {}) as Record<string, string[]>,
    };
  });

  const hunters = uniqueStrings(data.hunters, DEFAULT_SETTINGS.hunters);

  return {
    maps: uniqueStrings(data.maps, DEFAULT_SETTINGS.maps),
    survivors: uniqueStrings(data.survivors, DEFAULT_SETTINGS.survivors),
    hunters,
    seasons: orderedSeasons,
    banSlots,
    currentSeason,
    banOrderMode:
      data.banOrderMode === "banRate" ? "banRate" : "registered",
    // マスターから消えたハンターは既定BANから落とす。
    defaultHunterBans: pickList(data.defaultHunterBans)
      .filter((hunter) => hunters.includes(hunter))
      .slice(0, HUNTER_BAN_SLOTS),
    prediction: {
      baseWeight: numberOr(rawPrediction.baseWeight, 1),
      countWeight: Math.min(
        1,
        Math.max(0, numberOr(rawPrediction.countWeight, 0.5)),
      ),
      factors,
    },
  };
}

/**
 * 保存時に、全員で共有する設定と本人だけの設定へ切り分ける。
 * 予測アルゴリズムの重みは共有側なので、誰か1人の調整が全員へ反映される。
 */
export function splitSettings(settings: AppSettings): {
  shared: SharedSettings;
  user: UserSettings;
} {
  return {
    shared: {
      maps: settings.maps,
      survivors: settings.survivors,
      hunters: settings.hunters,
      seasons: settings.seasons,
      banSlots: settings.banSlots,
      prediction: settings.prediction,
    },
    user: {
      currentSeason: settings.currentSeason,
      banOrderMode: settings.banOrderMode,
      defaultHunterBans: settings.defaultHunterBans,
    },
  };
}

/**
 * 読み込み時の合成。共有設定を土台に、本人の設定を上書きする。
 * 予測設定は必ず共有側を優先する（旧バージョンで個人側へ保存された値が
 * 残っていても、共有の調整結果が勝つようにする）。
 * 共有側にまだ予測設定が無い移行期だけ、本人の値を引き継ぐ。
 */
export function mergeSettings(shared: unknown, personal: unknown): AppSettings {
  const sharedData = (shared ?? {}) as Record<string, unknown>;
  const personalData = (personal ?? {}) as Record<string, unknown>;
  return normalizeSettings({
    ...sharedData,
    ...personalData,
    prediction: sharedData.prediction ?? personalData.prediction,
  });
}

/** BAN人数を変えたときに、BAN一致数の重み配列を過不足なく合わせる。 */
export function resizeBanMatchWeights(
  settings: AppSettings,
  banSlots: number,
): AppSettings {
  const fallback = defaultBanMatchWeights(banSlots);
  const current = settings.prediction.factors.banMatch?.series.weights ?? [];
  return {
    ...settings,
    banSlots,
    prediction: {
      ...settings.prediction,
      factors: {
        ...settings.prediction.factors,
        banMatch: {
          ...settings.prediction.factors.banMatch,
          series: {
            weights: fallback.map((value, index) =>
              typeof current[index] === "number" ? current[index] : value,
            ),
          },
        },
      },
    },
  };
}

export const DEMO_MATCHES = [
  ["軍需工場", "機械技師", "オフェンス", BAN_NONE, "イタカ", "S43"],
  ["軍需工場", "機械技師", "オフェンス", BAN_NONE, "イタカ", "S43"],
  ["軍需工場", "機械技師", "オフェンス", BAN_NONE, "女王蜂", "S42"],
  ["軍需工場", "機械技師", "オフェンス", BAN_NONE, "雑貨商", "S41"],
  ["軍需工場", "祭司", "機械技師", "空軍", "イタカ", "S43"],
  ["赤の教会", "祭司", "傭兵", "占い師", "血の女王", "S43"],
  ["赤の教会", "祭司", "傭兵", "占い師", "血の女王", "S42"],
  ["赤の教会", "祭司", "傭兵", "占い師", "サングリア", "S41"],
  ["赤の教会", "機械技師", "傭兵", "占い師", "アイヴィ", "S43"],
  ["永眠町", "空軍", BAN_NONE, BAN_NONE, "フラバルー", "S43"],
  ["永眠町", "機械技師", "オフェンス", "祭司", "破輪", "S42"],
  ["聖心病院", "機械技師", "脱出マスター", "幻灯師", "蝋人形師", "S43"],
  ["聖心病院", "機械技師", "脱出マスター", "幻灯師", "蝋人形師", "S43"],
  ["聖心病院", "機械技師", "オフェンス", "呪術師", "歯医者", "S42"],
  ["月の河公園", "機械技師", "脱出マスター", "幻灯師", "心の獣", "S43"],
  ["湖景村", "祭司", "空軍", "機械技師", "漁師", "S41"],
] as const;

export const DEMO_SEASONS = ["S43", "S42", "S41"];
