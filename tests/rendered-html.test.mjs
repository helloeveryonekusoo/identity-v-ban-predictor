import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships the BAN prediction product metadata", async () => {
  const [page, layout, css, packageJson] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);

  assert.match(layout, /BAN Predictor/);
  assert.match(layout, /lang="ja"/);
  assert.match(page, /ハンター予測/);
  assert.match(page, /使用データ/);
  assert.match(page, /アカウント作成/);
  assert.match(page, /データ追加/);
  assert.match(page, /登録データの削除/);
  assert.match(page, /マスターデータ更新/);
  assert.match(css, /--acid:\s*#d9ff43/);
  assert.match(packageJson, /"firebase"/);
  assert.doesNotMatch(page, /_sites-preview|SkeletonPreview/);
  assert.doesNotMatch(layout, /codex-preview|Starter Project/);
});

test("includes Firebase sharing rules and runtime configuration", async () => {
  const [rules, route] = await Promise.all([
    readFile(new URL("firestore.rules", root), "utf8"),
    readFile(new URL("app/api/firebase-config/route.ts", root), "utf8"),
  ]);

  assert.match(rules, /match \/matches\/\{matchId\}/);
  assert.match(rules, /request\.auth/);
  assert.match(route, /FIREBASE_PROJECT_ID/);
  assert.match(route, /Cache-Control/);
});
