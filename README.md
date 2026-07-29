# 第五人格 BAN Predictor

第五人格のランク戦で、マップとBANサバイバーからピックされる可能性の高いハンターを予測する共有Webアプリです。

## 公開サイト

**[第五人格 BAN Predictorを開く](https://identity-v-ban-predictor-kuro.web.app)**

## 主な機能

- マップ選択時の先読みと、同一BAN構成の即時集計
- ハンター名・予測確率・使用データ件数の表示
- 検索結果から実際のハンターを続けて登録
- 検索なしのデータ追加
- 登録日時による絞り込みと複数削除
- サバイバー・ハンター・マップ・BAN人数・シーズンの更新
- Firebase Authenticationによるメールアドレス／パスワード認証
- Cloud Firestoreによる全ユーザー共通データ

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

- `users/{uid}`: ユーザーID、メール、ユーザー名、作成日時
- `matches/{autoId}`: 登録日時、登録者、マップ、BAN1〜3、BAN配列、ハンター、シーズン
- `settings/global`: 選択肢マスター、BAN人数、現在シーズン

予測は同一マップかつ同一BAN構成を優先します。完全一致データがない場合は同一マップ全体の実績をフォールバックとして使用します。
