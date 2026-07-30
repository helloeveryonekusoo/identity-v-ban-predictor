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
 */
export type FactorConfig = {
  enabled: boolean;
  params: Record<string, number>;
  series: Record<string, number[]>;
};

export type PredictionConfig = {
  /** どのファクターにも当てはまらないデータへ与える基礎スコア */
  baseWeight: number;
  factors: Record<string, FactorConfig>;
};

export type AppSettings = {
  maps: string[];
  survivors: string[];
  hunters: string[];
  /** 新しい順に並べる。index 0 が最新シーズン。 */
  seasons: string[];
  banSlots: number;
  currentSeason: string;
  banOrderMode: BanOrderMode;
  prediction: PredictionConfig;
};

/** 名称変更の記録。キーは「変更前（元）の名称」、値は「変更後の名称」。 */
export type RenamePlan = Record<MasterKind, Record<string, string>>;

export type PredictionRow = {
  hunter: string;
  count: number;
  probability: number;
  score: number;
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

export type ViewName = "main" | "stats" | "delete" | "update" | "add";
