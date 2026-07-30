# 第五人格 BAN Predictor

第五人格のランク戦で、マップとBANサバイバーからピックされる可能性の高いハンターを予測する共有Webアプリです。

## 公開サイト

**[第五人格 BAN Predictorを開く](https://identity-v-ban-predictor-kuro.web.app)**

## 主な機能

- 類似データを重み付けするハンター予測（予測率の合計は常に100%）
- ハンター名・予測率・使用データ件数と、一致度ごとの内訳の表示
- 検索結果から実際のハンターを続けて登録
- 検索なしのデータ追加
- Banデータ閲覧（BANランキング／ハンター使用率／マップ別ハンター、シーズン切替）
- 登録日時・登録ユーザーによる絞り込みと複数削除
- マスターデータの追加・名称変更・並び順変更（登録済みデータへ自動反映）
- 予測アルゴリズムの重みとON/OFFを管理画面から変更
- Firebase Authenticationによるメールアドレス／パスワード認証
- Cloud Firestoreによる全ユーザー共通データ

## ハンター予測アルゴリズム

完全一致データだけでなく、類似データもスコア化して予測します。

```
1件のスコア = （基礎スコア ＋ 各ファクターの加算値）× 各ファクターの補正倍率
予測率 = ハンター別スコア合計 ÷ 全体スコア合計
```

| ファクター | 種別 | 既定値 | 内容 |
| --- | --- | --- | --- |
| Ban一致 | 加算 | 0/3/10/30 | 一致したBAN数ごとの重み。BANの順番は問わない |
| マップ補正 | 加算 | 6 | マップが一致した場合の加算 |
| 希少Ban補正 | 倍率 | 最大 +0.5 | BAN率が低いサバイバーの一致を高く評価する |
| シーズン補正 | 倍率 | 1 / 0.8 / 0.6 / 0.4 | 最新・1つ前・2つ前・それ以前 |

既定値では一致度が

`Ban3一致+マップ > Ban3一致 > Ban2一致+マップ > Ban2一致 > Ban1一致+マップ > Ban1一致`

の順になります。すべての重みとON/OFFは「更新 → 予測設定」から変更でき、「デフォルトへ戻す」で初期値に戻せます。

評価要素は `app/prediction.ts` の `PREDICTION_FACTORS` に定義されたレジストリです。
新しい要素は、この配列へ1件追加し `defaultPredictionConfig()` に既定値を足すだけで、
管理画面の入力欄も自動的に生成されます。

## Firebaseの準備

1. Firebase ConsoleでプロジェクトとWebアプリを作成します。
2. Authenticationで「メール／パスワード」を有効にします。
3. Cloud Firestoreを作成します。
4. `.env.example`を`.env.local`へコピーし、Webアプリの設定値を入力します。
5. Firebase CLIで`firestore.rules`をデプロイします。

公開環境では同じ6項目をランタイム環境変数として設定してください。Firebase未設定時は、画面と操作を確認できるデモモードが表示されます。デモで追加したデータは共有・永続化されません。

## ローカル実行

```bash
npm install
npm run dev
```

## データ構造

マスターデータ（`settings/global`）と登録データ（`matches`）を分離しているため、
名称変更・並び順変更・シーズン追加はマスター側の更新だけで完結します。

- `users/{uid}`: ユーザーID、メール、ユーザー名、作成日時
- `matches/{autoId}`: 登録日時、登録者、マップ、BAN1〜3、BAN配列、ハンター、シーズン
- `settings/global`:
  - `maps` / `survivors` / `hunters` / `seasons`: 選択肢マスター（配列の順序がそのまま表示順）
  - `banSlots`: BAN人数
  - `currentSeason`: 現在シーズン（`seasons` の中から選択）
  - `banOrderMode`: 検索画面のBANサバイバー表示順（`registered` / `banRate`）
  - `prediction`: 予測アルゴリズムの基礎スコアとファクター設定

マスターデータの名称を変更すると、保存時に `matches` の該当フィールド
（`map` / `hunter` / `season` / `bans` / `ban1`〜`ban3`）を一括更新するため、過去データは失われません。
このため `firestore.rules` では `matches` の `update` を許可しています。ルールの再デプロイが必要です。

```bash
firebase deploy --only firestore:rules
```
