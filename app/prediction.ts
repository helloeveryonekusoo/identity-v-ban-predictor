import { BAN_NONE } from "./constants";
import type { MatchRecord, PredictionResult } from "./types";

export function normalizeBans(bans: string[]) {
  return bans
    .filter((ban) => ban && ban !== BAN_NONE)
    .filter((ban, index, all) => all.indexOf(ban) === index)
    .sort((a, b) => a.localeCompare(b, "ja"));
}

export function banSignature(bans: string[]) {
  return normalizeBans(bans).join("|");
}

export function buildPrediction(
  records: MatchRecord[],
  map: string,
  bans: string[],
): PredictionResult {
  const mapRecords = records.filter((record) => record.map === map);
  const signature = banSignature(bans);
  const exact = mapRecords.filter(
    (record) => banSignature(record.bans) === signature,
  );
  const source = exact.length > 0 ? exact : mapRecords;

  if (source.length === 0) {
    return { rows: [], total: 0, basis: "none" };
  }

  const counts = new Map<string, number>();
  source.forEach((record) => {
    counts.set(record.hunter, (counts.get(record.hunter) ?? 0) + 1);
  });

  return {
    total: source.length,
    basis: exact.length > 0 ? "exact" : "map",
    rows: [...counts.entries()]
      .map(([hunter, count]) => ({
        hunter,
        count,
        probability: Math.round((count / source.length) * 100),
      }))
      .sort((a, b) => b.count - a.count || a.hunter.localeCompare(b.hunter, "ja")),
  };
}
