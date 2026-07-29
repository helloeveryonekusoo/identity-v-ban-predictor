"use client";

import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  type User,
} from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BAN_NONE,
  DEFAULT_SETTINGS,
  DEMO_MATCHES,
  type AppSettings,
} from "./constants";
import { loadFirebaseServices, type FirebaseServices } from "./firebase";
import { buildPrediction, normalizeBans } from "./prediction";
import type { MatchRecord, PredictionResult, ViewName } from "./types";

const emptyPrediction: PredictionResult = {
  rows: [],
  total: 0,
  basis: "none",
};

const demoRecords: MatchRecord[] = DEMO_MATCHES.map((row, index) => ({
  id: `demo-${index + 1}`,
  registeredAt: new Date(Date.now() - (DEMO_MATCHES.length - index) * 86400000),
  registeredByUid: "demo",
  registeredByName: "デモユーザー",
  map: row[0],
  bans: [row[1], row[2], row[3]],
  ban1: row[1],
  ban2: row[2],
  ban3: row[3],
  hunter: row[4],
  season: "デモシーズン",
}));

function toDate(value: MatchRecord["registeredAt"]) {
  if (!value) return null;
  if (value instanceof Date) return value;
  return value.toDate();
}

function formatDateTime(value: MatchRecord["registeredAt"]) {
  const date = toDate(value);
  if (!date) return "登録処理中";
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function recordFromDoc(
  snapshot: { id: string; data: () => Record<string, unknown> },
): MatchRecord {
  const data = snapshot.data();
  const bans = Array.isArray(data.bans)
    ? data.bans.map(String)
    : [data.ban1, data.ban2, data.ban3].map((value) =>
        typeof value === "string" && value ? value : BAN_NONE,
      );
  return {
    id: snapshot.id,
    registeredAt: (data.registeredAt as MatchRecord["registeredAt"]) ?? null,
    registeredByUid: String(data.registeredByUid ?? ""),
    registeredByName: String(data.registeredByName ?? "不明"),
    map: String(data.map ?? ""),
    bans,
    ban1: String(data.ban1 ?? bans[0] ?? BAN_NONE),
    ban2: String(data.ban2 ?? bans[1] ?? BAN_NONE),
    ban3: String(data.ban3 ?? bans[2] ?? BAN_NONE),
    hunter: String(data.hunter ?? ""),
    season: String(data.season ?? ""),
  };
}

export default function Home() {
  const [services, setServices] = useState<FirebaseServices | null>(null);
  const [firebaseChecked, setFirebaseChecked] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const [view, setView] = useState<ViewName>("main");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [selectedMap, setSelectedMap] = useState("");
  const [bans, setBans] = useState<string[]>(
    Array(DEFAULT_SETTINGS.banSlots).fill(BAN_NONE),
  );
  const [actualHunter, setActualHunter] = useState("");
  const [prediction, setPrediction] =
    useState<PredictionResult>(emptyPrediction);
  const [hasSearched, setHasSearched] = useState(false);
  const [mapRecords, setMapRecords] = useState<MatchRecord[]>([]);
  const [demoAdded, setDemoAdded] = useState<MatchRecord[]>([]);
  const [loadingMap, setLoadingMap] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [recentRecords, setRecentRecords] = useState<MatchRecord[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteDate, setDeleteDate] = useState("");
  const [deleteTime, setDeleteTime] = useState("");
  const cacheRef = useRef<Map<string, MatchRecord[]>>(new Map());

  const signedIn = Boolean(user || demoMode);
  const displayName =
    user?.displayName || user?.email?.split("@")[0] || (demoMode ? "デモユーザー" : "");

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  useEffect(() => {
    let unsubscribe = () => {};
    loadFirebaseServices()
      .then((loaded) => {
        setServices(loaded);
        if (loaded) {
          unsubscribe = onAuthStateChanged(loaded.auth, setUser);
        }
      })
      .finally(() => setFirebaseChecked(true));
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    if (demoMode || !services) {
      queueMicrotask(() => setSettings(DEFAULT_SETTINGS));
      return;
    }
    getDoc(doc(services.db, "settings", "global"))
      .then((snapshot) => {
        if (!snapshot.exists()) return;
        const data = snapshot.data() as Partial<AppSettings>;
        setSettings({
          maps: Array.isArray(data.maps) ? data.maps : DEFAULT_SETTINGS.maps,
          survivors: Array.isArray(data.survivors)
            ? data.survivors
            : DEFAULT_SETTINGS.survivors,
          hunters: Array.isArray(data.hunters)
            ? data.hunters
            : DEFAULT_SETTINGS.hunters,
          banSlots:
            typeof data.banSlots === "number"
              ? Math.min(6, Math.max(1, data.banSlots))
              : DEFAULT_SETTINGS.banSlots,
          currentSeason:
            typeof data.currentSeason === "string"
              ? data.currentSeason
              : DEFAULT_SETTINGS.currentSeason,
        });
      })
      .catch(() => notify("設定の読み込みに失敗しました"));
  }, [demoMode, notify, services, signedIn]);

  useEffect(() => {
    queueMicrotask(() =>
      setBans((current) =>
        Array.from(
          { length: settings.banSlots },
          (_, index) => current[index] ?? BAN_NONE,
        ),
      ),
    );
  }, [settings.banSlots]);

  const fetchMapRecords = useCallback(
    async (map: string, force = false) => {
      if (!map) return [];
      if (demoMode || !services) {
        const records = [...demoRecords, ...demoAdded].filter(
          (record) => record.map === map,
        );
        setMapRecords(records);
        return records;
      }
      if (!force && cacheRef.current.has(map)) {
        const cached = cacheRef.current.get(map) ?? [];
        setMapRecords(cached);
        return cached;
      }
      setLoadingMap(true);
      try {
        const snapshots = await getDocs(
          query(
            collection(services.db, "matches"),
            where("map", "==", map),
            limit(5000),
          ),
        );
        const records = snapshots.docs.map(recordFromDoc);
        cacheRef.current.set(map, records);
        setMapRecords(records);
        return records;
      } catch {
        notify("共有データを取得できませんでした");
        return [];
      } finally {
        setLoadingMap(false);
      }
    },
    [demoAdded, demoMode, notify, services],
  );

  const chooseMap = (map: string) => {
    setSelectedMap(map);
    setHasSearched(false);
    setPrediction(emptyPrediction);
    setActualHunter("");
    void fetchMapRecords(map);
  };

  const duplicateBan = useMemo(() => {
    const active = bans.filter((ban) => ban !== BAN_NONE);
    return new Set(active).size !== active.length;
  }, [bans]);

  const runPrediction = async () => {
    if (!selectedMap) {
      notify("マップを選択してください");
      return;
    }
    if (duplicateBan) {
      notify("同じサバイバーは複数選択できません");
      return;
    }
    const records =
      mapRecords.length || cacheRef.current.has(selectedMap)
        ? mapRecords
        : await fetchMapRecords(selectedMap);
    setPrediction(buildPrediction(records, selectedMap, bans));
    setHasSearched(true);
  };

  const saveMatch = async (
    map: string,
    selectedBans: string[],
    hunter: string,
  ) => {
    const uniqueBanCount = normalizeBans(selectedBans).length;
    const activeBanCount = selectedBans.filter((ban) => ban !== BAN_NONE).length;
    if (!map || !hunter || uniqueBanCount !== activeBanCount) {
      notify("マップ・BAN・ハンターを確認してください");
      return false;
    }
    const padded = Array.from(
      { length: Math.max(3, settings.banSlots) },
      (_, index) => selectedBans[index] ?? BAN_NONE,
    );
    setBusy(true);
    try {
      if (demoMode || !services) {
        const newRecord: MatchRecord = {
          id: `demo-added-${Date.now()}`,
          registeredAt: new Date(),
          registeredByUid: "demo",
          registeredByName: "デモユーザー",
          map,
          bans: padded.slice(0, settings.banSlots),
          ban1: padded[0],
          ban2: padded[1],
          ban3: padded[2],
          hunter,
          season: settings.currentSeason,
        };
        setDemoAdded((current) => [...current, newRecord]);
      } else if (user) {
        const matchRef = doc(collection(services.db, "matches"));
        await setDoc(matchRef, {
          registeredAt: serverTimestamp(),
          registeredByUid: user.uid,
          registeredByName: displayName,
          map,
          bans: padded.slice(0, settings.banSlots),
          ban1: padded[0],
          ban2: padded[1],
          ban3: padded[2],
          hunter,
          season: settings.currentSeason,
        });
        cacheRef.current.delete(map);
      }
      notify("試合データを登録しました");
      return true;
    } catch {
      notify("登録に失敗しました。接続を確認してください");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const registerAfterSearch = async () => {
    if (!hasSearched || !actualHunter) {
      notify("実際のハンターを選択してください");
      return;
    }
    if (await saveMatch(selectedMap, bans, actualHunter)) {
      setSelectedMap("");
      setBans(Array(settings.banSlots).fill(BAN_NONE));
      setActualHunter("");
      setPrediction(emptyPrediction);
      setHasSearched(false);
      setMapRecords([]);
    }
  };

  const loadRecentRecords = useCallback(async () => {
    if (demoMode || !services) {
      setRecentRecords(
        [...demoRecords, ...demoAdded].sort(
          (a, b) =>
            (toDate(a.registeredAt)?.getTime() ?? 0) -
            (toDate(b.registeredAt)?.getTime() ?? 0),
        ),
      );
      return;
    }
    setBusy(true);
    try {
      const snapshots = await getDocs(
        query(
          collection(services.db, "matches"),
          orderBy("registeredAt", "desc"),
          limit(500),
        ),
      );
      setRecentRecords(
        snapshots.docs
          .map(recordFromDoc)
          .sort(
            (a, b) =>
              (toDate(a.registeredAt)?.getTime() ?? 0) -
              (toDate(b.registeredAt)?.getTime() ?? 0),
          ),
      );
    } catch {
      notify("登録データを取得できませんでした");
    } finally {
      setBusy(false);
    }
  }, [demoAdded, demoMode, notify, services]);

  useEffect(() => {
    if (view === "delete" && signedIn) {
      queueMicrotask(() => void loadRecentRecords());
    }
  }, [loadRecentRecords, signedIn, view]);

  const filteredRecords = useMemo(
    () =>
      recentRecords.filter((record) => {
        const date = toDate(record.registeredAt);
        if (!date) return !deleteDate && !deleteTime;
        const localDate = [
          date.getFullYear(),
          String(date.getMonth() + 1).padStart(2, "0"),
          String(date.getDate()).padStart(2, "0"),
        ].join("-");
        const localTime = `${String(date.getHours()).padStart(2, "0")}:${String(
          date.getMinutes(),
        ).padStart(2, "0")}`;
        return (
          (!deleteDate || localDate === deleteDate) &&
          (!deleteTime || localTime === deleteTime)
        );
      }),
    [deleteDate, deleteTime, recentRecords],
  );

  const deleteSelected = async () => {
    if (!selectedIds.size) {
      notify("削除するデータを選択してください");
      return;
    }
    if (!window.confirm(`${selectedIds.size}件のデータを削除しますか？`)) return;
    setBusy(true);
    try {
      if (demoMode || !services) {
        setDemoAdded((records) =>
          records.filter((record) => !selectedIds.has(record.id)),
        );
      } else {
        const batch = writeBatch(services.db);
        selectedIds.forEach((id) =>
          batch.delete(doc(services.db, "matches", id)),
        );
        await batch.commit();
        cacheRef.current.clear();
      }
      setRecentRecords((records) =>
        records.filter((record) => !selectedIds.has(record.id)),
      );
      notify(`${selectedIds.size}件を削除しました`);
      setSelectedIds(new Set());
    } catch {
      notify("削除に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = async (next: AppSettings) => {
    setBusy(true);
    try {
      if (!demoMode && services) {
        await setDoc(doc(services.db, "settings", "global"), next);
      }
      setSettings(next);
      cacheRef.current.clear();
      notify("システム設定を更新しました");
      setView("main");
    } catch {
      notify("設定の更新に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    if (services && user) await signOut(services.auth);
    setDemoMode(false);
    setView("main");
    setUser(null);
  };

  if (!firebaseChecked) {
    return <LoadingScreen />;
  }

  if (!signedIn) {
    return (
      <>
        <AuthScreen
          services={services}
          onDemo={() => setDemoMode(true)}
          onMessage={notify}
        />
        {toast && <div className="toast">{toast}</div>}
      </>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setView("main")}>
          <span className="brand-mark">V</span>
          <span>
            <strong>BAN PREDICTOR</strong>
            <small>Identity V Rank Intelligence</small>
          </span>
        </button>
        <div className="header-status">
          <span className="live-dot" />
          <span>{settings.currentSeason}</span>
          {demoMode && <span className="demo-badge">DEMO</span>}
        </div>
        <div className="account">
          <span className="avatar">{displayName.slice(0, 1).toUpperCase()}</span>
          <span className="account-name">{displayName}</span>
          <button className="text-button" onClick={logout}>
            ログアウト
          </button>
        </div>
      </header>

      <main className="content">
        {view === "main" && (
          <MainView
            settings={settings}
            selectedMap={selectedMap}
            chooseMap={chooseMap}
            bans={bans}
            setBans={setBans}
            duplicateBan={duplicateBan}
            loadingMap={loadingMap}
            mapRecords={mapRecords}
            runPrediction={runPrediction}
            prediction={prediction}
            hasSearched={hasSearched}
            actualHunter={actualHunter}
            setActualHunter={setActualHunter}
            registerAfterSearch={registerAfterSearch}
            busy={busy}
          />
        )}
        {view === "add" && (
          <AddView
            settings={settings}
            busy={busy}
            onSave={saveMatch}
            onBack={() => setView("main")}
          />
        )}
        {view === "delete" && (
          <DeleteView
            records={filteredRecords}
            selectedIds={selectedIds}
            setSelectedIds={setSelectedIds}
            date={deleteDate}
            setDate={setDeleteDate}
            time={deleteTime}
            setTime={setDeleteTime}
            onDelete={deleteSelected}
            busy={busy}
            onBack={() => setView("main")}
          />
        )}
        {view === "update" && (
          <SettingsView
            settings={settings}
            busy={busy}
            onSave={saveSettings}
            onBack={() => setView("main")}
          />
        )}
      </main>

      <nav className="utility-nav" aria-label="データ管理">
        <button
          className={view === "delete" ? "active" : ""}
          onClick={() => setView("delete")}
        >
          <span>⌫</span>削除
        </button>
        <button
          className={view === "update" ? "active" : ""}
          onClick={() => setView("update")}
        >
          <span>↻</span>更新
        </button>
        <button
          className={view === "add" ? "active" : ""}
          onClick={() => setView("add")}
        >
          <span>＋</span>データ追加
        </button>
      </nav>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="loading-screen" role="status">
      <span className="loader" />
      <p>共有データに接続しています</p>
    </div>
  );
}

function AuthScreen({
  services,
  onDemo,
  onMessage,
}: {
  services: FirebaseServices | null;
  onDemo: () => void;
  onMessage: (message: string) => void;
}) {
  const [registering, setRegistering] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!services) return;
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const username = String(form.get("username") ?? "").trim();
    setBusy(true);
    try {
      if (registering) {
        const credential = await createUserWithEmailAndPassword(
          services.auth,
          email,
          password,
        );
        if (username) await updateProfile(credential.user, { displayName: username });
        await setDoc(doc(services.db, "users", credential.user.uid), {
          userId: credential.user.uid,
          email,
          username: username || email.split("@")[0],
          createdAt: serverTimestamp(),
        });
        onMessage("アカウントを作成しました");
      } else {
        await signInWithEmailAndPassword(services.auth, email, password);
      }
    } catch (error) {
      const code =
        typeof error === "object" && error && "code" in error
          ? String(error.code)
          : "";
      const message = code.includes("invalid-credential")
        ? "ユーザーIDまたはパスワードが違います"
        : code.includes("email-already-in-use")
          ? "このユーザーIDは登録済みです"
          : code.includes("weak-password")
            ? "パスワードは6文字以上にしてください"
            : "認証できませんでした。入力内容を確認してください";
      onMessage(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-intro">
        <div className="auth-brand">
          <span className="brand-mark large">V</span>
          <span>BAN PREDICTOR</span>
        </div>
        <p className="eyebrow">IDENTITY V · RANK INTELLIGENCE</p>
        <h1>
          BANを選ぶ。
          <br />
          次の一手が見える。
        </h1>
        <p className="auth-copy">
          全ユーザーのランク戦データを集約し、現在のBAN構成からピックされやすいハンターを瞬時に予測します。
        </p>
        <div className="feature-row">
          <span><b>01</b> 3操作で検索</span>
          <span><b>02</b> 共有データで学習</span>
          <span><b>03</b> 結果から即登録</span>
        </div>
      </section>
      <section className="auth-panel">
        <p className="eyebrow">{registering ? "CREATE ACCOUNT" : "WELCOME BACK"}</p>
        <h2>{registering ? "アカウント作成" : "ログイン"}</h2>
        {services ? (
          <form onSubmit={submit}>
            {registering && (
              <label>
                ユーザー名 <small>任意</small>
                <input name="username" autoComplete="nickname" placeholder="表示名" />
              </label>
            )}
            <label>
              ユーザーID <small>メールアドレス</small>
              <input
                name="email"
                type="email"
                autoComplete="email"
                placeholder="player@example.com"
                required
              />
            </label>
            <label>
              パスワード
              <input
                name="password"
                type="password"
                minLength={6}
                autoComplete={registering ? "new-password" : "current-password"}
                placeholder="6文字以上"
                required
              />
            </label>
            <button className="primary-button auth-submit" disabled={busy}>
              {busy ? "処理中..." : registering ? "アカウントを作成" : "ログイン"}
            </button>
          </form>
        ) : (
          <div className="setup-notice">
            <strong>Firebaseの接続設定が必要です</strong>
            <p>
              公開用のFirebase設定を反映すると、アカウント作成と全ユーザー共有が有効になります。
            </p>
          </div>
        )}
        <button
          className="switch-auth"
          onClick={() => setRegistering((value) => !value)}
          disabled={!services}
        >
          {registering
            ? "登録済みの方はこちら →"
            : "はじめての方はアカウント作成 →"}
        </button>
        {!services && (
          <button className="demo-button" onClick={onDemo}>
            デモデータで画面を試す
          </button>
        )}
      </section>
    </main>
  );
}

function MainView({
  settings,
  selectedMap,
  chooseMap,
  bans,
  setBans,
  duplicateBan,
  loadingMap,
  mapRecords,
  runPrediction,
  prediction,
  hasSearched,
  actualHunter,
  setActualHunter,
  registerAfterSearch,
  busy,
}: {
  settings: AppSettings;
  selectedMap: string;
  chooseMap: (map: string) => void;
  bans: string[];
  setBans: (value: string[]) => void;
  duplicateBan: boolean;
  loadingMap: boolean;
  mapRecords: MatchRecord[];
  runPrediction: () => void;
  prediction: PredictionResult;
  hasSearched: boolean;
  actualHunter: string;
  setActualHunter: (value: string) => void;
  registerAfterSearch: () => void;
  busy: boolean;
}) {
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">LIVE MATCH TOOL</p>
          <h1>ハンター予測</h1>
        </div>
        <p>マップとBANを選択して、予測を実行</p>
      </div>
      <div className="main-grid">
        <section className="panel search-panel">
          <div className="step-head">
            <span>01</span>
            <div>
              <h2>マップ</h2>
              <p>使用マップを1つ選択</p>
            </div>
            {selectedMap && <b className="done">選択済</b>}
          </div>
          <div className="map-grid">
            {settings.maps.map((map) => (
              <button
                key={map}
                className={selectedMap === map ? "selected" : ""}
                onClick={() => chooseMap(map)}
              >
                {map}
              </button>
            ))}
          </div>

          <div className="divider" />

          <div className="step-head">
            <span>02</span>
            <div>
              <h2>BANサバイバー</h2>
              <p>最大{settings.banSlots}人・BANなし対応</p>
            </div>
            <b className="ban-count">
              {normalizeBans(bans).length}/{settings.banSlots}
            </b>
          </div>
          <div className="ban-row">
            {bans.map((ban, index) => (
              <label key={index}>
                <small>BAN {index + 1}</small>
                <select
                  value={ban}
                  onChange={(event) => {
                    const next = [...bans];
                    next[index] = event.target.value;
                    setBans(next);
                  }}
                >
                  <option>{BAN_NONE}</option>
                  {settings.survivors.map((survivor) => (
                    <option key={survivor}>{survivor}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {duplicateBan && (
            <p className="form-error">同じサバイバーが重複しています</p>
          )}
          <button
            className="primary-button search-button"
            onClick={runPrediction}
            disabled={!selectedMap || duplicateBan || loadingMap}
          >
            <span>予測を実行</span>
            <small>
              {loadingMap
                ? "データを先読み中..."
                : selectedMap
                  ? `${mapRecords.length}件を即時集計`
                  : "マップを選択してください"}
            </small>
          </button>
        </section>

        <section className="panel result-panel">
          <div className="result-title">
            <div>
              <p className="eyebrow">PREDICTION</p>
              <h2>ピック予測</h2>
            </div>
            {hasSearched && (
              <span className="sample-total">使用データ {prediction.total}件</span>
            )}
          </div>
          {!hasSearched ? (
            <div className="empty-result">
              <span className="radar-mark">◎</span>
              <h3>予測待機中</h3>
              <p>左側でマップとBANを選択し、予測を実行してください。</p>
            </div>
          ) : prediction.rows.length ? (
            <>
              {prediction.basis === "map" && (
                <div className="fallback-note">
                  同じBAN構成の実績がないため、同一マップ全体から予測しています。
                </div>
              )}
              <div className="prediction-head">
                <span>ハンター</span>
                <span>予測率</span>
                <span>使用データ数</span>
              </div>
              <ol className="prediction-list">
                {prediction.rows.map((row, index) => (
                  <li key={row.hunter}>
                    <span className="rank">{String(index + 1).padStart(2, "0")}</span>
                    <strong>{row.hunter}</strong>
                    <div className="probability">
                      <span style={{ width: `${row.probability}%` }} />
                    </div>
                    <b>{row.probability}%</b>
                    <small>{row.count}件</small>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <div className="empty-result">
              <span className="radar-mark">0</span>
              <h3>該当データがありません</h3>
              <p>この試合の結果を登録すると、次回から予測に反映されます。</p>
            </div>
          )}

          <div className={`actual-register ${hasSearched ? "visible" : ""}`}>
            <div>
              <p className="eyebrow">MATCH RESULT</p>
              <h3>実際にピックされたハンター</h3>
            </div>
            <div className="register-row">
              <select
                value={actualHunter}
                onChange={(event) => setActualHunter(event.target.value)}
                disabled={!hasSearched}
              >
                <option value="">ハンターを選択</option>
                {settings.hunters.map((hunter) => (
                  <option key={hunter}>{hunter}</option>
                ))}
              </select>
              <button
                className="accent-button"
                onClick={registerAfterSearch}
                disabled={!actualHunter || busy}
              >
                {busy ? "登録中..." : "登録"}
              </button>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

function AddView({
  settings,
  busy,
  onSave,
  onBack,
}: {
  settings: AppSettings;
  busy: boolean;
  onSave: (map: string, bans: string[], hunter: string) => Promise<boolean>;
  onBack: () => void;
}) {
  const [map, setMap] = useState("");
  const [bans, setBans] = useState<string[]>(
    Array(settings.banSlots).fill(BAN_NONE),
  );
  const [hunter, setHunter] = useState("");
  const duplicate = normalizeBans(bans).length !== bans.filter((b) => b !== BAN_NONE).length;

  return (
    <AuxiliaryPage
      eyebrow="QUICK ENTRY"
      title="データ追加"
      description="検索を行わず、試合結果だけを登録します。"
      onBack={onBack}
    >
      <section className="panel form-panel">
        <div className="form-grid">
          <label>
            マップ
            <select value={map} onChange={(event) => setMap(event.target.value)}>
              <option value="">マップを選択</option>
              {settings.maps.map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
          {bans.map((ban, index) => (
            <label key={index}>
              BAN {index + 1}
              <select
                value={ban}
                onChange={(event) => {
                  const next = [...bans];
                  next[index] = event.target.value;
                  setBans(next);
                }}
              >
                <option>{BAN_NONE}</option>
                {settings.survivors.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
          ))}
          <label className="wide">
            実際のハンター
            <select
              value={hunter}
              onChange={(event) => setHunter(event.target.value)}
            >
              <option value="">ハンターを選択</option>
              {settings.hunters.map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
        </div>
        {duplicate && <p className="form-error">同じサバイバーが重複しています</p>}
        <button
          className="primary-button auxiliary-submit"
          disabled={!map || !hunter || duplicate || busy}
          onClick={async () => {
            if (await onSave(map, bans, hunter)) {
              setMap("");
              setBans(Array(settings.banSlots).fill(BAN_NONE));
              setHunter("");
            }
          }}
        >
          {busy ? "登録中..." : "試合データを登録"}
        </button>
      </section>
    </AuxiliaryPage>
  );
}

function DeleteView({
  records,
  selectedIds,
  setSelectedIds,
  date,
  setDate,
  time,
  setTime,
  onDelete,
  busy,
  onBack,
}: {
  records: MatchRecord[];
  selectedIds: Set<string>;
  setSelectedIds: (ids: Set<string>) => void;
  date: string;
  setDate: (value: string) => void;
  time: string;
  setTime: (value: string) => void;
  onDelete: () => void;
  busy: boolean;
  onBack: () => void;
}) {
  const allSelected =
    records.length > 0 && records.every((record) => selectedIds.has(record.id));

  return (
    <AuxiliaryPage
      eyebrow="DATA CONTROL"
      title="登録データの削除"
      description="登録日時で絞り込み、複数件をまとめて削除できます。"
      onBack={onBack}
    >
      <section className="panel delete-panel">
        <div className="filter-bar">
          <label>
            登録日
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label>
            登録時間
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
          <button
            className="secondary-button"
            onClick={() => {
              setDate("");
              setTime("");
            }}
          >
            条件をクリア
          </button>
          <span className="record-count">{records.length}件</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>
                  <input
                    aria-label="すべて選択"
                    type="checkbox"
                    checked={allSelected}
                    onChange={() =>
                      setSelectedIds(
                        allSelected
                          ? new Set()
                          : new Set(records.map((record) => record.id)),
                      )
                    }
                  />
                </th>
                <th>No.</th>
                <th>登録日時</th>
                <th>登録者</th>
                <th>マップ</th>
                <th>BAN</th>
                <th>ハンター</th>
                <th>シーズン</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record, index) => (
                <tr key={record.id}>
                  <td>
                    <input
                      aria-label={`${index + 1}件目を選択`}
                      type="checkbox"
                      checked={selectedIds.has(record.id)}
                      onChange={() => {
                        const next = new Set(selectedIds);
                        if (next.has(record.id)) next.delete(record.id);
                        else next.add(record.id);
                        setSelectedIds(next);
                      }}
                    />
                  </td>
                  <td>{index + 1}</td>
                  <td>{formatDateTime(record.registeredAt)}</td>
                  <td>{record.registeredByName}</td>
                  <td>{record.map}</td>
                  <td>{record.bans.join(" / ")}</td>
                  <td><strong>{record.hunter}</strong></td>
                  <td>{record.season}</td>
                </tr>
              ))}
              {!records.length && (
                <tr>
                  <td colSpan={8} className="empty-table">条件に一致するデータがありません</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="delete-actions">
          <span>{selectedIds.size}件を選択中</span>
          <button
            className="danger-button"
            disabled={!selectedIds.size || busy}
            onClick={onDelete}
          >
            選択したデータを削除
          </button>
        </div>
      </section>
    </AuxiliaryPage>
  );
}

function SettingsView({
  settings,
  busy,
  onSave,
  onBack,
}: {
  settings: AppSettings;
  busy: boolean;
  onSave: (settings: AppSettings) => void;
  onBack: () => void;
}) {
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [tab, setTab] = useState<"survivors" | "hunters" | "maps">("survivors");
  const [newItem, setNewItem] = useState("");
  const labels = {
    survivors: "サバイバー",
    hunters: "ハンター",
    maps: "マップ",
  };

  const list = draft[tab];
  const addItem = () => {
    const value = newItem.trim();
    if (!value || list.includes(value)) return;
    setDraft({ ...draft, [tab]: [...list, value] });
    setNewItem("");
  };

  return (
    <AuxiliaryPage
      eyebrow="SYSTEM MASTER"
      title="マスターデータ更新"
      description="ゲームのアップデートに合わせて選択肢とBAN数を変更します。"
      onBack={onBack}
    >
      <div className="settings-grid">
        <section className="panel settings-summary">
          <h2>基本設定</h2>
          <label>
            現在のシーズン
            <input
              value={draft.currentSeason}
              onChange={(event) =>
                setDraft({ ...draft, currentSeason: event.target.value })
              }
            />
          </label>
          <label>
            BAN人数
            <select
              value={draft.banSlots}
              onChange={(event) =>
                setDraft({ ...draft, banSlots: Number(event.target.value) })
              }
            >
              {[1, 2, 3, 4, 5, 6].map((count) => (
                <option key={count} value={count}>{count}人</option>
              ))}
            </select>
          </label>
          <div className="master-counts">
            <span><b>{draft.survivors.length}</b>サバイバー</span>
            <span><b>{draft.hunters.length}</b>ハンター</span>
            <span><b>{draft.maps.length}</b>マップ</span>
          </div>
        </section>
        <section className="panel master-editor">
          <div className="tabs">
            {(["survivors", "hunters", "maps"] as const).map((key) => (
              <button
                key={key}
                className={tab === key ? "active" : ""}
                onClick={() => {
                  setTab(key);
                  setNewItem("");
                }}
              >
                {labels[key]}
              </button>
            ))}
          </div>
          <div className="add-master">
            <input
              value={newItem}
              onChange={(event) => setNewItem(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addItem();
              }}
              placeholder={`${labels[tab]}名を入力`}
            />
            <button className="secondary-button" onClick={addItem}>追加</button>
          </div>
          <div className="master-list">
            {list.map((item) => (
              <span key={item}>
                {item}
                <button
                  aria-label={`${item}を削除`}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      [tab]: list.filter((value) => value !== item),
                    })
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </section>
      </div>
      <div className="settings-actions">
        <button className="primary-button" disabled={busy} onClick={() => onSave(draft)}>
          {busy ? "保存中..." : "変更を保存"}
        </button>
      </div>
    </AuxiliaryPage>
  );
}

function AuxiliaryPage({
  eyebrow,
  title,
  description,
  onBack,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="page-heading auxiliary-heading">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <button className="secondary-button" onClick={onBack}>← メインに戻る</button>
      </div>
      {children}
    </>
  );
}
