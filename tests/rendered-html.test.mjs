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
  assert.match(page, /登録データの修正・削除/);
  assert.match(page, /マスターデータ更新/);
  assert.match(css, /--acid:\s*#d9ff43/);
  assert.match(packageJson, /"firebase"/);
  assert.doesNotMatch(page, /_sites-preview|SkeletonPreview/);
  assert.doesNotMatch(layout, /codex-preview|Starter Project/);
});

test("includes Firebase sharing rules, authentication, and web configuration", async () => {
  const [rules, webConfig, firebaseConfig, entry] = await Promise.all([
    readFile(new URL("firestore.rules", root), "utf8"),
    readFile(new URL("public/firebase-config.json", root), "utf8"),
    readFile(new URL("firebase.json", root), "utf8"),
    readFile(new URL("firebase-entry.tsx", root), "utf8"),
  ]);

  assert.match(rules, /match \/matches\/\{matchId\}/);
  assert.match(rules, /request\.auth/);
  assert.match(webConfig, /identity-v-ban-predictor-kuro/);
  assert.match(firebaseConfig, /"emailPassword": true/);
  assert.match(firebaseConfig, /"public": "firebase-dist"/);
  assert.match(entry, /<Home \/>/);
});
