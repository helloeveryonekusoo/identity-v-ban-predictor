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
  type Firestore,
} from "firebase/firestore";
import {
  FormEvent,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  ALL_HUNTERS,
  ALL_SEASONS,
  ALL_USERS,
  BAN_NONE,
  BAN_ORDER_LABELS,
  DEFAULT_SETTINGS,
  DEMO_MATCHES,
  DEMO_SEASONS,
  HUNTER_BAN_SLOTS,
  MASTER_LABELS,
  MAX_BAN_SLOTS,
  defaultPredictionConfig,
  normalizeSettings,
  resizeBanMatchWeights,
  splitSettings,
} from "./constants";
import { loadFirebaseServices, type FirebaseServices } from "./firebase";
import { PREDICTION_FACTORS, buildPrediction } from "./prediction";
import {
  activeRenames,
  applyRenamesToRecords,
  chunk,
  emptyRenamePlan,
  hasRenames,
  planRename,
  renameCount,
  renameFieldsForRecord,
} from "./records";
import {
  EMPTY_RECORD_QUERY,
  buildBanRanking,
  buildBanRateIndex,
  buildHunterRanking,
  buildMapHunterStats,
  collectHunters,
  collectRegistrants,
  collectSeasons,
  filterBySeason,
  filterRecords,
  normalizeBans,
  orderSurvivors,
} from "./stats";
import type {
  AppSettings,
  BanOrderMode,
  FactorConfig,
  MasterKind,
  MatchRecord,
  PredictionResult,
  PredictionRow,
  RankingResult,
  RecordQuery,
  RenamePlan,
  ViewName,
} from "./types";

const RECORD_LIMIT = 5000;

const emptyPrediction: PredictionResult = {
  rows: [],
  total: 0,
  exactCount: 0,
  basis: "",
  tiers: [],
  excludedHunters: [],
};

const demoRecords: MatchRecord[] = DEMO_MATCHES.map((row, index) => ({
  id: `demo-${index + 1}`,
  registeredAt: new Date(Date.now() - (DEMO_MATCHES.length - index) * 3600000),
  registeredByUid: index % 2 ? "demo-b" : "demo-a",
  registeredByName: index % 2 ? "デモユーザーB" : "デモユーザーA",
  map: row[0],
  bans: [row[1], row[2], row[3]],
  ban1: row[1],
  ban2: row[2],
  ban3: row[3],
  hunter: row[4],
  season: row[5],
}));

const demoSettings: AppSettings = normalizeSettings({
  ...DEFAULT_SETTINGS,
  seasons: DEMO_SEASONS,
  currentSeason: DEMO_SEASONS[0],
});

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

/** 根拠の一覧は列が多いので、年を省いた短い表記にする。 */
function formatDateTimeShort(value: MatchRecord["registeredAt"]) {
  const date = toDate(value);
  if (!date) return "登録処理中";
  return new Intl.DateTimeFormat("ja-JP", {
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

/**
 * 名称変更の対象データを集める。
 * ローカルに読み込み済みのデータに加え、変更前の名称でFirestoreを直接検索し、
 * 未読み込みのデータも取りこぼさないようにする。
 */
async function collectRenameTargets(
  db: Firestore,
  plan: RenamePlan,
  localRecords: MatchRecord[],
) {
  const targets = new Map<string, MatchRecord>();
  localRecords.forEach((record) => {
    if (renameFieldsForRecord(record, plan)) targets.set(record.id, record);
  });

  const lookups: { field: string; op: "==" | "array-contains"; value: string }[] =
    [];
  activeRenames(plan, "survivors").forEach(([from]) =>
    lookups.push({ field: "bans", op: "array-contains", value: from }),
  );
  activeRenames(plan, "maps").forEach(([from]) =>
    lookups.push({ field: "map", op: "==", value: from }),
  );
  activeRenames(plan, "hunters").forEach(([from]) =>
    lookups.push({ field: "hunter", op: "==", value: from }),
  );
  activeRenames(plan, "seasons").forEach(([from]) =>
    lookups.push({ field: "season", op: "==", value: from }),
  );

  for (const lookup of lookups) {
    const snapshots = await getDocs(
      query(collection(db, "matches"), where(lookup.field, lookup.op, lookup.value)),
    );
    snapshots.docs.forEach((snapshot) => {
      const record = recordFromDoc(snapshot);
      if (renameFieldsForRecord(record, plan)) targets.set(record.id, record);
    });
  }

  return [...targets.values()];
}

export default function Home() {
  const [services, setServices] = useState<FirebaseServices | null>(null);
  const [firebaseChecked, setFirebaseChecked] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const [view, setView] = useState<ViewName>("main");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  const [allRecords, setAllRecords] = useState<MatchRecord[]>([]);
  const [recordsLoaded, setRecordsLoaded] = useState(false);
  const [loadingRecords, setLoadingRecords] = useState(false);

  const [selectedMap, setSelectedMap] = useState("");
  const [bans, setBans] = useState<string[]>(
    Array(DEFAULT_SETTINGS.banSlots).fill(BAN_NONE),
  );
  const [hunterBans, setHunterBans] = useState<string[]>(
    Array(HUNTER_BAN_SLOTS).fill(BAN_NONE),
  );
  const [actualHunter, setActualHunter] = useState("");
  const [prediction, setPrediction] =
    useState<PredictionResult>(emptyPrediction);
  const [hasSearched, setHasSearched] = useState(false);

  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");

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

  const loadRecords = useCallback(async () => {
    if (!services) return;
    setLoadingRecords(true);
    try {
      const snapshots = await getDocs(
        query(
          collection(services.db, "matches"),
          orderBy("registeredAt", "desc"),
          limit(RECORD_LIMIT),
        ),
      );
      setAllRecords(snapshots.docs.map(recordFromDoc));
      setRecordsLoaded(true);
    } catch {
      notify("共有データを取得できませんでした");
    } finally {
      setLoadingRecords(false);
    }
  }, [notify, services]);

  useEffect(() => {
    if (!signedIn) return;
    if (demoMode || !services) {
      queueMicrotask(() => {
        setSettings(demoSettings);
        setAllRecords(demoRecords);
        setRecordsLoaded(true);
      });
      return;
    }
    // マスターデータは全員で共有、それ以外の設定はユーザーごとに読み込む。
    // ユーザー設定がまだ無いときは、共有ドキュメントの値をシステム既定として使う。
    Promise.all([
      getDoc(doc(services.db, "settings", "global")),
      user
        ? getDoc(doc(services.db, "userSettings", user.uid))
        : Promise.resolve(null),
    ])
      .then(([globalSnapshot, userSnapshot]) => {
        const shared = globalSnapshot.exists() ? globalSnapshot.data() : {};
        const personal =
          userSnapshot && userSnapshot.exists() ? userSnapshot.data() : {};
        setSettings(normalizeSettings({ ...shared, ...personal }));
      })
      .catch(() => notify("設定の読み込みに失敗しました"));
    queueMicrotask(() => void loadRecords());
  }, [demoMode, loadRecords, notify, services, signedIn, user]);

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

  // 設定に登録されたデフォルトハンターBANを、検索画面の初期選択にする。
  // 未登録なら「BANなし」のまま（＝何も選択されていない状態）。
  useEffect(() => {
    const defaults = settings.defaultHunterBans;
    queueMicrotask(() =>
      setHunterBans(
        Array.from(
          { length: HUNTER_BAN_SLOTS },
          (_, index) => defaults[index] ?? BAN_NONE,
        ),
      ),
    );
  }, [settings.defaultHunterBans]);

  const banRateIndex = useMemo(() => buildBanRateIndex(allRecords), [allRecords]);

  const survivorOptions = useMemo(
    () => orderSurvivors(settings.survivors, settings.banOrderMode, banRateIndex),
    [banRateIndex, settings.banOrderMode, settings.survivors],
  );

  const seasonOptions = useMemo(
    () => collectSeasons(allRecords, settings.seasons),
    [allRecords, settings.seasons],
  );

  const registrants = useMemo(() => collectRegistrants(allRecords), [allRecords]);

  const hunterOptions = useMemo(
    () => collectHunters(allRecords, settings.hunters),
    [allRecords, settings.hunters],
  );

  const mapRecordCount = useMemo(
    () =>
      selectedMap
        ? allRecords.filter((record) => record.map === selectedMap).length
        : 0,
    [allRecords, selectedMap],
  );

  const duplicateBan = useMemo(() => {
    const active = bans.filter((ban) => ban !== BAN_NONE);
    return new Set(active).size !== active.length;
  }, [bans]);

  const duplicateHunterBan = useMemo(() => {
    const active = hunterBans.filter((hunter) => hunter !== BAN_NONE);
    return new Set(active).size !== active.length;
  }, [hunterBans]);

  const chooseMap = (map: string) => {
    setSelectedMap(map);
    setHasSearched(false);
    setPrediction(emptyPrediction);
    setActualHunter("");
  };

  const runPrediction = () => {
    if (!selectedMap) {
      notify("マップを選択してください");
      return;
    }
    if (duplicateBan) {
      notify("同じサバイバーは複数選択できません");
      return;
    }
    if (duplicateHunterBan) {
      notify("同じハンターは複数選択できません");
      return;
    }
    setPrediction(
      buildPrediction(
        allRecords,
        {
          map: selectedMap,
          bans,
          hunterBans,
          season: settings.currentSeason,
        },
        settings,
        banRateIndex,
      ),
    );
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
    const payload = {
      map,
      bans: padded.slice(0, settings.banSlots),
      ban1: padded[0],
      ban2: padded[1],
      ban3: padded[2],
      hunter,
      season: settings.currentSeason,
    };
    setBusy(true);
    try {
      if (demoMode || !services || !user) {
        setAllRecords((records) => [
          {
            id: `local-${Date.now()}`,
            registeredAt: new Date(),
            registeredByUid: "demo",
            registeredByName: "デモユーザー",
            ...payload,
          },
          ...records,
        ]);
      } else {
        const matchRef = doc(collection(services.db, "matches"));
        await setDoc(matchRef, {
          registeredAt: serverTimestamp(),
          registeredByUid: user.uid,
          registeredByName: displayName,
          ...payload,
        });
        setAllRecords((records) => [
          {
            id: matchRef.id,
            registeredAt: new Date(),
            registeredByUid: user.uid,
            registeredByName: displayName,
            ...payload,
          },
          ...records,
        ]);
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
      // ハンターBANは設定した初期値へ戻す（試合ごとに選び直す手間を減らす）。
      setHunterBans(
        Array.from(
          { length: HUNTER_BAN_SLOTS },
          (_, index) => settings.defaultHunterBans[index] ?? BAN_NONE,
        ),
      );
      setActualHunter("");
      setPrediction(emptyPrediction);
      setHasSearched(false);
    }
  };

  const sortedRecords = useMemo(
    () =>
      [...allRecords].sort(
        (a, b) =>
          (toDate(b.registeredAt)?.getTime() ?? 0) -
          (toDate(a.registeredAt)?.getTime() ?? 0),
      ),
    [allRecords],
  );

  const deleteRecords = async (ids: Set<string>) => {
    if (!ids.size) {
      notify("削除するデータを選択してください");
      return false;
    }
    if (!window.confirm(`${ids.size}件のデータを削除しますか？`)) return false;
    setBusy(true);
    try {
      if (!demoMode && services) {
        for (const group of chunk([...ids])) {
          const batch = writeBatch(services.db);
          group.forEach((id) => batch.delete(doc(services.db, "matches", id)));
          await batch.commit();
        }
      }
      setAllRecords((records) => records.filter((record) => !ids.has(record.id)));
      notify(`${ids.size}件を削除しました`);
      return true;
    } catch {
      notify("削除に失敗しました");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = async (next: AppSettings, plan: RenamePlan) => {
    const normalized = normalizeSettings(next);
    const renames = renameCount(plan);
    setBusy(true);
    try {
      if (!demoMode && services) {
        if (hasRenames(plan)) {
          const targets = await collectRenameTargets(services.db, plan, allRecords);
          for (const group of chunk(targets)) {
            const batch = writeBatch(services.db);
            group.forEach((record) => {
              const changes = renameFieldsForRecord(record, plan);
              if (changes) {
                batch.update(
                  doc(services.db, "matches", record.id),
                  changes as Record<string, unknown>,
                );
              }
            });
            await batch.commit();
          }
        }
        // マスターデータだけを共有ドキュメントへ、それ以外は本人のドキュメントへ。
        const { shared, user: personal } = splitSettings(normalized);
        await setDoc(doc(services.db, "settings", "global"), shared);
        if (user) {
          await setDoc(doc(services.db, "userSettings", user.uid), personal);
        }
      }
      setAllRecords((records) => applyRenamesToRecords(records, plan));
      setSettings(normalized);
      setPrediction(emptyPrediction);
      setHasSearched(false);
      notify(
        renames
          ? `設定を更新し、${renames}件の名称を登録データへ反映しました`
          : "設定を更新しました（基本設定はあなた専用です）",
      );
      setView("main");
      return true;
    } catch {
      notify("設定の更新に失敗しました");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    if (services && user) await signOut(services.auth);
    setDemoMode(false);
    setView("main");
    setUser(null);
    setAllRecords([]);
    setRecordsLoaded(false);
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
          <span className="header-count">{allRecords.length}件</span>
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
            survivorOptions={survivorOptions}
            selectedMap={selectedMap}
            chooseMap={chooseMap}
            bans={bans}
            setBans={setBans}
            duplicateBan={duplicateBan}
            hunterBans={hunterBans}
            setHunterBans={setHunterBans}
            duplicateHunterBan={duplicateHunterBan}
            loadingRecords={loadingRecords}
            totalRecords={allRecords.length}
            mapRecordCount={mapRecordCount}
            runPrediction={runPrediction}
            prediction={prediction}
            hasSearched={hasSearched}
            actualHunter={actualHunter}
            setActualHunter={setActualHunter}
            registerAfterSearch={registerAfterSearch}
            busy={busy}
          />
        )}
        {view === "stats" && (
          <StatsView
            records={allRecords}
            seasons={seasonOptions}
            loading={loadingRecords || !recordsLoaded}
            onBack={() => setView("main")}
          />
        )}
        {view === "browse" && (
          <BrowseView
            records={sortedRecords}
            seasons={seasonOptions}
            registrants={registrants}
            hunters={hunterOptions}
            loading={loadingRecords || !recordsLoaded}
            onBack={() => setView("main")}
          />
        )}
        {view === "add" && (
          <AddView
            settings={settings}
            survivorOptions={survivorOptions}
            busy={busy}
            onSave={saveMatch}
            onBack={() => setView("main")}
          />
        )}
        {view === "delete" && (
          <DeleteView
            records={sortedRecords}
            seasons={seasonOptions}
            registrants={registrants}
            hunters={hunterOptions}
            onDelete={deleteRecords}
            busy={busy}
            onBack={() => setView("main")}
          />
        )}
        {view === "update" && (
          <SettingsView
            settings={settings}
            records={allRecords}
            busy={busy}
            onSave={saveSettings}
            onBack={() => setView("main")}
          />
        )}
      </main>

      <nav className="utility-nav" aria-label="データ管理">
        <button
          className={view === "stats" ? "active" : ""}
          onClick={() => setView("stats")}
        >
          <span>▦</span>Ban集計
        </button>
        <button
          className={view === "browse" ? "active" : ""}
          onClick={() => setView("browse")}
        >
          <span>☰</span>データ閲覧
        </button>
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
  survivorOptions,
  selectedMap,
  chooseMap,
  bans,
  setBans,
  duplicateBan,
  hunterBans,
  setHunterBans,
  duplicateHunterBan,
  loadingRecords,
  totalRecords,
  mapRecordCount,
  runPrediction,
  prediction,
  hasSearched,
  actualHunter,
  setActualHunter,
  registerAfterSearch,
  busy,
}: {
  settings: AppSettings;
  survivorOptions: string[];
  selectedMap: string;
  chooseMap: (map: string) => void;
  bans: string[];
  setBans: (value: string[]) => void;
  duplicateBan: boolean;
  hunterBans: string[];
  setHunterBans: (value: string[]) => void;
  duplicateHunterBan: boolean;
  loadingRecords: boolean;
  totalRecords: number;
  mapRecordCount: number;
  runPrediction: () => void;
  prediction: PredictionResult;
  hasSearched: boolean;
  actualHunter: string;
  setActualHunter: (value: string) => void;
  registerAfterSearch: () => void;
  busy: boolean;
}) {
  // 予測を実行し直したら、開いていた根拠の一覧は閉じる。
  const [openHunter, setOpenHunter] = useState("");
  const [shownPrediction, setShownPrediction] = useState(prediction);
  if (shownPrediction !== prediction) {
    setShownPrediction(prediction);
    setOpenHunter("");
  }

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
              <p>使用マップを1つ選択（絞り込みではなく加点要素）</p>
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
              <p>
                最大{settings.banSlots}人・順不同／表示は
                {BAN_ORDER_LABELS[settings.banOrderMode]}
              </p>
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
                  {survivorOptions.map((survivor) => (
                    <option key={survivor}>{survivor}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {duplicateBan && (
            <p className="form-error">同じサバイバーが重複しています</p>
          )}

          <div className="divider" />

          <div className="step-head">
            <span>03</span>
            <div>
              <h2>BANハンター</h2>
              <p>選んだハンターは予測結果から除外されます</p>
            </div>
            <b className="ban-count">
              {normalizeBans(hunterBans).length}/{HUNTER_BAN_SLOTS}
            </b>
          </div>
          <div className="ban-row">
            {hunterBans.map((hunter, index) => (
              <label key={index}>
                <small>BAN {index + 1}</small>
                <select
                  value={hunter}
                  onChange={(event) => {
                    const next = [...hunterBans];
                    next[index] = event.target.value;
                    setHunterBans(next);
                  }}
                >
                  <option>{BAN_NONE}</option>
                  {settings.hunters.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {duplicateHunterBan && (
            <p className="form-error">同じハンターが重複しています</p>
          )}
          <button
            className="primary-button search-button"
            onClick={runPrediction}
            disabled={
              !selectedMap ||
              duplicateBan ||
              duplicateHunterBan ||
              loadingRecords
            }
          >
            <span>予測を実行</span>
            <small>
              {loadingRecords
                ? "データを読み込み中..."
                : selectedMap
                  ? `全${totalRecords}件から算出（マップ一致${mapRecordCount}件は加点）`
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
              <div className="fallback-note">{prediction.basis}</div>
              {prediction.excludedHunters.length > 0 && (
                <div className="excluded-note">
                  BANにより除外:{" "}
                  <b>{prediction.excludedHunters.join("・")}</b>
                </div>
              )}
              {prediction.tiers.length > 0 && (
                <div className="tier-row">
                  {prediction.tiers.map((tier) => (
                    <span key={tier.label}>
                      {tier.label}
                      <b>{tier.count}件</b>
                    </span>
                  ))}
                </div>
              )}
              <p className="evidence-hint">
                順位はまず一致度で決まり、同じ一致度の中だけで件数と補正が効きます。
                ハンターの行をクリックすると、使われたデータとスコアの内訳を表示します。
              </p>
              <div className="prediction-head">
                <span>ハンター</span>
                <span>予測率</span>
                <span>使用データ数</span>
              </div>
              <ol className="prediction-list">
                {prediction.rows.map((row, index) => {
                  const open = openHunter === row.hunter;
                  return (
                    <li key={row.hunter} className={open ? "open" : ""}>
                      <button
                        type="button"
                        className="prediction-row"
                        aria-expanded={open}
                        onClick={() => setOpenHunter(open ? "" : row.hunter)}
                      >
                        <span className="rank">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <strong>
                          {row.hunter}
                          <small className="match-tag">{row.matchLabel}</small>
                        </strong>
                        <div className="probability">
                          <span style={{ width: `${row.probability}%` }} />
                        </div>
                        <b>{row.probability}%</b>
                        <small>{row.count}件</small>
                        <span className="row-caret" aria-hidden="true">
                          {open ? "▲" : "▼"}
                        </span>
                      </button>
                      {open && <EvidencePanel row={row} />}
                    </li>
                  );
                })}
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

function RankingTable({
  ranking,
  nameLabel,
  countLabel,
  rateLabel,
  rateHint,
}: {
  ranking: RankingResult;
  nameLabel: string;
  countLabel: string;
  rateLabel: string;
  rateHint: string;
}) {
  const max = ranking.rows[0]?.rate ?? 0;

  if (!ranking.rows.length) {
    return (
      <div className="empty-result">
        <span className="radar-mark">0</span>
        <h3>データがありません</h3>
        <p>選択したシーズンに登録データがありません。</p>
      </div>
    );
  }

  return (
    <>
      <p className="ranking-hint">
        集計対象 <b>{ranking.totalMatches}</b> 試合 ／ {rateHint}
      </p>
      <div className="ranking-head">
        <span>順位</span>
        <span>{nameLabel}</span>
        <span>{countLabel}</span>
        <span>{rateLabel}</span>
      </div>
      <ol className="ranking-list">
        {ranking.rows.map((row, index) => (
          <li key={row.name}>
            <span className="rank">{String(index + 1).padStart(2, "0")}</span>
            <strong>{row.name}</strong>
            <div className="probability">
              <span style={{ width: `${max ? (row.rate / max) * 100 : 0}%` }} />
            </div>
            <small>{row.count}回</small>
            <b>{row.rate.toFixed(1)}%</b>
          </li>
        ))}
      </ol>
    </>
  );
}

function StatsView({
  records,
  seasons,
  loading,
  onBack,
}: {
  records: MatchRecord[];
  seasons: string[];
  loading: boolean;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<"bans" | "hunters" | "maps">("bans");
  const [season, setSeason] = useState(ALL_SEASONS);
  const [focusMap, setFocusMap] = useState("");

  const seasonRecords = useMemo(
    () => filterBySeason(records, season),
    [records, season],
  );
  const banRanking = useMemo(
    () => buildBanRanking(seasonRecords),
    [seasonRecords],
  );
  const hunterRanking = useMemo(
    () => buildHunterRanking(seasonRecords),
    [seasonRecords],
  );
  const mapStats = useMemo(
    () => buildMapHunterStats(seasonRecords),
    [seasonRecords],
  );

  const activeMap =
    mapStats.find((item) => item.map === focusMap) ?? mapStats[0] ?? null;

  return (
    <AuxiliaryPage
      eyebrow="DATA INSIGHT"
      title="Ban集計"
      description="登録済みデータを集計し、BAN傾向とハンター使用率をシーズン別に確認します。"
      onBack={onBack}
    >
      <section className="panel stats-panel">
        <div className="tabs">
          <button
            className={tab === "bans" ? "active" : ""}
            onClick={() => setTab("bans")}
          >
            BANランキング
          </button>
          <button
            className={tab === "hunters" ? "active" : ""}
            onClick={() => setTab("hunters")}
          >
            ハンター使用率
          </button>
          <button
            className={tab === "maps" ? "active" : ""}
            onClick={() => setTab("maps")}
          >
            マップ別ハンター
          </button>
        </div>

        <div className="filter-bar">
          <label>
            シーズン
            <select
              value={season}
              onChange={(event) => setSeason(event.target.value)}
            >
              <option value={ALL_SEASONS}>全シーズン</option>
              {seasons.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
          </label>
          <span className="record-count">{seasonRecords.length}件</span>
        </div>

        <div className="stats-body">
          {loading ? (
            <div className="empty-result">
              <span className="loader" />
              <h3>集計中</h3>
              <p>共有データを読み込んでいます。</p>
            </div>
          ) : tab === "bans" ? (
            <RankingTable
              ranking={banRanking}
              nameLabel="サバイバー"
              countLabel="Ban回数"
              rateLabel="Ban率"
              rateHint="Ban率は「対象試合数のうちBANされた試合の割合」です"
            />
          ) : tab === "hunters" ? (
            <RankingTable
              ranking={hunterRanking}
              nameLabel="ハンター"
              countLabel="使用回数"
              rateLabel="使用率"
              rateHint="使用率は「対象試合数のうち実際にピックされた割合」です"
            />
          ) : !activeMap ? (
            <div className="empty-result">
              <span className="radar-mark">0</span>
              <h3>データがありません</h3>
              <p>選択したシーズンに登録データがありません。</p>
            </div>
          ) : (
            <>
              <div className="map-chip-row">
                {mapStats.map((item) => (
                  <button
                    key={item.map}
                    className={item.map === activeMap.map ? "selected" : ""}
                    onClick={() => setFocusMap(item.map)}
                  >
                    {item.map}
                    <b>{item.totalMatches}</b>
                  </button>
                ))}
              </div>
              <RankingTable
                ranking={{
                  rows: activeMap.rows,
                  totalMatches: activeMap.totalMatches,
                }}
                nameLabel={`${activeMap.map} のハンター`}
                countLabel="使用回数"
                rateLabel="使用率"
                rateHint="このマップの試合数に対する割合です"
              />
            </>
          )}
        </div>
      </section>
    </AuxiliaryPage>
  );
}

function AddView({
  settings,
  survivorOptions,
  busy,
  onSave,
  onBack,
}: {
  settings: AppSettings;
  survivorOptions: string[];
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
                {survivorOptions.map((item) => (
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

/**
 * 予測の根拠一覧。
 * 「そのハンターの全データ」ではなく、予測アルゴリズムが実際に採用したデータだけを
 * スコア（重み）と採用理由つきで表示する。
 */
function EvidencePanel({ row }: { row: PredictionRow }) {
  return (
    <div className="evidence">
      <div className="evidence-head">
        <strong>{row.hunter} の予測に使用したデータ</strong>
        <span>
          {row.contributions.length}件 ／ 合計スコア <b>{row.score}</b>
        </span>
      </div>
      <div className="table-wrap evidence-table">
        <table>
          <thead>
            <tr>
              <th>登録日時</th>
              <th>シーズン</th>
              <th>登録ユーザー</th>
              <th>マップ</th>
              <th>Ban1</th>
              <th>Ban2</th>
              <th>Ban3</th>
              <th>ハンター</th>
              <th>スコア</th>
            </tr>
          </thead>
          <tbody>
            {row.contributions.map((item) => (
              // 採用理由は横スクロールせず読めるよう、行の下へ全幅で表示する。
              <Fragment key={item.record.id}>
                <tr className="evidence-row">
                  <td>{formatDateTimeShort(item.record.registeredAt)}</td>
                  <td>{item.record.season}</td>
                  <td>{item.record.registeredByName}</td>
                  <td className={item.mapMatched ? "cell-hit" : ""}>
                    {item.record.map}
                  </td>
                  <td>{item.record.ban1}</td>
                  <td>{item.record.ban2}</td>
                  <td>{item.record.ban3}</td>
                  <td>
                    <strong>{item.record.hunter}</strong>
                  </td>
                  <td className="cell-score">
                    <b>{item.score}</b>
                    <small>{item.share}%</small>
                  </td>
                </tr>
                <tr className="reason-row">
                  <td colSpan={9}>
                    <span className="reason-tag">採用理由</span>
                    {item.reason}
                  </td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * データ閲覧・削除で共通の検索バー。
 * 条件を何も指定せずに検索した場合は全件検索として扱う。
 */
function RecordSearchBar({
  seasons,
  registrants,
  hunters,
  draft,
  setDraft,
  onSearch,
  onClear,
  count,
}: {
  seasons: string[];
  registrants: { uid: string; name: string; count: number }[];
  hunters: string[];
  draft: RecordQuery;
  setDraft: (value: RecordQuery) => void;
  onSearch: () => void;
  onClear: () => void;
  count: number;
}) {
  return (
    <div className="filter-bar">
      <label>
        シーズン
        <select
          value={draft.season}
          onChange={(event) =>
            setDraft({ ...draft, season: event.target.value })
          }
        >
          <option value={ALL_SEASONS}>すべて</option>
          {seasons.map((season) => (
            <option key={season} value={season}>{season}</option>
          ))}
        </select>
      </label>
      <label>
        登録ユーザー
        <select
          value={draft.registrant}
          onChange={(event) =>
            setDraft({ ...draft, registrant: event.target.value })
          }
        >
          <option value={ALL_USERS}>全ユーザー</option>
          {registrants.map((item) => (
            <option key={item.uid} value={item.uid}>
              {item.name}（{item.count}件）
            </option>
          ))}
        </select>
      </label>
      <label>
        ピックされたハンター
        <select
          value={draft.hunter}
          onChange={(event) =>
            setDraft({ ...draft, hunter: event.target.value })
          }
        >
          <option value={ALL_HUNTERS}>すべて</option>
          {hunters.map((hunter) => (
            <option key={hunter} value={hunter}>{hunter}</option>
          ))}
        </select>
      </label>
      <button className="primary-button filter-search" onClick={onSearch}>
        検索
      </button>
      <button className="secondary-button" onClick={onClear}>
        条件をクリア
      </button>
      <span className="record-count">{count}件</span>
    </div>
  );
}

/** データ閲覧・削除で共通の列。行頭の列（No. やチェックボックス）は呼び出し側が足す。 */
function RecordCells({ record }: { record: MatchRecord }) {
  return (
    <>
      <td>{formatDateTime(record.registeredAt)}</td>
      <td>{record.season}</td>
      <td>{record.registeredByName}</td>
      <td>{record.map}</td>
      <td>{record.ban1}</td>
      <td>{record.ban2}</td>
      <td>{record.ban3}</td>
      <td>
        <strong>{record.hunter}</strong>
      </td>
    </>
  );
}

const RECORD_COLUMNS = [
  "登録日時",
  "シーズン",
  "登録ユーザー",
  "マップ",
  "Ban1",
  "Ban2",
  "Ban3",
  "ピックされたハンター",
];

/** 検索条件を「入力中の値」と「適用済みの値」に分けて持つ。検索ボタンで確定する。 */
function useRecordSearch(records: MatchRecord[], onApply?: () => void) {
  const [draft, setDraft] = useState<RecordQuery>(EMPTY_RECORD_QUERY);
  const [applied, setApplied] = useState<RecordQuery>(EMPTY_RECORD_QUERY);

  const results = useMemo(
    () => filterRecords(records, applied),
    [applied, records],
  );

  const search = () => {
    setApplied(draft);
    onApply?.();
  };
  const clear = () => {
    setDraft(EMPTY_RECORD_QUERY);
    setApplied(EMPTY_RECORD_QUERY);
    onApply?.();
  };

  return { draft, setDraft, results, search, clear };
}

function BrowseView({
  records,
  seasons,
  registrants,
  hunters,
  loading,
  onBack,
}: {
  records: MatchRecord[];
  seasons: string[];
  registrants: { uid: string; name: string; count: number }[];
  hunters: string[];
  loading: boolean;
  onBack: () => void;
}) {
  const { draft, setDraft, results, search, clear } = useRecordSearch(records);

  return (
    <AuxiliaryPage
      eyebrow="DATA BROWSER"
      title="データ閲覧"
      description="登録されているすべての試合データを一覧で確認できます。シーズン・登録ユーザー・ピックされたハンターで絞り込めます。"
      onBack={onBack}
    >
      <section className="panel delete-panel">
        <RecordSearchBar
          seasons={seasons}
          registrants={registrants}
          hunters={hunters}
          draft={draft}
          setDraft={setDraft}
          onSearch={search}
          onClear={clear}
          count={results.length}
        />
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>No.</th>
                {RECORD_COLUMNS.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {results.map((record, index) => (
                <tr key={record.id}>
                  <td>{index + 1}</td>
                  <RecordCells record={record} />
                </tr>
              ))}
              {!results.length && (
                <tr>
                  <td colSpan={RECORD_COLUMNS.length + 1} className="empty-table">
                    {loading
                      ? "共有データを読み込んでいます..."
                      : "条件に一致するデータがありません"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </AuxiliaryPage>
  );
}

function DeleteView({
  records,
  seasons,
  registrants,
  hunters,
  onDelete,
  busy,
  onBack,
}: {
  records: MatchRecord[];
  seasons: string[];
  registrants: { uid: string; name: string; count: number }[];
  hunters: string[];
  onDelete: (ids: Set<string>) => Promise<boolean>;
  busy: boolean;
  onBack: () => void;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // 検索し直したときは選択を解除し、表示中のデータだけが削除対象になるようにする。
  const { draft, setDraft, results, search, clear } = useRecordSearch(
    records,
    () => setSelectedIds(new Set()),
  );

  const allSelected =
    results.length > 0 && results.every((record) => selectedIds.has(record.id));

  return (
    <AuxiliaryPage
      eyebrow="DATA CONTROL"
      title="登録データの削除"
      description="シーズン・登録ユーザー・ピックされたハンターで絞り込み、検索結果に表示されたデータだけをまとめて削除できます。"
      onBack={onBack}
    >
      <section className="panel delete-panel">
        <RecordSearchBar
          seasons={seasons}
          registrants={registrants}
          hunters={hunters}
          draft={draft}
          setDraft={setDraft}
          onSearch={search}
          onClear={clear}
          count={results.length}
        />
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
                          : new Set(results.map((record) => record.id)),
                      )
                    }
                  />
                </th>
                <th>No.</th>
                {RECORD_COLUMNS.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {results.map((record, index) => (
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
                  <RecordCells record={record} />
                </tr>
              ))}
              {!results.length && (
                <tr>
                  <td colSpan={RECORD_COLUMNS.length + 2} className="empty-table">
                    条件に一致するデータがありません
                  </td>
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
            onClick={async () => {
              if (await onDelete(selectedIds)) setSelectedIds(new Set());
            }}
          >
            選択したデータを削除
          </button>
        </div>
      </section>
    </AuxiliaryPage>
  );
}

function moveItem<T>(items: T[], from: number, to: number) {
  const target = Math.min(items.length - 1, Math.max(0, to));
  if (from === target || Number.isNaN(target)) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}

function MasterEditor({
  draft,
  setDraft,
  plan,
  setPlan,
}: {
  draft: AppSettings;
  setDraft: (value: AppSettings) => void;
  plan: RenamePlan;
  setPlan: (value: RenamePlan) => void;
}) {
  const [kind, setKind] = useState<MasterKind>("survivors");
  const [newItem, setNewItem] = useState("");
  const list = draft[kind];

  const commitList = (next: string[]) => {
    // シーズン名を変えたときは、現在シーズンの指定も追従させる。
    if (kind === "seasons" && !next.includes(draft.currentSeason)) {
      const index = list.indexOf(draft.currentSeason);
      const replacement = index >= 0 ? next[index] : next[0];
      setDraft({ ...draft, seasons: next, currentSeason: replacement ?? "" });
      return;
    }
    setDraft({ ...draft, [kind]: next });
  };

  const addItem = () => {
    const value = newItem.trim();
    if (!value || list.includes(value)) return;
    // シーズンは新しいものほど先頭に置く。
    commitList(kind === "seasons" ? [value, ...list] : [...list, value]);
    setNewItem("");
  };

  const rename = (index: number, value: string) => {
    const current = list[index];
    const next = [...list];
    next[index] = value;
    commitList(next);
    setPlan(planRename(plan, kind, current, value));
  };

  const remove = (index: number) => {
    commitList(list.filter((_, i) => i !== index));
  };

  const duplicates = list.filter(
    (item, index) => item.trim() && list.indexOf(item) !== index,
  );
  const blanks = list.filter((item) => !item.trim()).length;
  const renames = activeRenames(plan, kind);

  return (
    <section className="panel master-editor">
      <div className="tabs">
        {(Object.keys(MASTER_LABELS) as MasterKind[]).map((key) => (
          <button
            key={key}
            className={kind === key ? "active" : ""}
            onClick={() => {
              setKind(key);
              setNewItem("");
            }}
          >
            {MASTER_LABELS[key]}
          </button>
        ))}
      </div>

      <p className="editor-hint">
        名前を書き換えると、登録済みの全データも新しい名称へ置き換わります。
        番号を入力するか矢印を押すと並び順が変わり、すべてのドロップダウンへ反映されます。
        {kind === "seasons" && "シーズンは上にあるものほど新しい扱いになります。"}
      </p>

      <div className="add-master">
        <input
          value={newItem}
          onChange={(event) => setNewItem(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") addItem();
          }}
          placeholder={`${MASTER_LABELS[kind]}名を入力`}
        />
        <button className="secondary-button" onClick={addItem}>追加</button>
      </div>

      {(duplicates.length > 0 || blanks > 0) && (
        <p className="form-error">
          {blanks > 0 && "名称が空の項目があります。"}
          {duplicates.length > 0 && `「${duplicates[0]}」が重複しています。`}
        </p>
      )}

      {renames.length > 0 && (
        <div className="rename-preview">
          <strong>保存時に置き換える名称</strong>
          {renames.map(([from, to]) => (
            <span key={from}>{from} → {to}</span>
          ))}
        </div>
      )}

      <ol className="master-rows">
        {list.map((item, index) => (
          <li key={index}>
            <select
              className="order-input"
              value={index + 1}
              aria-label={`${item || "未入力"}の並び順`}
              onChange={(event) =>
                commitList(moveItem(list, index, Number(event.target.value) - 1))
              }
            >
              {list.map((_, position) => (
                <option key={position} value={position + 1}>
                  {position + 1}
                </option>
              ))}
            </select>
            <input
              className="name-input"
              value={item}
              aria-label={`${MASTER_LABELS[kind]}名`}
              onChange={(event) => rename(index, event.target.value)}
            />
            <button
              className="icon-button"
              aria-label={`${item}を上へ`}
              disabled={index === 0}
              onClick={() => commitList(moveItem(list, index, index - 1))}
            >
              ↑
            </button>
            <button
              className="icon-button"
              aria-label={`${item}を下へ`}
              disabled={index === list.length - 1}
              onClick={() => commitList(moveItem(list, index, index + 1))}
            >
              ↓
            </button>
            <button
              className="icon-button danger"
              aria-label={`${item}を削除`}
              onClick={() => remove(index)}
            >
              ×
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** よくBANするハンターを最大3体まで登録し、検索画面の初期選択にする。 */
function HunterBanDefaults({
  draft,
  setDraft,
}: {
  draft: AppSettings;
  setDraft: (value: AppSettings) => void;
}) {
  const slots = Array.from(
    { length: HUNTER_BAN_SLOTS },
    (_, index) => draft.defaultHunterBans[index] ?? BAN_NONE,
  );
  const duplicate =
    new Set(slots.filter((h) => h !== BAN_NONE)).size !==
    slots.filter((h) => h !== BAN_NONE).length;

  const update = (index: number, value: string) => {
    const next = [...slots];
    next[index] = value;
    setDraft({
      ...draft,
      defaultHunterBans: next.filter((hunter) => hunter !== BAN_NONE),
    });
  };

  return (
    <div className="setting-block">
      <div className="setting-block-head">
        <h3>デフォルトハンターBan設定</h3>
        <p>
          毎回よくBANするハンターを最大{HUNTER_BAN_SLOTS}体まで登録できます。
          検索画面を開いたときに、ここで登録したハンターが最初から選択された状態になります。
          未登録なら何も選択されていない状態で始まります。
        </p>
      </div>
      <div className="ban-row">
        {slots.map((hunter, index) => (
          <label key={index}>
            <small>BAN {index + 1}</small>
            <select
              value={hunter}
              onChange={(event) => update(index, event.target.value)}
            >
              <option>{BAN_NONE}</option>
              {draft.hunters.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {duplicate && (
        <p className="form-error">同じハンターが重複しています</p>
      )}
    </div>
  );
}

/**
 * 希少Ban補正の対象サバイバーと重みを選ぶ。
 * ファクター定義の picks / params をそのまま読むので、
 * 将来ほかの特殊補正を足しても同じ形で並べられる。
 */
function RareBanSettings({
  draft,
  setDraft,
}: {
  draft: AppSettings;
  setDraft: (value: AppSettings) => void;
}) {
  const adjustFactors = PREDICTION_FACTORS.filter(
    (factor) => factor.kind === "adjust" && factor.picks.length > 0,
  );

  const patchFactor = (id: string, patch: Partial<FactorConfig>) => {
    setDraft({
      ...draft,
      prediction: {
        ...draft.prediction,
        factors: {
          ...draft.prediction.factors,
          [id]: { ...draft.prediction.factors[id], ...patch },
        },
      },
    });
  };

  return (
    <>
      {adjustFactors.map((factor) => {
        const config = draft.prediction.factors[factor.id];
        if (!config) return null;
        return (
          <div key={factor.id} className="setting-block">
            <div className="setting-block-head">
              <h3>{factor.label}設定</h3>
              <p>{factor.description}</p>
              <label className="toggle inline-toggle">
                <input
                  type="checkbox"
                  checked={config.enabled}
                  onChange={(event) =>
                    patchFactor(factor.id, { enabled: event.target.checked })
                  }
                />
                <span>{config.enabled ? "ON" : "OFF"}</span>
              </label>
            </div>

            {config.enabled && (
              <>
                {factor.params.map((spec) => (
                  <label key={spec.key} className="param-field">
                    {spec.label}
                    <input
                      type="number"
                      min={spec.min}
                      max={spec.max}
                      step={spec.step}
                      value={config.params[spec.key] ?? 0}
                      onChange={(event) =>
                        patchFactor(factor.id, {
                          params: {
                            ...config.params,
                            [spec.key]: Number(event.target.value) || 0,
                          },
                        })
                      }
                    />
                    {spec.hint && <small>{spec.hint}</small>}
                  </label>
                ))}

                {factor.picks.map((spec) => {
                  const selected = new Set(config.picks[spec.key] ?? []);
                  const options = spec.options(draft);
                  return (
                    <div key={spec.key} className="pick-field">
                      <p className="series-label">
                        {spec.label}
                        <b>{selected.size}人選択中</b>
                        {spec.hint && <small>{spec.hint}</small>}
                      </p>
                      <div className="pick-grid">
                        {options.map((name) => (
                          <label
                            key={name}
                            className={selected.has(name) ? "picked" : ""}
                          >
                            <input
                              type="checkbox"
                              checked={selected.has(name)}
                              onChange={() => {
                                const next = new Set(selected);
                                if (next.has(name)) next.delete(name);
                                else next.add(name);
                                patchFactor(factor.id, {
                                  picks: {
                                    ...config.picks,
                                    // マスターの並び順を保って保存する。
                                    [spec.key]: options.filter((item) =>
                                      next.has(item),
                                    ),
                                  },
                                });
                              }}
                            />
                            {name}
                          </label>
                        ))}
                      </div>
                      {selected.size > 0 && (
                        <button
                          className="secondary-button clear-picks"
                          onClick={() =>
                            patchFactor(factor.id, {
                              picks: { ...config.picks, [spec.key]: [] },
                            })
                          }
                        >
                          選択をすべて解除
                        </button>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        );
      })}
    </>
  );
}

function PredictionEditor({
  draft,
  setDraft,
}: {
  draft: AppSettings;
  setDraft: (value: AppSettings) => void;
}) {
  const config = draft.prediction;

  const patchFactor = (id: string, patch: Partial<FactorConfig>) => {
    setDraft({
      ...draft,
      prediction: {
        ...config,
        factors: {
          ...config.factors,
          [id]: { ...config.factors[id], ...patch },
        },
      },
    });
  };

  return (
    <section className="panel prediction-editor">
      <div className="editor-head">
        <div>
          <h2>予測設定</h2>
          <p>
            順位はまず<code>一致度（マップ＋BANサバイバー）</code>
            で決まります。ハンターごとに最も一致度の高いデータだけを採用し、
            <b>同じ一致度の中でのみ</b>件数と補正（希少Ban・シーズン）が効きます。
            件数の影響には自動で上限が掛かるため、Ban2一致の大量データが
            Ban3一致を追い抜くことはありません。
          </p>
        </div>
        <button
          className="secondary-button"
          onClick={() =>
            setDraft({
              ...draft,
              prediction: defaultPredictionConfig(draft.banSlots),
            })
          }
        >
          デフォルトへ戻す
        </button>
      </div>

      <label className="base-weight">
        基礎スコア
        <input
          type="number"
          min={0}
          max={50}
          step={0.5}
          value={config.baseWeight}
          onChange={(event) =>
            setDraft({
              ...draft,
              prediction: {
                ...config,
                baseWeight: Number(event.target.value) || 0,
              },
            })
          }
        />
        <small>どの条件にも一致しないデータへ与える最低スコアです。</small>
      </label>

      <label className="base-weight">
        件数の影響度
        <input
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={config.countWeight}
          onChange={(event) =>
            setDraft({
              ...draft,
              prediction: {
                ...config,
                countWeight: Number(event.target.value) || 0,
              },
            })
          }
        />
        <small>
          同じ一致度の中で、件数の多さをどれだけ加点するかです（0〜1）。
          一致度が逆転しないよう、実際の適用値には自動で上限が掛かります。
        </small>
      </label>

      {PREDICTION_FACTORS.map((factor) => {
        const factorConfig = config.factors[factor.id];
        if (!factorConfig) return null;
        return (
          <article
            key={factor.id}
            className={`factor-card ${factorConfig.enabled ? "" : "off"}`}
          >
            <header>
              <div>
                <h3>
                  {factor.label}
                  <span className={`kind-tag ${factor.kind}`}>
                    {factor.kind === "match" ? "一致度" : "同一致度内の補正"}
                  </span>
                </h3>
                <p>{factor.description}</p>
                {factor.picks.length > 0 && (
                  <p className="factor-link">
                    対象の選択は「基本設定」タブで行います。
                  </p>
                )}
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={factorConfig.enabled}
                  onChange={(event) =>
                    patchFactor(factor.id, { enabled: event.target.checked })
                  }
                />
                <span>{factorConfig.enabled ? "ON" : "OFF"}</span>
              </label>
            </header>

            {factorConfig.enabled && (
              <div className="factor-body">
                {factor.params.map((spec) => (
                  <label key={spec.key} className="param-field">
                    {spec.label}
                    <input
                      type="number"
                      min={spec.min}
                      max={spec.max}
                      step={spec.step}
                      value={factorConfig.params[spec.key] ?? 0}
                      onChange={(event) =>
                        patchFactor(factor.id, {
                          params: {
                            ...factorConfig.params,
                            [spec.key]: Number(event.target.value) || 0,
                          },
                        })
                      }
                    />
                    {spec.hint && <small>{spec.hint}</small>}
                  </label>
                ))}

                {factor.series.map((spec) => {
                  const labels = spec.labels(draft);
                  const values = factorConfig.series[spec.key] ?? [];
                  return (
                    <div key={spec.key} className="factor-series">
                      <p className="series-label">
                        {spec.label}
                        {spec.hint && <small>{spec.hint}</small>}
                      </p>
                      <div className="series-grid">
                        {labels.map((label, index) => (
                          <label key={label}>
                            {label}
                            <input
                              type="number"
                              min={spec.min}
                              max={spec.max}
                              step={spec.step}
                              value={values[index] ?? 0}
                              onChange={(event) => {
                                const next = labels.map((_, i) => values[i] ?? 0);
                                next[index] = Number(event.target.value) || 0;
                                patchFactor(factor.id, {
                                  series: {
                                    ...factorConfig.series,
                                    [spec.key]: next,
                                  },
                                });
                              }}
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}

function SettingsView({
  settings,
  records,
  busy,
  onSave,
  onBack,
}: {
  settings: AppSettings;
  records: MatchRecord[];
  busy: boolean;
  onSave: (settings: AppSettings, plan: RenamePlan) => Promise<boolean>;
  onBack: () => void;
}) {
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [plan, setPlan] = useState<RenamePlan>(emptyRenamePlan());
  const [section, setSection] = useState<"basic" | "prediction" | "master">(
    "basic",
  );

  const invalid = (Object.keys(MASTER_LABELS) as MasterKind[]).some((kind) => {
    const list = draft[kind];
    return (
      list.some((item) => !item.trim()) ||
      list.some((item, index) => list.indexOf(item) !== index)
    );
  });

  const affected = useMemo(
    () =>
      hasRenames(plan)
        ? records.filter((record) => renameFieldsForRecord(record, plan)).length
        : 0,
    [plan, records],
  );

  return (
    <AuxiliaryPage
      eyebrow="SYSTEM MASTER"
      title="マスターデータ更新"
      description="選択肢・並び順・名称・予測アルゴリズムの重みをまとめて管理します。"
      onBack={onBack}
    >
      <div className="tabs section-tabs">
        <button
          className={section === "basic" ? "active" : ""}
          onClick={() => setSection("basic")}
        >
          基本設定
        </button>
        <button
          className={section === "prediction" ? "active" : ""}
          onClick={() => setSection("prediction")}
        >
          予測設定
        </button>
        <button
          className={section === "master" ? "active" : ""}
          onClick={() => setSection("master")}
        >
          マスターデータ
        </button>
      </div>

      {section === "basic" && (
        <section className="panel settings-summary wide-panel">
          <h2>基本設定</h2>
          <p className="personal-note">
            この画面の設定は<b>あなた専用</b>として保存されます。
            他のユーザーの予測や表示には影響しません。
            サバイバー・ハンター・マップ・シーズンの一覧と試合データは全員で共有です。
          </p>
          <label>
            現在のシーズン
            <select
              value={draft.currentSeason}
              onChange={(event) =>
                setDraft({ ...draft, currentSeason: event.target.value })
              }
            >
              {draft.seasons.map((season) => (
                <option key={season}>{season}</option>
              ))}
            </select>
            <small>シーズンの追加・並び替えは「マスターデータ」タブで行います。</small>
          </label>
          <label>
            BAN人数
            <select
              value={draft.banSlots}
              onChange={(event) =>
                setDraft(resizeBanMatchWeights(draft, Number(event.target.value)))
              }
            >
              {Array.from({ length: MAX_BAN_SLOTS }, (_, i) => i + 1).map(
                (count) => (
                  <option key={count} value={count}>{count}人</option>
                ),
              )}
            </select>
          </label>
          <label>
            BANサバイバーの表示順
            <select
              value={draft.banOrderMode}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  banOrderMode: event.target.value as BanOrderMode,
                })
              }
            >
              {(Object.keys(BAN_ORDER_LABELS) as BanOrderMode[]).map((mode) => (
                <option key={mode} value={mode}>{BAN_ORDER_LABELS[mode]}</option>
              ))}
            </select>
            <small>
              Ban率順にすると、Ban集計のランキングと同じ順序で検索画面へ表示します。
            </small>
          </label>

          <HunterBanDefaults draft={draft} setDraft={setDraft} />
          <RareBanSettings draft={draft} setDraft={setDraft} />

          <div className="master-counts">
            <span><b>{draft.survivors.length}</b>サバイバー</span>
            <span><b>{draft.hunters.length}</b>ハンター</span>
            <span><b>{draft.maps.length}</b>マップ</span>
            <span><b>{draft.seasons.length}</b>シーズン</span>
          </div>
        </section>
      )}

      {section === "prediction" && (
        <PredictionEditor draft={draft} setDraft={setDraft} />
      )}

      {section === "master" && (
        <MasterEditor
          draft={draft}
          setDraft={setDraft}
          plan={plan}
          setPlan={setPlan}
        />
      )}

      <div className="settings-actions">
        {affected > 0 && (
          <span className="rename-count">
            読み込み済み{affected}件のデータを名称変更します
          </span>
        )}
        {invalid && (
          <span className="rename-count error">
            名称の空欄・重複を解消してください
          </span>
        )}
        <button
          className="primary-button"
          disabled={busy || invalid}
          onClick={async () => {
            if (await onSave(draft, plan)) setPlan(emptyRenamePlan());
          }}
        >
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
