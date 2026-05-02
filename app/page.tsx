"use client";
import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { motion, useMotionValue, useTransform, AnimatePresence } from "framer-motion";
import {
  Film, Trophy, ChevronRight, RefreshCw, CheckCircle2, User, Trash2,
  Users, BarChart2, ArrowLeft, Zap, Undo2, AlertTriangle, Info,
  History, ChevronDown, ChevronUp, Search, X, Loader2, WifiOff
} from "lucide-react";
import { supabase } from "@/lib/supabase";

// ═══════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════
type MovieState = "none" | "unseen" | "meh" | "liked" | "favorite";

interface Movie {
  id: number;
  title: string;
  titleFr: string;
  year: number;
  genre: string;
  poster: string;
  posterUrl: string;
}

interface ProfileData {
  alias: string;
  movieStates: Record<number, MovieState>;
  scores: Record<number, number>;
  duelCounts: Record<number, number>;
  duelsResolved: number;
  updatedAt?: number;
}

// ═══════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════
const STORAGE_KEY      = "movieranker_v7";
const STATE_CYCLE      = ["none","unseen","meh","liked","favorite"] as MovieState[];
const MIN_DUEL_ELIGIBLE = 10;
const WU_BATCH         = 6;
const WU_KEEP          = 2;
const DUEL_HISTORY_MAX = 5;
const SYNC_DEBOUNCE_MS = 3000; // délai avant flush Supabase

function computeWarmupRounds(n: number) { return Math.max(8, Math.ceil(n / 12)); }
function dynamicK(n: number) { return Math.round(40 / (1 + n * 0.15)); }
function computeConfidence(duelCounts: Record<number, number>, eligibleCount: number) {
  if (eligibleCount < 2) return 0;
  const ideal    = Math.ceil(Math.log2(eligibleCount)) * eligibleCount;
  const realized = Object.values(duelCounts).reduce((s, v) => s + v, 0);
  return Math.min(100, Math.round((realized / ideal) * 100));
}

const STATE_META = {
  none:     { label: "Non classé",   weight: 1000, color: "#475569", bg: "#1e293b", border: "#334155" },
  unseen:   { label: "Pas vu",       weight: 1000, color: "#64748b", bg: "#151f2e", border: "#1e3a5f" },
  meh:      { label: "Hors course",  weight: 850,  color: "#d97706", bg: "#1c1505", border: "#78350f" },
  liked:    { label: "J'ai aimé",    weight: 1100, color: "#3b82f6", bg: "#0c1929", border: "#1e3a5f" },
  favorite: { label: "Coup de cœur", weight: 1250, color: "#a78bfa", bg: "#130d2a", border: "#4c1d95" },
} as const;

// ═══════════════════════════════════════════════════
// STORAGE LOCAL (cache + profil UUID stable)
// ═══════════════════════════════════════════════════
const store = {
  load: (): Record<string, any> => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch { return {}; }
  },
  save: (d: Record<string, any>) => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(d)); } catch {}
  },
  getProfileId: (): string => {
    const s = store.load();
    if (s.profileId) return s.profileId;
    const id = crypto.randomUUID?.() || Math.random().toString(36).slice(2);
    store.save({ ...s, profileId: id });
    return id;
  },
  getProfile:   (pid: string): ProfileData | null => store.load().profiles?.[pid] || null,
  listProfiles: (): Record<string, ProfileData>   => store.load().profiles || {},
  saveProfile:  (pid: string, data: Partial<ProfileData>) => {
    const s = store.load();
    store.save({
      ...s,
      profiles: {
        ...(s.profiles || {}),
        [pid]: { ...(s.profiles?.[pid] || {}), ...data, updatedAt: Date.now() },
      },
    });
  },
  deleteProfile: (pid: string) => {
    const s = store.load();
    const p = { ...s.profiles };
    delete p[pid];
    store.save({ ...s, profiles: p });
  },
};

// ═══════════════════════════════════════════════════
// SUPABASE — couche de persistance
// ═══════════════════════════════════════════════════

// Assure que le profil existe dans Supabase, crée-le si nécessaire
async function ensureSupabaseProfile(profileId: string, alias: string): Promise<boolean> {
  if (!supabase) return false;
  const { error } = await supabase
    .from("profiles")
    .upsert({ id: profileId, display_name: alias }, { onConflict: "id" });
  return !error;
}

// Charge les états et scores d'un profil depuis Supabase
async function loadFromSupabase(profileId: string, movies: Movie[]): Promise<Partial<ProfileData> | null> {
  if (!supabase) return null;

  const [statesRes, scoresRes] = await Promise.all([
    supabase.from("movie_states").select("movie_id,state").eq("profile_id", profileId),
    supabase.from("movie_scores").select("movie_id,score,duel_count").eq("profile_id", profileId),
  ]);

  if (statesRes.error && scoresRes.error) return null;

  const movieStates: Record<number, MovieState> = Object.fromEntries(movies.map(m => [m.id, "none"]));
  const scores: Record<number, number>          = Object.fromEntries(movies.map(m => [m.id, 1000]));
  const duelCounts: Record<number, number>      = Object.fromEntries(movies.map(m => [m.id, 0]));

  for (const row of statesRes.data || []) {
    movieStates[row.movie_id] = row.state as MovieState;
  }
  for (const row of scoresRes.data || []) {
    scores[row.movie_id]     = row.score;
    duelCounts[row.movie_id] = row.duel_count;
  }

  return { movieStates, scores, duelCounts };
}

// Flush tous les états modifiés vers Supabase (debounced)
async function flushStatesToSupabase(
  profileId: string,
  dirtyStateIds: Set<number>,
  movieStates: Record<number, MovieState>
) {
  if (!supabase || dirtyStateIds.size === 0) return;
  const rows = [...dirtyStateIds].map(id => ({
    profile_id: profileId,
    movie_id:   id,
    state:      movieStates[id] || "none",
    updated_at: new Date().toISOString(),
  }));
  await supabase
    .from("movie_states")
    .upsert(rows, { onConflict: "profile_id,movie_id" });
}

// Upsert immédiat de 2 films après un duel
async function flushDuelScoresToSupabase(
  profileId: string,
  winnerId: number,
  loserId: number,
  scores: Record<number, number>,
  duelCounts: Record<number, number>
) {
  if (!supabase) return;
  const rows = [winnerId, loserId].map(id => ({
    profile_id:  profileId,
    movie_id:    id,
    score:       scores[id] ?? 1000,
    duel_count:  duelCounts[id] ?? 0,
    updated_at:  new Date().toISOString(),
  }));
  await supabase
    .from("movie_scores")
    .upsert(rows, { onConflict: "profile_id,movie_id" });
}

// ═══════════════════════════════════════════════════
// ELO
// ═══════════════════════════════════════════════════
const elo = {
  expected: (a: number, b: number) => 1 / (1 + Math.pow(10, (b - a) / 400)),
  apply: (
    scores: Record<number, number>,
    duelCounts: Record<number, number>,
    wId: number,
    lId: number
  ) => {
    const a = scores[wId] ?? 1000, b = scores[lId] ?? 1000;
    const kW = dynamicK(duelCounts[wId] ?? 0), kL = dynamicK(duelCounts[lId] ?? 0);
    const ea = elo.expected(a, b);
    return {
      scores: {
        ...scores,
        [wId]: Math.round(a + kW * (1 - ea)),
        [lId]: Math.round(b + kL * (0 - elo.expected(b, a))),
      },
      duelCounts: {
        ...duelCounts,
        [wId]: (duelCounts[wId] ?? 0) + 1,
        [lId]: (duelCounts[lId] ?? 0) + 1,
      },
    };
  },
  init: (movies: Movie[], states: Record<number, MovieState>) =>
    Object.fromEntries(
      movies
        .filter(m => (states[m.id] ?? "none") !== "unseen")
        .map(m => [m.id, STATE_META[states[m.id] ?? "none"].weight])
    ),
};

// ═══════════════════════════════════════════════════
// LOGIQUE DUELS
// ═══════════════════════════════════════════════════
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function nextState(cur: MovieState): MovieState {
  return STATE_CYCLE[(STATE_CYCLE.indexOf(cur) + 1) % STATE_CYCLE.length];
}

function choosePair(
  movies: Movie[],
  scores: Record<number, number>,
  states: Record<number, MovieState>,
  recentPairs: string[],
  recentIds: number[]
): [Movie, Movie] | null {
  const pool = shuffle(movies.filter(m => {
    const s = states[m.id] ?? "none";
    return s !== "unseen" && s !== "meh";
  }));
  if (pool.length < 2) return null;
  const PAIR_CD = 20, ID_CD = 8, candidates: { pair: [Movie, Movie]; gap: number; penalty: number }[] = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i], b = pool[j];
      const key = [a.id, b.id].sort((x, y) => x - y).join("-");
      if (recentPairs.slice(-PAIR_CD).includes(key)) continue;
      const aR = recentIds.slice(-ID_CD).includes(a.id);
      const bR = recentIds.slice(-ID_CD).includes(b.id);
      candidates.push({
        pair: [a, b],
        gap: Math.abs((scores[a.id] ?? 1000) - (scores[b.id] ?? 1000)),
        penalty: (aR ? 1 : 0) + (bR ? 1 : 0),
      });
    }
  }
  if (!candidates.length) return pool.length >= 2 ? [pool[0], pool[1]] : null;
  candidates.sort((x, y) => x.penalty !== y.penalty ? x.penalty - y.penalty : x.gap - y.gap);
  const best = candidates[0];
  const tied = candidates.filter(c => c.penalty === best.penalty && Math.abs(c.gap - best.gap) < 50);
  return tied[Math.floor(Math.random() * tied.length)].pair;
}

// ═══════════════════════════════════════════════════
// AGRÉGATION FAMILIALE
// ═══════════════════════════════════════════════════
function computeFamily(profiles: Record<string, ProfileData>, movies: Movie[]) {
  const pList = Object.entries(profiles).filter(([, p]) => p.alias && p.movieStates);
  if (pList.length < 2) return null;
  const result = movies.map(movie => {
    const entries = pList
      .map(([, p]) => ({
        alias: p.alias,
        state: p.movieStates?.[movie.id] ?? "none" as MovieState,
        score: p.scores?.[movie.id] ?? 1000,
      }))
      .filter(e => e.state !== "none" && e.state !== "unseen");
    const avgScore = entries.length ? entries.reduce((s, e) => s + e.score, 0) / entries.length : 0;
    const states = entries.map(e => e.state);
    const convergence = states.length > 0 ? 1 - (new Set(states).size - 1) / 3 : 0;
    return { movie, entries, avgScore, convergence, participantCount: entries.length };
  });
  const completion = pList.map(([, p]) => {
    const triaged = Object.values(p.movieStates || {}).filter(s => s !== "none").length;
    return { alias: p.alias, triaged, total: movies.length, pct: Math.round(triaged / movies.length * 100) };
  });
  return {
    topFilms:   result.filter(r => r.participantCount > 0).sort((a, b) => b.avgScore - a.avgScore).slice(0, 10),
    consensus:  result.filter(r => r.participantCount >= 2 && r.convergence > 0.7).sort((a, b) => b.avgScore - a.avgScore).slice(0, 5),
    polarizing: result.filter(r => r.participantCount >= 2 && r.convergence < 0.35).sort((a, b) => a.convergence - b.convergence).slice(0, 5),
    participantCount: pList.length,
    participants: pList.map(([, p]) => p.alias),
    completion,
  };
}

// ═══════════════════════════════════════════════════
// COMPOSANTS UI
// ═══════════════════════════════════════════════════
function PosterBox({ movie, size = "tile" }: { movie: Movie; size?: "duel" | "tile" | "mini" }) {
  const [err, setErr] = useState(false);
  const s = {
    duel: { borderRadius: 18, fontSize: 56, width: "100%", aspectRatio: "2/3", marginBottom: 12 },
    tile: { borderRadius: 14, fontSize: 32, width: "100%", aspectRatio: "2/3", marginBottom: 10 },
    mini: { borderRadius: 10, fontSize: 18, width: 40, height: 40, flexShrink: 0 },
  }[size];
  return (
    <div style={{ background: "#0d1117", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", ...s }}>
      {movie.posterUrl && !err
        ? <img src={movie.posterUrl} alt={movie.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={() => setErr(true)} />
        : <span style={{ fontSize: (s as any).fontSize, lineHeight: 1 }}>{movie.poster || "🎬"}</span>
      }
    </div>
  );
}

function Badge({ state }: { state: MovieState }) {
  const m = STATE_META[state];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 9px", borderRadius: 999, fontSize: 11, fontWeight: 700, background: m.bg, color: m.color, border: `1px solid ${m.border}` }}>
      {m.label}
    </span>
  );
}

function Btn({ children, primary = true, small = false, disabled = false, onClick, style = {} }: {
  children: React.ReactNode; primary?: boolean; small?: boolean;
  disabled?: boolean; onClick?: () => void; style?: React.CSSProperties;
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      height: small ? 36 : 48, borderRadius: small ? 10 : 16,
      border: primary ? "none" : "1px solid #334155",
      background: disabled ? "#0f172a" : primary ? "#4f46e5" : "#111827",
      color: disabled ? "#334155" : "#f1f5f9",
      fontWeight: 700, fontSize: small ? 12 : 15,
      cursor: disabled ? "not-allowed" : "pointer",
      width: "100%", ...style,
    }}>{children}</button>
  );
}

function ProgressBar({ value, color = "#4f46e5" }: { value: number; color?: string }) {
  return (
    <div style={{ height: 5, borderRadius: 999, background: "#1e293b", overflow: "hidden" }}>
      <motion.div initial={{ width: 0 }} animate={{ width: `${value}%` }} transition={{ duration: 0.5, ease: "easeOut" }}
        style={{ height: "100%", background: color, borderRadius: 999 }} />
    </div>
  );
}

function StickyHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ position: "sticky", top: 0, zIndex: 20, background: "rgba(7,10,20,0.95)", backdropFilter: "blur(14px)", paddingBottom: 12, marginBottom: 16, borderBottom: "1px solid #1e293b" }}>
      {children}
    </div>
  );
}

function Card({ children, style = {} }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ borderRadius: 20, background: "#0f172a", border: "1px solid #1e293b", boxShadow: "0 4px 24px rgba(0,0,0,0.5)", ...style }}>{children}</div>;
}

function MetricTile({ label, value, color = "#f1f5f9" }: { label: string; value: number | string; color?: string }) {
  return (
    <div style={{ background: "#070a14", border: "1px solid #1e293b", borderRadius: 14, padding: "10px 14px" }}>
      <div style={{ fontSize: 11, color: "#475569", marginBottom: 3, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color }}>{value}</div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, fontWeight: 700, color: "#475569", letterSpacing: "0.06em", marginBottom: 10 }}>{children}</div>;
}

function InfoBox({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "10px 14px", borderRadius: 14, background: "#0d1117", border: "1px solid #1e293b", marginBottom: 14 }}>
      <Info size={13} color="#475569" style={{ flexShrink: 0, marginTop: 2 }} />
      <div style={{ fontSize: 11, color: "#475569", lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}

function ChipBar({ options, selected, onSelect, all = "Tous" }: {
  options: string[]; selected: string | null;
  onSelect: (v: string | null) => void; all?: string;
}) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
      <button onClick={() => onSelect(null)} style={{ padding: "5px 12px", borderRadius: 999, fontSize: 11, fontWeight: 700, cursor: "pointer", border: `1px solid ${selected === null ? "#8b5cf6" : "#334155"}`, background: selected === null ? "#4f46e5" : "#0f172a", color: selected === null ? "#fff" : "#64748b" }}>{all}</button>
      {options.map(opt => (
        <button key={opt} onClick={() => onSelect(opt === selected ? null : opt)} style={{ padding: "5px 12px", borderRadius: 999, fontSize: 11, fontWeight: 700, cursor: "pointer", border: `1px solid ${selected === opt ? "#8b5cf6" : "#334155"}`, background: selected === opt ? "#4f46e5" : "#0f172a", color: selected === opt ? "#fff" : "#64748b" }}>{opt}</button>
      ))}
    </div>
  );
}

function ConfidenceBadge({ pct }: { pct: number }) {
  const color = pct >= 70 ? "#10b981" : pct >= 35 ? "#f59e0b" : "#ef4444";
  const label = pct >= 70 ? "Fiable" : pct >= 35 ? "En cours" : "Préliminaire";
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 12px", borderRadius: 999, background: "#0d1117", border: `1px solid ${color}22`, fontSize: 12, fontWeight: 700, color }}>
      <div style={{ width: 7, height: 7, borderRadius: 999, background: color }} />
      {label} · {pct}%
    </div>
  );
}

function SyncIndicator({ syncing, offline }: { syncing: boolean; offline: boolean }) {
  if (!syncing && !offline) return null;
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 999, background: "#0d1117", border: `1px solid ${offline ? "#ef444422" : "#4f46e522"}`, fontSize: 11, fontWeight: 600, color: offline ? "#ef4444" : "#64748b" }}>
      {offline
        ? <><WifiOff size={11} /> Hors-ligne</>
        : <><Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} /> Sync…</>
      }
    </div>
  );
}

function DuelHistoryDrawer({ history, movies }: { history: any[]; movies: Movie[] }) {
  const [open, setOpen] = useState(false);
  if (!history.length) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <button onClick={() => setOpen(o => !o)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "10px 14px", borderRadius: 14, border: "1px solid #1e293b", background: "#0d1117", cursor: "pointer", color: "#64748b" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 700 }}><History size={13} /> Derniers duels ({history.length})</div>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25 }} style={{ overflow: "hidden" }}>
            <div style={{ padding: "10px 0", display: "flex", flexDirection: "column", gap: 8 }}>
              {[...history].reverse().map((d, i) => {
                const winner = movies.find(m => m.id === d.winnerId), loser = movies.find(m => m.id === d.loserId);
                if (!winner || !loser) return null;
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 12, background: "#070a14", border: "1px solid #1e293b" }}>
                    <div style={{ fontSize: 16, lineHeight: 1 }}>{winner.poster || "🎬"}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#f1f5f9" }}>{winner.title}<span style={{ color: "#10b981", marginLeft: 6, fontSize: 10 }}>+{d.gainW}</span></div>
                      <div style={{ fontSize: 11, color: "#475569" }}>vs {loser.title}<span style={{ color: "#ef4444", marginLeft: 6, fontSize: 10 }}>{d.gainL}</span></div>
                    </div>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ═══════════════════════════════════════════════════
// BARRE DE RECHERCHE
// ═══════════════════════════════════════════════════
function SearchPanel({ movies, movieStates, onStateChange, onClose }: {
  movies: Movie[]; movieStates: Record<number, MovieState>;
  onStateChange: (id: number) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const results = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (q.length < 2) return [];
    return movies.filter(m =>
      m.title.toLowerCase().includes(q) ||
      (m.titleFr && m.titleFr.toLowerCase().includes(q))
    ).slice(0, 20);
  }, [movies, query]);

  return (
    <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
      style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(7,10,20,0.97)", overflow: "auto", padding: 16 }}>
      <div style={{ maxWidth: 460, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 16, background: "#0f172a", border: "1px solid #334155" }}>
            <Search size={16} color="#64748b" />
            <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)}
              placeholder="Rechercher un film…"
              style={{ flex: 1, background: "none", border: "none", outline: "none", color: "#f1f5f9", fontSize: 15 }} />
            {query && <button onClick={() => setQuery("")} style={{ background: "none", border: "none", cursor: "pointer", color: "#475569", padding: 0 }}><X size={14} /></button>}
          </div>
          <button onClick={onClose} style={{ height: 44, width: 44, borderRadius: 14, border: "1px solid #334155", background: "#0f172a", cursor: "pointer", color: "#94a3b8", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <X size={16} />
          </button>
        </div>
        {query.length < 2 && (
          <div style={{ padding: "14px 16px", borderRadius: 16, background: "#0f172a", border: "1px solid #1e293b", marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: "#475569", marginBottom: 8, fontWeight: 600 }}>Tapez au moins 2 caractères</div>
            <div style={{ fontSize: 11, color: "#334155", lineHeight: 1.8 }}>
              Tapotez un film pour changer son état : Non classé → Pas vu → Hors course → J'ai aimé → Coup de cœur
            </div>
          </div>
        )}
        {results.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 11, color: "#475569", fontWeight: 700, letterSpacing: "0.05em", marginBottom: 4 }}>
              {results.length} résultat{results.length > 1 ? "s" : ""}
            </div>
            {results.map(movie => {
              const state = movieStates[movie.id] ?? "none";
              const m = STATE_META[state];
              return (
                <motion.button key={movie.id} whileTap={{ scale: 0.98 }}
                  onClick={() => onStateChange(movie.id)}
                  style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 16, border: `1px solid ${m.border}`, background: m.bg, textAlign: "left", cursor: "pointer", width: "100%" }}>
                  <PosterBox movie={movie} size="mini" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#f1f5f9", lineHeight: 1.2, marginBottom: 2 }}>{movie.title}</div>
                    {movie.titleFr && movie.titleFr !== movie.title && (
                      <div style={{ fontSize: 10, color: "#475569", marginBottom: 3 }}>{movie.titleFr}</div>
                    )}
                    <div style={{ fontSize: 11, color: "#64748b" }}>{movie.year}{movie.genre ? ` · ${movie.genre.split(",")[0]}` : ""}</div>
                  </div>
                  <Badge state={state} />
                </motion.button>
              );
            })}
          </div>
        )}
        {query.length >= 2 && results.length === 0 && (
          <div style={{ textAlign: "center", padding: 40, color: "#334155", fontSize: 13 }}>
            Aucun film trouvé pour « {query} »
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════
// DUEL CARD
// ═══════════════════════════════════════════════════
function DuelCard({ movie, onChoose, position }: { movie: Movie; onChoose: () => void; position: "left" | "right" }) {
  const isLeft = position === "left";
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-160, 0, 160], isLeft ? [8, 0, -8] : [-8, 0, 8]);
  const DIR = isLeft ? [-160, -60, 0] : [0, 60, 160];
  const overlayOp = useTransform(x, DIR, [0.7, 0.25, 0]);
  const labelOp   = useTransform(x, DIR, [1, 0.5, 0]);
  const THRESHOLD = 85;
  return (
    <div style={{ height: "100%", borderRadius: 20, overflow: "hidden", border: "1px solid #1e293b", background: "#0d1117", boxShadow: "0 6px 30px rgba(0,0,0,0.5)", position: "relative" }}>
      <motion.div drag="x" dragConstraints={{ left: 0, right: 0 }} dragElastic={0.22}
        style={{ x, rotate, height: "100%", padding: 12, display: "flex", flexDirection: "column", touchAction: "pan-y", cursor: "grab" }}
        whileTap={{ cursor: "grabbing" }}
        onDragEnd={(_, info) => {
          if (isLeft && info.offset.x < -THRESHOLD) { onChoose(); return; }
          if (!isLeft && info.offset.x > THRESHOLD) { onChoose(); return; }
        }}>
        <motion.div style={{ position: "absolute", inset: 0, borderRadius: 20, pointerEvents: "none", background: "rgba(79,70,229,0.3)", opacity: overlayOp }} />
        <motion.div style={{ position: "absolute", top: 12, ...(isLeft ? { left: 12 } : { right: 12 }), padding: "5px 11px", borderRadius: 999, background: "#4f46e5", color: "#fff", fontSize: 10, fontWeight: 800, letterSpacing: "0.06em", pointerEvents: "none", opacity: labelOp, zIndex: 2 }}>CHOISIR</motion.div>
        <PosterBox movie={movie} size="duel" />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#f1f5f9", lineHeight: 1.2, marginBottom: 3 }}>{movie.title}</div>
          {movie.titleFr && movie.titleFr !== movie.title && <div style={{ fontSize: 10, color: "#475569", marginBottom: 4 }}>{movie.titleFr}</div>}
          <div style={{ fontSize: 12, color: "#64748b" }}>{movie.year}{movie.genre ? ` · ${movie.genre.split(",")[0]}` : ""}</div>
        </div>
        <div style={{ marginTop: 8, fontSize: 10, fontWeight: 600, textAlign: "center", color: "#4f46e5", letterSpacing: "0.03em" }}>{isLeft ? "← glisser pour choisir" : "glisser pour choisir →"}</div>
        <button onClick={onChoose} style={{ marginTop: 8, height: 40, width: "100%", borderRadius: 13, border: "none", background: "#4f46e5", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>Je choisis</button>
      </motion.div>
    </div>
  );
}

function MovieTile({ movie, state, onTap }: { movie: Movie; state: MovieState; onTap: () => void }) {
  const m = STATE_META[state];
  return (
    <motion.button whileTap={{ scale: 0.96 }} onClick={onTap} style={{ width: "100%", borderRadius: 18, border: `1px solid ${m.border}`, background: m.bg, padding: 12, textAlign: "left", boxShadow: "0 2px 16px rgba(0,0,0,0.4)", cursor: "pointer" }}>
      <PosterBox movie={movie} size="tile" />
      <div style={{ fontSize: 13, fontWeight: 700, color: "#f1f5f9", lineHeight: 1.25, marginBottom: 2 }}>{movie.title}</div>
      {movie.titleFr && movie.titleFr !== movie.title && <div style={{ fontSize: 10, color: "#475569", marginBottom: 3 }}>{movie.titleFr}</div>}
      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 10 }}>{movie.year}{movie.genre ? ` · ${movie.genre.split(",")[0]}` : ""}</div>
      <Badge state={state} />
    </motion.button>
  );
}

// ═══════════════════════════════════════════════════
// VUE FAMILIALE
// ═══════════════════════════════════════════════════
function FamilyView({ profiles, movies, onBack }: { profiles: Record<string, ProfileData>; movies: Movie[]; onBack: () => void }) {
  const stats = useMemo(() => computeFamily(profiles, movies), [profiles, movies]);
  if (!stats || stats.participantCount < 2) return (
    <div style={{ padding: 24, textAlign: "center" }}>
      <Users size={40} color="#334155" style={{ marginBottom: 12 }} />
      <div style={{ fontSize: 16, fontWeight: 700, color: "#64748b", marginBottom: 8 }}>Vue familiale indisponible</div>
      <div style={{ fontSize: 13, color: "#475569", lineHeight: 1.6, marginBottom: 20 }}>Il faut au moins 2 profils avec des films classés.</div>
      <Btn onClick={onBack} primary={false}>← Retour</Btn>
    </div>
  );
  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 10, color: "#475569", fontWeight: 700, letterSpacing: "0.06em", marginBottom: 4 }}>RÉSULTATS FAMILIAUX</div>
        <div style={{ fontSize: 24, fontWeight: 900, marginBottom: 4 }}>Vue d'ensemble</div>
        <div style={{ fontSize: 13, color: "#64748b" }}>{stats.participants.join(" · ")}</div>
      </div>
      <SectionLabel>📊 AVANCEMENT PAR PARTICIPANT</SectionLabel>
      <Card style={{ marginBottom: 20 }}>
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          {stats.completion.map(c => (
            <div key={c.alias}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 28, height: 28, borderRadius: 9, background: "#0f0a2a", display: "flex", alignItems: "center", justifyContent: "center" }}><User size={13} color="#8b5cf6" /></div>
                  <span style={{ fontSize: 14, fontWeight: 700 }}>{c.alias}</span>
                </div>
                <span style={{ fontSize: 12, fontWeight: 700, color: c.pct >= 75 ? "#10b981" : c.pct >= 40 ? "#f59e0b" : "#ef4444" }}>{c.triaged}/{c.total} ({c.pct}%)</span>
              </div>
              <ProgressBar value={c.pct} color={c.pct >= 75 ? "#10b981" : c.pct >= 40 ? "#f59e0b" : "#ef4444"} />
            </div>
          ))}
          {stats.completion.some(c => c.pct < 50) && <InfoBox>Les résultats comparatifs sont plus fiables quand tous les participants ont classé au moins 50% du catalogue.</InfoBox>}
        </div>
      </Card>
      <SectionLabel>🏆 TOP FAMILIAL (score ELO moyen)</SectionLabel>
      <Card style={{ marginBottom: 20 }}>
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          {stats.topFilms.map((r, i) => (
            <div key={r.movie.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", borderRadius: 14, background: "#070a14" }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: "#1e293b", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 12, flexShrink: 0, color: i === 0 ? "#f59e0b" : i === 1 ? "#94a3b8" : i === 2 ? "#b45309" : "#475569" }}>{i + 1}</div>
              <PosterBox movie={r.movie} size="mini" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#f1f5f9" }}>{r.movie.title}</div>
                <div style={{ fontSize: 11, color: "#475569" }}>{r.movie.year}</div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#a78bfa" }}>{Math.round(r.avgScore)}</div>
                <div style={{ fontSize: 10, color: "#475569" }}>{r.participantCount} avis</div>
              </div>
            </div>
          ))}
        </div>
      </Card>
      {stats.consensus.length > 0 && (<><SectionLabel>✅ CONSENSUS</SectionLabel><Card style={{ marginBottom: 20 }}><div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>{stats.consensus.map(r => (<div key={r.movie.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", borderRadius: 14, background: "#070a14" }}><PosterBox movie={r.movie} size="mini" /><div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 700, color: "#f1f5f9" }}>{r.movie.title}</div><div style={{ fontSize: 11, color: "#475569" }}>{r.entries.map((e: any) => `${e.alias} : ${STATE_META[e.state as MovieState].label}`).join(" · ")}</div></div><div style={{ fontSize: 11, fontWeight: 700, color: "#10b981" }}>{Math.round(r.convergence * 100)}%</div></div>))}</div></Card></>)}
      {stats.polarizing.length > 0 && (<><SectionLabel>⚡ POLARISANT</SectionLabel><Card style={{ marginBottom: 20 }}><div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>{stats.polarizing.map(r => (<div key={r.movie.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", borderRadius: 14, background: "#070a14" }}><PosterBox movie={r.movie} size="mini" /><div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 700, color: "#f1f5f9" }}>{r.movie.title}</div><div style={{ fontSize: 11, color: "#475569" }}>{r.entries.map((e: any) => `${e.alias} : ${STATE_META[e.state as MovieState].label}`).join(" · ")}</div></div><div style={{ fontSize: 11, fontWeight: 700, color: "#f59e0b" }}>divisé</div></div>))}</div></Card></>)}
      <Btn onClick={onBack} primary={false}>← Retour</Btn>
    </div>
  );
}

// ═══════════════════════════════════════════════════
// ÉCRAN DE CHARGEMENT
// ═══════════════════════════════════════════════════
function LoadingScreen({ message }: { message: string }) {
  return (
    <div style={{ minHeight: "100vh", background: "#070a14", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
      <div style={{ width: 54, height: 54, borderRadius: 18, background: "#0f0a2a", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Film size={26} color="#8b5cf6" />
      </div>
      <Loader2 size={28} color="#4f46e5" style={{ animation: "spin 1s linear infinite" }} />
      <div style={{ fontSize: 14, color: "#475569" }}>{message}</div>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════
// COMPOSANT PRINCIPAL
// ═══════════════════════════════════════════════════
export default function MovieRanker() {
  // ── Catalogue (chargé depuis Supabase) ──────────
  const [movies, setMovies]         = useState<Movie[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError]     = useState(false);

  // ── Profil ──────────────────────────────────────
  const [profileId] = useState<string>(() => store.getProfileId());
  const [alias, setAlias]   = useState("");
  const [screen, setScreen] = useState<string>("welcome");
  const [profiles, setProfiles] = useState<Record<string, ProfileData>>(() => store.listProfiles());
  const [showSearch, setShowSearch] = useState(false);

  // ── États films ─────────────────────────────────
  const [movieStates, setMovieStates] = useState<Record<number, MovieState>>({});
  const [scores, setScores]           = useState<Record<number, number>>({});
  const [duelCounts, setDuelCounts]   = useState<Record<number, number>>({});

  // ── Sync Supabase ────────────────────────────────
  const [syncing, setSyncing]   = useState(false);
  const [offline, setOffline]   = useState(false);
  const dirtyStateIds           = useRef<Set<number>>(new Set()); // ids à flusher
  const syncTimerRef            = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Triage ───────────────────────────────────────
  const [triageOrder, setTriageOrder] = useState<number[]>([]);
  const [triagePage, setTriagePage]   = useState(0);
  const [triageGenre, setTriageGenre] = useState<string | null>(null);

  // ── Warmup ───────────────────────────────────────
  const [warmupOrder, setWarmupOrder]       = useState<number[]>([]);
  const [warmupRound, setWarmupRound]       = useState(0);
  const [warmupSelected, setWarmupSelected] = useState<number[]>([]);
  const [warmupShown, setWarmupShown]       = useState<number[]>([]);
  const [warmupTotal, setWarmupTotal]       = useState(8);

  // ── Duels ────────────────────────────────────────
  const [currentPair, setCurrentPair]   = useState<[Movie, Movie] | null>(null);
  const [recentPairs, setRecentPairs]   = useState<string[]>([]);
  const [recentIds, setRecentIds]       = useState<number[]>([]);
  const [duelsResolved, setDuelsResolved] = useState(0);
  const [duelsSkipped, setDuelsSkipped]   = useState(0);
  const [lastDuel, setLastDuel]           = useState<any>(null);
  const [duelHistory, setDuelHistory]     = useState<any[]>([]);

  // ── Classement ───────────────────────────────────
  const [rankFilter, setRankFilter] = useState<MovieState | null>(null);
  const [rankSort, setRankSort]     = useState<"elo" | "state">("elo");

  // ════════════════════════════════════════════════
  // CHARGEMENT DU CATALOGUE DEPUIS SUPABASE
  // ════════════════════════════════════════════════
  useEffect(() => {
    async function fetchCatalog() {
      if (!supabase) {
        setCatalogError(true);
        setCatalogLoading(false);
        return;
      }
      // Supabase limite à 1000 lignes par défaut — on pagine par 500
      let all: any[] = [];
      let from = 0;
      const PAGE = 500;
      while (true) {
        const { data, error } = await supabase
          .from("movies_catalog")
          .select("id,title,title_fr,year,genre,poster_emoji,poster_url")
          .eq("is_active", true)
          .order("id")
          .range(from, from + PAGE - 1);
        if (error || !data) { setCatalogError(true); break; }
        all = all.concat(data);
        if (data.length < PAGE) break;
        from += PAGE;
      }
      const mapped: Movie[] = all.map(r => ({
        id:        r.id,
        title:     r.title,
        titleFr:   r.title_fr || r.title,
        year:      r.year || 0,
        genre:     r.genre || "",
        poster:    r.poster_emoji || "🎬",
        posterUrl: r.poster_url || "",
      }));
      setMovies(mapped);
      setTriageOrder(shuffle(mapped.map(m => m.id)));
      // États vides par défaut
      setMovieStates(Object.fromEntries(mapped.map(m => [m.id, "none"])));
      setScores(Object.fromEntries(mapped.map(m => [m.id, 1000])));
      setDuelCounts(Object.fromEntries(mapped.map(m => [m.id, 0])));
      setCatalogLoading(false);
    }
    fetchCatalog();
  }, []);

  // ════════════════════════════════════════════════
  // HELPERS (dépendent de movies)
  // ════════════════════════════════════════════════
  const emptyStates  = useCallback(() => Object.fromEntries(movies.map(m => [m.id, "none" as MovieState])), [movies]);
  const emptyScores  = useCallback(() => Object.fromEntries(movies.map(m => [m.id, 1000])), [movies]);
  const emptyCounts  = useCallback(() => Object.fromEntries(movies.map(m => [m.id, 0])), [movies]);

  // ════════════════════════════════════════════════
  // SYNC SUPABASE — debounce états
  // ════════════════════════════════════════════════
  const scheduleSyncStates = useCallback((statesSnapshot: Record<number, MovieState>) => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(async () => {
      if (dirtyStateIds.current.size === 0) return;
      setSyncing(true);
      const dirty = new Set(dirtyStateIds.current);
      dirtyStateIds.current.clear();
      try {
        await flushStatesToSupabase(profileId, dirty, statesSnapshot);
        setOffline(false);
      } catch {
        setOffline(true);
        dirty.forEach(id => dirtyStateIds.current.add(id)); // remettre en file
      } finally {
        setSyncing(false);
      }
    }, SYNC_DEBOUNCE_MS);
  }, [profileId]);

  // ════════════════════════════════════════════════
  // SAUVEGARDE LOCALE (à chaque changement d'état)
  // ════════════════════════════════════════════════
  useEffect(() => {
    if (!alias || movies.length === 0) return;
    store.saveProfile(profileId, { alias, movieStates, scores, duelCounts, duelsResolved });
    setProfiles(store.listProfiles());
  }, [alias, movieStates, scores, duelCounts, duelsResolved, profileId, movies.length]);

  // ════════════════════════════════════════════════
  // STATS ET DÉRIVÉS
  // ════════════════════════════════════════════════
  const genres = useMemo(() =>
    [...new Set(movies.flatMap(m => m.genre ? m.genre.split(",").map(g => g.trim()).filter(Boolean) : []))].sort(),
    [movies]);

  const stats = useMemo(() => {
    const v = Object.values(movieStates);
    return {
      unseen: v.filter(s => s === "unseen").length,
      meh: v.filter(s => s === "meh").length,
      liked: v.filter(s => s === "liked").length,
      favorite: v.filter(s => s === "favorite").length,
      triaged: v.filter(s => s !== "none").length,
    };
  }, [movieStates]);

  const progress      = movies.length ? Math.round(stats.triaged / movies.length * 100) : 0;
  const duelEligible  = useMemo(() => movies.filter(m => { const s = movieStates[m.id] ?? "none"; return s !== "unseen" && s !== "meh"; }), [movies, movieStates]);
  const warmupEligible = useMemo(() => duelEligible.map(m => m.id), [duelEligible]);
  const confidence     = useMemo(() => computeConfidence(duelCounts, duelEligible.length), [duelCounts, duelEligible]);

  const ranking = useMemo(() => {
    let list = [...movies].filter(m => (movieStates[m.id] ?? "none") !== "unseen");
    if (rankFilter) list = list.filter(m => movieStates[m.id] === rankFilter);
    if (rankSort === "elo") list.sort((a, b) => (scores[b.id] ?? 1000) - (scores[a.id] ?? 1000));
    else list.sort((a, b) =>
      ["favorite", "liked", "none", "meh"].indexOf(movieStates[a.id] ?? "none") -
      ["favorite", "liked", "none", "meh"].indexOf(movieStates[b.id] ?? "none")
    );
    return list.slice(0, 20);
  }, [movies, scores, movieStates, rankFilter, rankSort]);

  const triageBatch = useMemo(() => {
    if (triageGenre) {
      const gMovies = movies.filter(m => m.genre && m.genre.split(",").map(g => g.trim()).includes(triageGenre));
      return gMovies.slice(triagePage * 10, triagePage * 10 + 10);
    }
    return triageOrder.slice(triagePage * 10, triagePage * 10 + 10).map(id => movies.find(m => m.id === id)).filter(Boolean) as Movie[];
  }, [movies, triageOrder, triagePage, triageGenre]);

  const warmupBatch = useMemo(() =>
    warmupOrder.slice(0, WU_BATCH).map(id => movies.find(m => m.id === id)).filter(Boolean) as Movie[],
    [movies, warmupOrder]);

  useEffect(() => {
    if (screen !== "duels" || currentPair) return;
    setCurrentPair(choosePair(movies, scores, movieStates, recentPairs, recentIds));
  }, [screen, currentPair, movies, scores, movieStates, recentPairs, recentIds]);

  // ════════════════════════════════════════════════
  // ACTIONS
  // ════════════════════════════════════════════════

  const start = async () => {
    if (!alias.trim() || movies.length === 0) return;

    // 1. Créer/mettre à jour le profil dans Supabase
    await ensureSupabaseProfile(profileId, alias);

    // 2. Charger les données depuis Supabase en priorité
    setSyncing(true);
    const remote = await loadFromSupabase(profileId, movies);
    setSyncing(false);

    if (remote) {
      setMovieStates(remote.movieStates!);
      setScores(remote.scores!);
      setDuelCounts(remote.duelCounts!);
      // Mettre à jour aussi le cache local
      store.saveProfile(profileId, { alias, ...remote, duelsResolved: store.getProfile(profileId)?.duelsResolved || 0 });
    } else {
      // Fallback sur le cache local
      const saved = store.getProfile(profileId);
      if (saved?.movieStates) {
        setMovieStates(saved.movieStates);
        setScores(saved.scores || elo.init(movies, saved.movieStates));
        setDuelCounts(saved.duelCounts || emptyCounts());
        setDuelsResolved(saved.duelsResolved || 0);
      }
      setOffline(true);
    }
    setScreen("triage");
  };

  const loadProfile = async (pid: string) => {
    const saved = store.getProfile(pid);
    if (!saved) return;
    setAlias(saved.alias || "");

    setSyncing(true);
    const remote = await loadFromSupabase(pid, movies);
    setSyncing(false);

    if (remote) {
      setMovieStates(remote.movieStates!);
      setScores(remote.scores!);
      setDuelCounts(remote.duelCounts!);
      setDuelsResolved(saved.duelsResolved || 0);
    } else {
      setMovieStates(saved.movieStates || emptyStates());
      setScores(saved.scores || emptyScores());
      setDuelCounts(saved.duelCounts || emptyCounts());
      setDuelsResolved(saved.duelsResolved || 0);
      setOffline(true);
    }
    setScreen("triage");
  };

  const removeProfile = (pid: string, e: React.MouseEvent) => {
    e.stopPropagation();
    store.deleteProfile(pid);
    setProfiles(store.listProfiles());
  };

  const chooseState = (movieId: number) => {
    const next = nextState(movieStates[movieId] ?? "none");
    const updated = { ...movieStates, [movieId]: next };
    setMovieStates(updated);
    setScores(elo.init(movies, updated));
    // Marquer comme dirty pour sync Supabase
    dirtyStateIds.current.add(movieId);
    scheduleSyncStates(updated);
  };

  const nextTriageBatch = () => {
    if (triageGenre) {
      const gMovies = movies.filter(m => m.genre && m.genre.split(",").map(g => g.trim()).includes(triageGenre));
      const total = Math.ceil(gMovies.length / 10);
      setTriagePage(p => (p + 1) < total ? p + 1 : 0);
      return;
    }
    const total = Math.ceil(triageOrder.length / 10);
    if (triagePage + 1 < total) setTriagePage(p => p + 1);
    else { setTriageOrder(shuffle(movies.map(m => m.id))); setTriagePage(0); }
  };

  const openWarmup = () => {
    const s0 = elo.init(movies, movieStates);
    setScores(s0);
    const rounds = computeWarmupRounds(warmupEligible.length);
    setWarmupTotal(rounds);
    const pool = warmupEligible.length >= WU_BATCH
      ? shuffle(warmupEligible)
      : shuffle(movies.filter(m => (movieStates[m.id] ?? "none") !== "unseen").map(m => m.id));
    setWarmupOrder(pool);
    setWarmupRound(0); setWarmupSelected([]); setWarmupShown([]);
    setScreen("warmup");
  };

  const toggleWarmup = (id: number) =>
    setWarmupSelected(cur =>
      cur.includes(id) ? cur.filter(x => x !== id) : cur.length >= WU_KEEP ? cur : [...cur, id]
    );

  const openDuels = (nextScores?: Record<number, number>) => {
    const s = nextScores || scores;
    const eligible = movies.filter(m => { const st = movieStates[m.id] ?? "none"; return st !== "unseen" && st !== "meh"; });
    if (eligible.length < MIN_DUEL_ELIGIBLE) { setScores(s); setScreen("duel_warning"); return; }
    setScores(s); setRecentPairs([]); setRecentIds([]); setLastDuel(null); setDuelHistory([]);
    setCurrentPair(choosePair(movies, s, movieStates, [], []));
    setScreen("duels");
  };

  const validateWarmup = () => {
    if (warmupSelected.length !== WU_KEEP) return;
    const batch = warmupBatch.map(m => m.id), sel = new Set(warmupSelected), ns = { ...scores };
    for (const id of batch) {
      if ((movieStates[id] ?? "none") === "unseen") continue;
      ns[id] = (ns[id] ?? 1000) + (sel.has(id) ? 25 : -8);
    }
    const nextShown = [...warmupShown.slice(-24), ...batch];
    setScores(ns); setWarmupShown(nextShown); setWarmupSelected([]);
    if (warmupRound + 1 >= warmupTotal) { openDuels(ns); return; }
    setWarmupRound(r => r + 1);
    const fresh = warmupEligible.filter(id => !batch.includes(id) && !nextShown.includes(id));
    const pool = fresh.length >= WU_BATCH ? fresh : warmupEligible.filter(id => !batch.includes(id));
    setWarmupOrder(shuffle(pool).slice(0, WU_BATCH));
  };

  const resolveDuel = (winnerId?: number) => {
    if (!currentPair) return;
    const [L, R] = currentPair, key = [L.id, R.id].sort((a, b) => a - b).join("-");
    const nRP = [...recentPairs, key], nRI = [...recentIds, L.id, R.id];
    let ns = scores, nc = duelCounts;
    if (winnerId) {
      const loserId = winnerId === L.id ? R.id : L.id;
      const sB = { w: scores[winnerId] ?? 1000, l: scores[loserId] ?? 1000 };
      setLastDuel({ pair: currentPair, scoresBefore: scores, duelCountsBefore: duelCounts, recentPairsBefore: recentPairs, recentIdsBefore: recentIds });
      const result = elo.apply(scores, duelCounts, winnerId, loserId);
      ns = result.scores; nc = result.duelCounts;
      const gainW = ns[winnerId] - sB.w, gainL = ns[loserId] - sB.l;
      setDuelHistory(h => [...h.slice(-(DUEL_HISTORY_MAX - 1)), { winnerId, loserId, gainW: `+${gainW}`, gainL }]);
      setScores(ns); setDuelCounts(nc); setDuelsResolved(n => n + 1);
      // Upsert immédiat des 2 films dans Supabase
      flushDuelScoresToSupabase(profileId, winnerId, loserId, ns, nc).catch(() => setOffline(true));
    } else {
      setLastDuel(null); setDuelsSkipped(n => n + 1);
    }
    setRecentPairs(nRP); setRecentIds(nRI);
    setCurrentPair(choosePair(movies, ns, movieStates, nRP, nRI));
  };

  const undoLastDuel = () => {
    if (!lastDuel) return;
    setScores(lastDuel.scoresBefore); setDuelCounts(lastDuel.duelCountsBefore);
    setCurrentPair(lastDuel.pair); setRecentPairs(lastDuel.recentPairsBefore); setRecentIds(lastDuel.recentIdsBefore);
    setDuelsResolved(n => Math.max(0, n - 1)); setDuelHistory(h => h.slice(0, -1)); setLastDuel(null);
  };

  const resetSession = async () => {
    const e = emptyStates();
    store.saveProfile(profileId, { alias, movieStates: e, scores: emptyScores(), duelCounts: emptyCounts(), duelsResolved: 0 });
    setMovieStates(e); setScores(emptyScores()); setDuelCounts(emptyCounts());
    setDuelsResolved(0); setDuelsSkipped(0); setCurrentPair(null); setRecentPairs([]); setRecentIds([]);
    setLastDuel(null); setDuelHistory([]); setTriageOrder(shuffle(movies.map(m => m.id))); setTriagePage(0);
    // Effacer aussi dans Supabase
    if (supabase) {
      await supabase.from("movie_states").delete().eq("profile_id", profileId);
      await supabase.from("movie_scores").delete().eq("profile_id", profileId);
    }
    setScreen("triage");
  };

  // ════════════════════════════════════════════════
  // STYLES DE BASE
  // ════════════════════════════════════════════════
  const ROOT: React.CSSProperties = { minHeight: "100vh", background: "#070a14", color: "#f1f5f9", fontFamily: "'DM Sans',system-ui,sans-serif", padding: 16 };
  const WRAP: React.CSSProperties = { maxWidth: 460, margin: "0 auto", paddingBottom: 80 };
  const G2: React.CSSProperties   = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 };

  // ════════════════════════════════════════════════
  // ÉCRANS
  // ════════════════════════════════════════════════

  // Chargement catalogue
  if (catalogLoading) return <LoadingScreen message="Chargement du catalogue…" />;
  if (catalogError) return (
    <div style={{ ...ROOT, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ textAlign: "center" }}>
        <WifiOff size={40} color="#ef4444" style={{ marginBottom: 12 }} />
        <div style={{ fontSize: 16, fontWeight: 700, color: "#ef4444" }}>Impossible de charger le catalogue</div>
        <div style={{ fontSize: 13, color: "#475569", marginTop: 8 }}>Vérifiez votre connexion et rechargez la page.</div>
      </div>
    </div>
  );

  // ── Accueil ─────────────────────────────────────
  if (screen === "welcome") {
    const existing = Object.entries(profiles).filter(([, v]) => v.alias);
    return (
      <div style={ROOT}>
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        <div style={{ ...WRAP, minHeight: "100vh", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <div style={{ paddingTop: 28 }}>
            <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45 }}>
              <div style={{ width: 54, height: 54, borderRadius: 18, background: "#0f0a2a", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 22 }}><Film size={26} color="#8b5cf6" /></div>
              <div style={{ fontSize: 38, fontWeight: 900, lineHeight: 1.05, letterSpacing: "-0.03em", marginBottom: 10 }}>Classement<br />familial de films</div>
              <div style={{ fontSize: 14, color: "#475569", lineHeight: 1.65 }}>{movies.length} films · Tri · Ronde préliminaire · Duels ELO</div>
            </motion.div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, paddingBottom: 8 }}>
            {existing.length > 0 && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.15 }}>
                <Card>
                  <div style={{ padding: 16 }}>
                    <SectionLabel>REPRENDRE UNE SESSION</SectionLabel>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {existing.map(([pid, data]) => {
                        const triaged = Object.values(data.movieStates || {}).filter(s => s !== "none").length;
                        const pct = Math.round(triaged / movies.length * 100);
                        const conf = computeConfidence(data.duelCounts || {}, movies.filter(m => { const s = data.movieStates?.[m.id] ?? "none"; return s !== "unseen" && s !== "meh"; }).length);
                        return (
                          <motion.button key={pid} whileTap={{ scale: 0.98 }} onClick={() => loadProfile(pid)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderRadius: 14, background: "#0d1117", border: "1px solid #1e293b", cursor: "pointer", color: "#f1f5f9" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              <div style={{ width: 34, height: 34, borderRadius: 11, background: "#0f0a2a", display: "flex", alignItems: "center", justifyContent: "center" }}><User size={15} color="#8b5cf6" /></div>
                              <div style={{ textAlign: "left" }}>
                                <div style={{ fontSize: 14, fontWeight: 700 }}>{data.alias}</div>
                                <div style={{ fontSize: 11, color: "#475569" }}>{triaged} films ({pct}%) · {data.duelsResolved || 0} duels · confiance {conf}%</div>
                              </div>
                            </div>
                            <button onClick={e => removeProfile(pid, e)} style={{ background: "none", border: "none", cursor: "pointer", color: "#334155", padding: 6 }}><Trash2 size={14} /></button>
                          </motion.button>
                        );
                      })}
                    </div>
                    {existing.length >= 2 && (
                      <button onClick={() => setScreen("family")} style={{ marginTop: 12, width: "100%", height: 40, borderRadius: 12, border: "1px solid #1e3a5f", background: "#070a14", color: "#3b82f6", fontWeight: 700, fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                        <BarChart2 size={14} /> Vue familiale ({existing.length} profils)
                      </button>
                    )}
                  </div>
                </Card>
              </motion.div>
            )}
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.25 }}>
              <Card>
                <div style={{ padding: 16 }}>
                  <SectionLabel>NOUVELLE SESSION</SectionLabel>
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#64748b", marginBottom: 8 }}>Nom ou pseudo</div>
                    <input value={alias} onChange={e => setAlias(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && alias.trim() && start()}
                      placeholder="Ex. Nico, Conjointe, Frère 1"
                      style={{ width: "100%", height: 46, borderRadius: 14, border: "1px solid #334155", padding: "0 14px", fontSize: 16, background: "#0d1117", color: "#f1f5f9", outline: "none", boxSizing: "border-box" }} />
                  </div>
                  <Btn onClick={start} disabled={!alias.trim()}>
                    Commencer <ChevronRight size={15} style={{ display: "inline", verticalAlign: "middle" }} />
                  </Btn>
                </div>
              </Card>
            </motion.div>
          </div>
        </div>
      </div>
    );
  }

  if (screen === "family") return (
    <div style={ROOT}><div style={WRAP}>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <FamilyView profiles={profiles} movies={movies} onBack={() => setScreen("welcome")} />
    </div></div>
  );

  // ── Triage ──────────────────────────────────────
  if (screen === "triage") return (
    <div style={ROOT}>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <AnimatePresence>
        {showSearch && (
          <SearchPanel movies={movies} movieStates={movieStates} onStateChange={id => chooseState(id)} onClose={() => setShowSearch(false)} />
        )}
      </AnimatePresence>
      <div style={WRAP}>
        <StickyHeader>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 10, color: "#475569", fontWeight: 700, letterSpacing: "0.06em" }}>PHASE 1 · TRI</div>
              <div style={{ fontSize: 17, fontWeight: 800 }}>{alias}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <SyncIndicator syncing={syncing} offline={offline} />
              <button onClick={() => setShowSearch(true)} style={{ width: 38, height: 38, borderRadius: 12, border: "1px solid #334155", background: "#0f172a", cursor: "pointer", color: "#94a3b8", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Search size={15} />
              </button>
              <span style={{ padding: "5px 12px", borderRadius: 999, background: "#0f172a", border: "1px solid #334155", fontSize: 12, fontWeight: 700, color: "#94a3b8" }}>{stats.triaged} / {movies.length}</span>
            </div>
          </div>
          <ProgressBar value={progress} />
          <div style={{ marginTop: 7, fontSize: 11, color: "#334155", marginBottom: 10 }}>
            {triageGenre ? `Genre : ${triageGenre}` : `Groupe ${triagePage + 1}`} · Tapotez pour changer l'état
          </div>
          <ChipBar options={genres} selected={triageGenre} onSelect={g => { setTriageGenre(g); setTriagePage(0); }} all="Tous les genres" />
        </StickyHeader>
        <div style={{ ...G2, marginBottom: 12 }}>
          {triageBatch.map(movie => <MovieTile key={movie.id} movie={movie} state={movieStates[movie.id] ?? "none"} onTap={() => chooseState(movie.id)} />)}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
          <Btn primary={false} onClick={nextTriageBatch}>Prochain groupe</Btn>
          <Btn primary onClick={openWarmup}>Ronde préliminaire →</Btn>
        </div>
        <div style={G2}>
          {([["Coups de cœur", stats.favorite, "#a78bfa"], ["J'ai aimé", stats.liked, "#3b82f6"], ["Hors course", stats.meh, "#d97706"], ["Pas vus", stats.unseen, "#64748b"]] as const).map(([l, v, c]) =>
            <MetricTile key={l} label={l} value={v} color={c} />
          )}
        </div>
      </div>
    </div>
  );

  // ── Ronde préliminaire ──────────────────────────
  if (screen === "warmup") return (
    <div style={ROOT}><div style={WRAP}>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <StickyHeader>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <div>
            <div style={{ fontSize: 10, color: "#475569", fontWeight: 700, letterSpacing: "0.06em" }}>RONDE PRÉLIMINAIRE</div>
            <div style={{ fontSize: 17, fontWeight: 800 }}>{alias}</div>
          </div>
          <span style={{ padding: "5px 12px", borderRadius: 999, background: "#0f172a", border: "1px solid #334155", fontSize: 12, fontWeight: 700, color: "#94a3b8" }}>{warmupRound + 1} / {warmupTotal}</span>
        </div>
        <ProgressBar value={Math.round((warmupRound / warmupTotal) * 100)} color="#8b5cf6" />
        <div style={{ marginTop: 7, fontSize: 11, color: "#334155" }}>
          Gardez {WU_KEEP} meilleurs · {warmupSelected.length}/{WU_KEEP} sélectionnés
          {warmupTotal > 8 && <span style={{ marginLeft: 8 }}>· {warmupTotal} manches ({warmupEligible.length} films)</span>}
        </div>
      </StickyHeader>
      <div style={{ ...G2, marginBottom: 12 }}>
        {warmupBatch.map(movie => {
          const sel = warmupSelected.includes(movie.id);
          return (
            <motion.button key={movie.id} whileTap={{ scale: 0.97 }} onClick={() => toggleWarmup(movie.id)}
              style={{ width: "100%", borderRadius: 18, padding: 12, textAlign: "left", cursor: "pointer", border: `${sel ? 2 : 1}px solid ${sel ? "#8b5cf6" : "#1e293b"}`, background: sel ? "#130d2a" : "#0d1117", boxShadow: sel ? "0 0 0 3px rgba(139,92,246,0.2)" : "none" }}>
              <PosterBox movie={movie} size="tile" />
              <div style={{ fontSize: 13, fontWeight: 700, color: "#f1f5f9", lineHeight: 1.25, marginBottom: 2 }}>{movie.title}</div>
              {movie.titleFr && movie.titleFr !== movie.title && <div style={{ fontSize: 10, color: "#475569", marginBottom: 3 }}>{movie.titleFr}</div>}
              <div style={{ fontSize: 11, color: "#64748b", marginBottom: 10 }}>{movie.year}{movie.genre ? ` · ${movie.genre.split(",")[0]}` : ""}</div>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 999, fontSize: 11, fontWeight: 700, background: sel ? "#4f46e5" : "#1e293b", color: sel ? "#fff" : "#64748b", border: sel ? "none" : "1px solid #334155" }}>{sel ? "✓ Sélectionné" : "Choisir"}</span>
            </motion.button>
          );
        })}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Btn onClick={validateWarmup} disabled={warmupSelected.length !== WU_KEEP}>
          {warmupRound + 1 < warmupTotal ? `Valider mes ${WU_KEEP} choix` : "Terminer et passer aux duels"}
        </Btn>
        <Btn primary={false} onClick={() => openDuels(scores)}>Passer directement aux duels</Btn>
      </div>
    </div></div>
  );

  // ── Avertissement duels ─────────────────────────
  if (screen === "duel_warning") return (
    <div style={ROOT}><div style={WRAP}><div style={{ paddingTop: 20 }}>
      <Card style={{ padding: 22, textAlign: "center" }}>
        <AlertTriangle size={42} color="#f59e0b" style={{ marginBottom: 12 }} />
        <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 8 }}>Pas assez de films classés</div>
        <div style={{ fontSize: 13, color: "#64748b", lineHeight: 1.7, marginBottom: 6 }}>
          Vous avez <strong style={{ color: "#f1f5f9" }}>{duelEligible.length} film{duelEligible.length > 1 ? "s" : ""}</strong> éligibles. Il en faut au moins <strong style={{ color: "#f1f5f9" }}>{MIN_DUEL_ELIGIBLE}</strong>.
        </div>
        <div style={{ fontSize: 12, color: "#475569", marginBottom: 20, lineHeight: 1.6 }}>Retournez au tri et classez davantage de films comme « J'ai aimé » ou « Coup de cœur ».</div>
        <Btn onClick={() => setScreen("triage")}>← Retour au tri</Btn>
      </Card>
    </div></div></div>
  );

  // ── Duels ───────────────────────────────────────
  if (screen === "duels") {
    const finished = !currentPair;
    return (
      <div style={ROOT}><div style={WRAP}>
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        <StickyHeader>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 10, color: "#475569", fontWeight: 700, letterSpacing: "0.06em" }}>PHASE 2 · DUELS ELO</div>
              <div style={{ fontSize: 17, fontWeight: 800 }}>{alias}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <SyncIndicator syncing={syncing} offline={offline} />
              {lastDuel && (
                <button onClick={undoLastDuel} style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 12, border: "1px solid #334155", background: "#0f172a", color: "#94a3b8", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                  <Undo2 size={13} /> Annuler
                </button>
              )}
              <span style={{ padding: "5px 12px", borderRadius: 999, background: "#0f172a", border: "1px solid #334155", fontSize: 12, fontWeight: 700, color: "#94a3b8" }}>
                <Zap size={11} style={{ display: "inline", verticalAlign: "middle", marginRight: 4 }} />{duelsResolved}
              </span>
            </div>
          </div>
          <div style={G2}><MetricTile label="Coups de cœur" value={stats.favorite} color="#a78bfa" /><MetricTile label="J'ai aimé" value={stats.liked} color="#3b82f6" /></div>
          <div style={{ marginTop: 10 }}><ConfidenceBadge pct={confidence} /></div>
        </StickyHeader>
        <AnimatePresence mode="wait">
          {finished ? (
            <motion.div key="done" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
              <Card style={{ padding: 24, textAlign: "center" }}>
                <CheckCircle2 size={46} color="#10b981" style={{ marginBottom: 12 }} />
                <div style={{ fontSize: 19, fontWeight: 800, marginBottom: 8 }}>Duels épuisés</div>
                <div style={{ fontSize: 13, color: "#64748b", lineHeight: 1.65, marginBottom: 8 }}>Vous avez traversé tous les duels utiles.</div>
                <div style={{ marginBottom: 20 }}><ConfidenceBadge pct={confidence} /></div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <Btn onClick={() => setScreen("ranking")}>Voir mon classement</Btn>
                  <Btn primary={false} onClick={() => openDuels(scores)}>Relancer des duels</Btn>
                </div>
              </Card>
            </motion.div>
          ) : (
            <motion.div key={(currentPair?.[0]?.id || "") + (currentPair?.[1]?.id || "")} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "stretch", marginBottom: 12 }}>
                <DuelCard movie={currentPair![0]} position="left" onChoose={() => resolveDuel(currentPair![0].id)} />
                <DuelCard movie={currentPair![1]} position="right" onChoose={() => resolveDuel(currentPair![1].id)} />
              </div>
              <Btn primary={false} onClick={() => resolveDuel()}>Passer ce duel</Btn>
            </motion.div>
          )}
        </AnimatePresence>
        <DuelHistoryDrawer history={duelHistory} movies={movies} />
        <button onClick={() => setScreen("ranking")} style={{ marginTop: 10, width: "100%", height: 44, borderRadius: 14, border: "none", background: "transparent", color: "#334155", fontWeight: 600, fontSize: 14, cursor: "pointer" }}>
          Voir mon classement →
        </button>
      </div></div>
    );
  }

  // ── Classement ──────────────────────────────────
  if (screen === "ranking") return (
    <div style={ROOT}><div style={WRAP}>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 10, color: "#475569", fontWeight: 700, letterSpacing: "0.06em", marginBottom: 6 }}>RÉSULTATS PERSONNELS</div>
          <div style={{ fontSize: 22, fontWeight: 900 }}>Top de {alias}</div>
        </div>
        <div style={{ width: 50, height: 50, borderRadius: 17, background: "#160e00", display: "flex", alignItems: "center", justifyContent: "center" }}><Trophy size={24} color="#f59e0b" /></div>
      </div>
      <div style={{ marginBottom: 14 }}><ConfidenceBadge pct={confidence} /></div>
      <InfoBox>Score ELO : départ 1000 (neutre), 1100 (aimé), 1250 (coup de cœur). L'impact de chaque duel décroît à mesure que le film accumule des duels.</InfoBox>
      <div style={{ marginBottom: 12 }}>
        <ChipBar
          options={(["favorite", "liked", "none", "meh"] as MovieState[]).map(s => STATE_META[s].label)}
          selected={rankFilter ? STATE_META[rankFilter]?.label : null}
          onSelect={label => { const found = Object.entries(STATE_META).find(([, v]) => v.label === label); setRankFilter(found ? found[0] as MovieState : null); }}
          all="Tous"
        />
        <div style={{ display: "flex", gap: 8 }}>
          {([["elo", "Score ELO"], ["state", "Par état"]] as const).map(([val, lbl]) => (
            <button key={val} onClick={() => setRankSort(val)} style={{ padding: "5px 12px", borderRadius: 999, fontSize: 11, fontWeight: 700, cursor: "pointer", border: `1px solid ${rankSort === val ? "#8b5cf6" : "#334155"}`, background: rankSort === val ? "#4f46e5" : "#0f172a", color: rankSort === val ? "#fff" : "#64748b" }}>{lbl}</button>
          ))}
        </div>
      </div>
      <Card>
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          {ranking.length === 0 && <div style={{ textAlign: "center", padding: 20, color: "#475569", fontSize: 13 }}>Aucun film dans ce filtre.</div>}
          {ranking.map((movie, i) => {
            const dc = duelCounts[movie.id] ?? 0, sc = scores[movie.id] ?? 1000;
            return (
              <motion.div key={movie.id} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.025 }}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", borderRadius: 14, background: "#070a14" }}>
                <div style={{ width: 30, height: 30, borderRadius: 9, background: "#0f172a", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 12, flexShrink: 0, color: i === 0 ? "#f59e0b" : i === 1 ? "#94a3b8" : i === 2 ? "#b45309" : "#334155" }}>{i + 1}</div>
                <PosterBox movie={movie} size="mini" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#f1f5f9", lineHeight: 1.2 }}>{movie.title}</div>
                  <div style={{ fontSize: 11, color: "#475569" }}>{movie.year}{movie.genre ? ` · ${movie.genre.split(",")[0]}` : ""}</div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <Badge state={movieStates[movie.id] ?? "none"} />
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, marginTop: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: sc >= 1200 ? "#a78bfa" : sc >= 1100 ? "#3b82f6" : "#475569" }}>{sc}</span>
                    {dc > 0 && <span style={{ fontSize: 10, color: "#334155" }}>·{dc}d</span>}
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      </Card>
      <div style={{ ...G2, marginTop: 14 }}>
        <Btn onClick={() => openDuels(scores)}>Continuer les duels</Btn>
        <Btn primary={false} onClick={() => setScreen("triage")}>Ajuster le tri</Btn>
      </div>
      {Object.keys(profiles).length >= 2 && (
        <button onClick={() => setScreen("family")} style={{ marginTop: 12, width: "100%", height: 44, borderRadius: 14, border: "1px solid #1e3a5f", background: "#070a14", color: "#3b82f6", fontWeight: 700, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          <BarChart2 size={14} /> Vue familiale
        </button>
      )}
      <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
        <button onClick={resetSession} style={{ flex: 1, height: 40, borderRadius: 12, border: "none", background: "transparent", color: "#334155", fontWeight: 600, fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}><RefreshCw size={13} /> Recommencer</button>
        <button onClick={() => setScreen("welcome")} style={{ flex: 1, height: 40, borderRadius: 12, border: "none", background: "transparent", color: "#334155", fontWeight: 600, fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}><ArrowLeft size={13} /> Changer de profil</button>
      </div>
    </div></div>
  );

  return null;
}
