import type { Timestamp } from "firebase/firestore";

export type MatchRecord = {
  id: string;
  registeredAt: Timestamp | Date | null;
  registeredByUid: string;
  registeredByName: string;
  map: string;
  bans: string[];
  ban1: string;
  ban2: string;
  ban3: string;
  hunter: string;
  season: string;
};

/** マスターデータの種別。追加時はここと MASTER_LABELS を増やすだけでよい。 */
export type MasterKind = "survivors" | "hunters" | "maps" | "seasons";

/** 検索画面のBANサバイバードロップダウンの並び順 */
export type BanOrderMode = "registered" | "banRate";

/**
 * 予測ファクター1件ぶんの設定値。
 * params  … 単一の数値パラメータ（例: マップ一致の重み）
 * series  … 可変長の数値パラメータ（例: BAN一致数ごとの重み）
 * picks   … 対象として選んだ名称の一覧（例: 希少Ban扱いにするサバイバー）
 */
export type FactorConfig = {
  enabled: boolean;
  params: Record<string, number>;
  series: Record<string, number[]>;
  picks: Record<string, string[]>;
};

export type PredictionConfig = {
  /** どのファクターにも当てはまらないデータへ与える基礎スコア */
  baseWeight: number;
  /**
   * 同じ一致度の中で、件数の多さをどれだけ加点するか（0〜1）。
   * 一致度の高いデータが件数で逆転されないよう、実際の適用値は自動で上限が掛かる。
   */
  countWeight: number;
  factors: Record<string, FactorConfig>;
};

/** 全ユーザーで共有するマスターデータ。 */
export type SharedSettings = {
  maps: string[];
  survivors: string[];
  hunters: string[];
  /** 新しい順に並べる。index 0 が最新シーズン。 */
  seasons: string[];
  banSlots: number;
};

/** ログイン中のユーザーだけに保存される設定。他ユーザーへは一切影響しない。 */
export type UserSettings = {
  currentSeason: string;
  banOrderMode: BanOrderMode;
  /** 検索画面を開いたときに最初から選ばれているハンターBAN（最大3体）。 */
  defaultHunterBans: string[];
  prediction: PredictionConfig;
};

/** 画面が扱う設定の合成ビュー。保存時に共有ぶんとユーザーぶんへ分けて書き込む。 */
export type AppSettings = SharedSettings & UserSettings;

/** 名称変更の記録。キーは「変更前（元）の名称」、値は「変更後の名称」。 */
export type RenamePlan = Record<MasterKind, Record<string, string>>;

/**
 * 予測へ実際に採用された登録データ1件ぶんの内訳。
 * 「どの過去データを、どんな理由で、どれだけ重く使ったか」を利用者へ提示する。
 */
export type PredictionContribution = {
  record: MatchRecord;
  /** このデータが予測へ与えたスコア（重み） */
  score: number;
  /** そのハンターの合計スコアに占める割合（0〜100） */
  share: number;
  banMatchCount: number;
  mapMatched: boolean;
  /** 採用理由（例:「BAN3一致 +30 / マップ一致 +6 / 希少Ban補正 ×1.2」） */
  reason: string;
};

export type PredictionRow = {
  hunter: string;
  count: number;
  probability: number;
  score: number;
  /** このハンターが持つ最も高い一致度の値。順位はまずこの値で決まる。 */
  matchValue: number;
  /** 最も高い一致度のラベル（例:「BAN3一致 + マップ一致」） */
  matchLabel: string;
  /** 予測率の計算に使われたデータのみ。スコアの高い順。 */
  contributions: PredictionContribution[];
};

/** 予測に使われたデータの内訳（例: 「BAN3一致 + マップ一致」が18件） */
export type PredictionTier = {
  label: string;
  count: number;
  score: number;
};

export type PredictionResult = {
  rows: PredictionRow[];
  /** 予測に寄与したデータ件数 */
  total: number;
  /** 検索条件と完全一致（全BAN一致かつマップ一致）したデータ件数 */
  exactCount: number;
  /** 使用データの中で最も一致度が高かった層のラベル */
  basis: string;
  tiers: PredictionTier[];
  /** ハンターBANで検索結果から除外したハンター名 */
  excludedHunters: string[];
};

export type RankingRow = {
  name: string;
  count: number;
  /** 0〜100 */
  rate: number;
};

export type RankingResult = {
  rows: RankingRow[];
  /** 集計対象の試合数 */
  totalMatches: number;
};

export type MapHunterStats = {
  map: string;
  totalMatches: number;
  rows: RankingRow[];
};

export type ViewName =
  | "main"
  | "stats"
  | "browse"
  | "delete"
  | "update"
  | "add";

/** データ閲覧・削除画面で共通に使う検索条件。値は番兵（__all__）で「指定なし」を表す。 */
export type RecordQuery = {
  season: string;
  registrant: string;
  hunter: string;
};
