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

export type PredictionRow = {
  hunter: string;
  count: number;
  probability: number;
};

export type PredictionResult = {
  rows: PredictionRow[];
  total: number;
  basis: "exact" | "map" | "none";
};

export type ViewName = "main" | "delete" | "update" | "add";
