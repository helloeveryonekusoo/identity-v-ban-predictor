import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * 予測ロジックと集計ロジックはUIから独立した純粋関数なので、
 * CommonJSへトランスパイルしてそのまま検証する。
 */
const SOURCES = [
  "app/prediction.ts",
  "app/stats.ts",
  "app/constants.ts",
  "app/records.ts",
  "app/types.ts",
];

let outDir;
let prediction;
let stats;
let constants;
let records;

before(() => {
  outDir = mkdtempSync(join(tmpdir(), "ban-predictor-"));
  const tsc = fileURLToPath(
    new URL("../node_modules/typescript/bin/tsc", import.meta.url),
  );
  execFileSync(
    process.execPath,
    [
      tsc,
      ...SOURCES,
      "--outDir",
      outDir,
      "--module",
      "commonjs",
      "--target",
      "es2022",
      "--moduleResolution",
      "node",
      "--skipLibCheck",
    ],
    { stdio: "pipe" },
  );
  const require = createRequire(join(outDir, "index.cjs"));
  prediction = require(join(outDir, "prediction.js"));
  stats = require(join(outDir, "stats.js"));
  constants = require(join(outDir, "constants.js"));
  records = require(join(outDir, "records.js"));
});

after(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

const match = (id, map, bans, hunter, season) => ({
  id,
  registeredAt: new Date(),
  registeredByUid: "u1",
  registeredByName: "u1",
  map,
  bans,
  ban1: bans[0] ?? "BANなし",
  ban2: bans[1] ?? "BANなし",
  ban3: bans[2] ?? "BANなし",
  hunter,
  season,
});

const sample = () => [
  match("1", "軍需工場", ["機械技師", "オフェンス", "祭司"], "イタカ", "S43"),
  match("2", "軍需工場", ["祭司", "機械技師", "オフェンス"], "イタカ", "S43"),
  match("3", "軍需工場", ["機械技師", "オフェンス", "呪術師"], "女王蜂", "S43"),
  match("4", "赤の教会", ["機械技師", "オフェンス", "祭司"], "雑貨商", "S42"),
  match("5", "湖景村", ["空軍", "医師", "傭兵"], "漁師", "S41"),
];

const baseSettings = () =>
  constants.normalizeSettings({
    ...constants.DEFAULT_SETTINGS,
    seasons: ["S43", "S42", "S41"],
    currentSeason: "S43",
  });

describe("予測アルゴリズム", () => {
  it("BANの順番が違っても同一データとして扱う", () => {
    const data = sample();
    const settings = baseSettings();
    const result = prediction.buildPrediction(
      data,
      { map: "軍需工場", bans: ["祭司", "オフェンス", "機械技師"] },
      settings,
      stats.buildBanRateIndex(data),
    );
    assert.equal(result.exactCount, 2);
    assert.equal(result.rows[0].hunter, "イタカ");
  });

  it("予測率の合計は常に100%になる", () => {
    const data = sample();
    const settings = baseSettings();
    const banRate = stats.buildBanRateIndex(data);
    const queries = [
      { map: "軍需工場", bans: ["祭司", "オフェンス", "機械技師"] },
      { map: "罪の森", bans: ["BANなし", "BANなし", "BANなし"] },
      { map: "赤の教会", bans: ["空軍"] },
    ];
    queries.forEach((q) => {
      const result = prediction.buildPrediction(data, q, settings, banRate);
      const sum = result.rows.reduce((total, row) => total + row.probability, 0);
      assert.equal(sum, 100, `${q.map} で合計が ${sum}%`);
    });
  });

  it("完全一致が無くても類似データで必ず予測する", () => {
    const data = sample();
    const result = prediction.buildPrediction(
      data,
      { map: "永眠町", bans: ["機械技師", "オフェンス"] },
      baseSettings(),
      stats.buildBanRateIndex(data),
    );
    assert.equal(result.exactCount, 0);
    assert.ok(result.rows.length > 0);
    assert.ok(result.total > 0);
  });

  it("既定の重みが一致度の順位を保つ", () => {
    const settings = baseSettings();
    const base = settings.prediction.baseWeight;
    const banWeights = settings.prediction.factors.banMatch.series.weights;
    const mapWeight = settings.prediction.factors.mapMatch.params.weight;
    const tier = (count, onMap) =>
      base + banWeights[count] + (onMap ? mapWeight : 0);

    const ordered = [
      tier(3, true),
      tier(3, false),
      tier(2, true),
      tier(2, false),
      tier(1, true),
      tier(1, false),
    ];
    ordered.forEach((value, index) => {
      if (index > 0) assert.ok(value < ordered[index - 1], ordered.join(" > "));
    });
  });

  it("シーズン補正の倍率0でそのシーズンが除外される", () => {
    const data = sample();
    const settings = baseSettings();
    settings.prediction.factors.season.series.weights = [1, 0, 0, 0];
    const result = prediction.buildPrediction(
      data,
      { map: "赤の教会", bans: ["機械技師"] },
      settings,
      stats.buildBanRateIndex(data),
    );
    assert.equal(result.rows.some((row) => row.hunter === "雑貨商"), false);
  });

  it("すべての補正をOFFにしても結果を返す", () => {
    const data = sample();
    const settings = baseSettings();
    Object.values(settings.prediction.factors).forEach((factor) => {
      factor.enabled = false;
    });
    const result = prediction.buildPrediction(
      data,
      { map: "軍需工場", bans: ["機械技師"] },
      settings,
      stats.buildBanRateIndex(data),
    );
    assert.equal(result.total, data.length);
    assert.equal(
      result.rows.reduce((total, row) => total + row.probability, 0),
      100,
    );
  });

  it("マップで絞り込まず、マップ違いのBAN完全一致も採用する", () => {
    const data = sample();
    const result = prediction.buildPrediction(
      data,
      { map: "永眠町", bans: ["機械技師", "オフェンス", "祭司"] },
      baseSettings(),
      stats.buildBanRateIndex(data),
    );
    // マップはどのデータとも一致しないが、BANが一致するデータは採用される。
    // BANが1人も一致しない 5（湖景村）だけが除外される。
    assert.equal(result.exactCount, 0);
    const used = result.rows.flatMap((row) =>
      row.contributions.map((item) => item.record.id),
    );
    assert.deepEqual(used.sort(), ["1", "2", "3", "4"]);
  });

  it("Ban完全一致はマップ違いでも、Ban一部一致のマップ一致より高く評価する", () => {
    const data = [
      match("full", "湖景村", ["機械技師", "オフェンス", "祭司"], "イタカ", "S43"),
      match("partial", "軍需工場", ["機械技師", "オフェンス", "空軍"], "破輪", "S43"),
    ];
    const result = prediction.buildPrediction(
      data,
      { map: "軍需工場", bans: ["機械技師", "オフェンス", "祭司"] },
      baseSettings(),
      stats.buildBanRateIndex(data),
    );
    assert.equal(result.rows[0].hunter, "イタカ");
    assert.ok(result.rows[0].score > result.rows[1].score);
  });

  it("Banを指定した検索では、Ban一致なしのデータを評価対象から外す", () => {
    const data = [
      match("hit", "湖景村", ["機械技師"], "イタカ", "S43"),
      match("miss", "軍需工場", ["空軍", "医師"], "破輪", "S43"),
    ];
    const result = prediction.buildPrediction(
      data,
      { map: "軍需工場", bans: ["機械技師"] },
      baseSettings(),
      stats.buildBanRateIndex(data),
    );
    // マップが一致していても、BANが1人も一致しない「破輪」は使われない。
    assert.deepEqual(
      result.rows.map((row) => row.hunter),
      ["イタカ"],
    );
    assert.equal(result.total, 1);
  });

  it("採用されたデータをスコアと理由つきで返す", () => {
    const data = sample();
    const result = prediction.buildPrediction(
      data,
      { map: "軍需工場", bans: ["祭司", "オフェンス", "機械技師"] },
      baseSettings(),
      stats.buildBanRateIndex(data),
    );
    const top = result.rows[0];
    assert.equal(top.hunter, "イタカ");
    // 予測に使われた件数と、根拠として返る件数は必ず一致する。
    assert.equal(top.contributions.length, top.count);
    // スコアの高い順に並ぶ。
    top.contributions.forEach((item, index) => {
      if (index > 0) {
        assert.ok(item.score <= top.contributions[index - 1].score);
      }
    });
    const first = top.contributions[0];
    assert.ok(first.score > 0);
    assert.match(first.reason, /BAN3一致/);
    assert.match(first.reason, /マップ一致/);
    assert.equal(first.mapMatched, true);
    assert.equal(first.banMatchCount, 3);
    // 割合の合計はおおむね100%になる。
    const share = top.contributions.reduce((total, item) => total + item.share, 0);
    assert.ok(Math.abs(share - 100) < 1);
  });

  it("マップ違いのデータには採用理由へマップ不一致を残す", () => {
    const data = sample();
    const result = prediction.buildPrediction(
      data,
      { map: "赤の教会", bans: ["機械技師", "オフェンス", "祭司"] },
      baseSettings(),
      stats.buildBanRateIndex(data),
    );
    const itaka = result.rows.find((row) => row.hunter === "イタカ");
    assert.ok(itaka);
    itaka.contributions.forEach((item) => {
      assert.match(item.reason, /マップ不一致/);
    });
  });

  it("ファクターごとに既定値が定義されている", () => {
    const config = constants.defaultPredictionConfig(3);
    prediction.PREDICTION_FACTORS.forEach((factor) => {
      assert.ok(config.factors[factor.id], `${factor.id} の既定値がありません`);
      factor.params.forEach((spec) =>
        assert.ok(spec.key in config.factors[factor.id].params),
      );
      factor.series.forEach((spec) =>
        assert.ok(spec.key in config.factors[factor.id].series),
      );
    });
  });
});

describe("集計", () => {
  it("BANランキングを回数と割合で返す", () => {
    const ranking = stats.buildBanRanking(sample());
    assert.equal(ranking.totalMatches, 5);
    assert.equal(ranking.rows[0].count, 4);
    assert.equal(Math.round(ranking.rows[0].rate), 80);
    assert.equal(ranking.rows.find((row) => row.name === "祭司").count, 3);
  });

  it("ハンター使用率の合計は100%", () => {
    const ranking = stats.buildHunterRanking(sample());
    const sum = ranking.rows.reduce((total, row) => total + row.rate, 0);
    assert.ok(Math.abs(sum - 100) < 1e-9);
    assert.equal(ranking.rows[0].name, "イタカ");
  });

  it("シーズンで絞り込める", () => {
    assert.equal(stats.filterBySeason(sample(), "S43").length, 3);
    assert.equal(
      stats.filterBySeason(sample(), constants.ALL_SEASONS).length,
      5,
    );
  });

  it("マップ別ハンターを集計する", () => {
    const byMap = stats.buildMapHunterStats(sample());
    assert.equal(byMap[0].map, "軍需工場");
    assert.equal(byMap[0].totalMatches, 3);
    assert.equal(byMap[0].rows[0].name, "イタカ");
    assert.equal(byMap[0].rows[0].count, 2);
  });

  it("条件なしの検索は全件を返す", () => {
    const data = sample();
    assert.equal(
      stats.filterRecords(data, stats.EMPTY_RECORD_QUERY).length,
      data.length,
    );
  });

  it("シーズン・登録ユーザー・ハンターを組み合わせて絞り込む", () => {
    const data = [
      ...sample(),
      {
        ...match("6", "軍需工場", ["機械技師"], "イタカ", "S43"),
        registeredByUid: "u2",
        registeredByName: "ユーザーB",
      },
    ];
    const query = (patch) => ({ ...stats.EMPTY_RECORD_QUERY, ...patch });

    assert.equal(stats.filterRecords(data, query({ season: "S43" })).length, 4);
    assert.equal(
      stats.filterRecords(data, query({ registrant: "u2" })).length,
      1,
    );
    assert.equal(
      stats.filterRecords(data, query({ hunter: "イタカ" })).length,
      3,
    );
    assert.equal(
      stats.filterRecords(data, query({ registrant: "u2", hunter: "イタカ" }))
        .length,
      1,
    );
    assert.equal(
      stats.filterRecords(data, query({ registrant: "u1", hunter: "漁師" }))
        .length,
      1,
    );
  });

  it("データを登録しているユーザーだけを件数つきで返す", () => {
    const data = [
      ...sample(),
      {
        ...match("6", "軍需工場", ["機械技師"], "イタカ", "S43"),
        registeredByUid: "u2",
        registeredByName: "ユーザーB",
      },
    ];
    const registrants = stats.collectRegistrants(data);
    assert.deepEqual(
      registrants.map((item) => [item.uid, item.count]),
      [
        ["u1", 5],
        ["u2", 1],
      ],
    );
  });

  it("ピック実績のあるハンターだけをマスターの並び順で返す", () => {
    assert.deepEqual(
      stats.collectHunters(sample(), ["漁師", "雑貨商", "イタカ", "破輪"]),
      ["漁師", "雑貨商", "イタカ", "女王蜂"],
    );
  });

  it("Ban率順の並び替えは同率なら登録順を保つ", () => {
    const banRate = stats.buildBanRateIndex(sample());
    assert.deepEqual(
      stats.orderSurvivors(["祭司", "機械技師", "オフェンス"], "banRate", banRate),
      ["機械技師", "オフェンス", "祭司"],
    );
    assert.deepEqual(
      stats.orderSurvivors(["祭司", "機械技師"], "registered", banRate),
      ["祭司", "機械技師"],
    );
  });
});

describe("名称変更", () => {
  it("登録済みデータの全項目へ伝播する", () => {
    let plan = records.emptyRenamePlan();
    plan = records.planRename(plan, "hunters", "イタカ", "イタカ改");
    plan = records.planRename(plan, "survivors", "機械技師", "技師");
    plan = records.planRename(plan, "maps", "軍需工場", "工場");

    const updated = records.applyRenamesToRecords(sample(), plan);
    assert.equal(updated[0].hunter, "イタカ改");
    assert.equal(updated[0].map, "工場");
    assert.equal(updated[0].ban1, "技師");
    assert.ok(updated[0].bans.includes("技師"));
    assert.equal(updated[4].hunter, "漁師");
    assert.equal(records.renameFieldsForRecord(updated[4], plan), null);
  });

  it("連続した変更は元の名称へ集約し、戻せば取り消す", () => {
    let plan = records.emptyRenamePlan();
    plan = records.planRename(plan, "hunters", "彫刻家", "ガラテア");
    plan = records.planRename(plan, "hunters", "ガラテア", "ガラテア改");
    assert.deepEqual(plan.hunters, { 彫刻家: "ガラテア改" });

    plan = records.planRename(plan, "hunters", "ガラテア改", "彫刻家");
    assert.deepEqual(plan.hunters, {});
    assert.equal(records.hasRenames(plan), false);
  });

  it("BANなしは置き換えない", () => {
    let plan = records.emptyRenamePlan();
    plan = records.planRename(plan, "survivors", "BANなし", "X");
    const record = match("z", "湖景村", ["空軍", "BANなし", "BANなし"], "漁師", "S43");
    assert.equal(records.renameFieldsForRecord(record, plan), null);
  });
});

describe("設定の正規化", () => {
  it("旧形式のドキュメントを補完して読み込む", () => {
    const settings = constants.normalizeSettings({
      maps: ["軍需工場"],
      survivors: ["祭司"],
      hunters: ["イタカ"],
      banSlots: 3,
      currentSeason: "S40",
    });
    assert.deepEqual(settings.seasons, ["S40"]);
    assert.equal(settings.banOrderMode, "registered");
    assert.equal(settings.prediction.factors.banMatch.series.weights.length, 4);
    assert.equal(settings.prediction.factors.season.series.weights.length, 4);
  });

  it("BAN人数に合わせて重み配列を伸縮する", () => {
    const settings = constants.normalizeSettings({
      ...constants.DEFAULT_SETTINGS,
      banSlots: 6,
    });
    assert.equal(settings.prediction.factors.banMatch.series.weights.length, 7);
  });

  it("未知のファクター設定を失わない", () => {
    const settings = constants.normalizeSettings({
      ...constants.DEFAULT_SETTINGS,
      prediction: {
        baseWeight: 2,
        factors: {
          ...constants.defaultPredictionConfig(3).factors,
          futureFactor: { enabled: true, params: { x: 3 }, series: {} },
        },
      },
    });
    assert.equal(settings.prediction.baseWeight, 2);
    assert.equal(settings.prediction.factors.futureFactor.params.x, 3);
  });
});
