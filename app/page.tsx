"use client";

import React, { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Film,
  Trophy,
  Users,
  ChevronRight,
  RotateCcw,
  Heart,
  HeartCrack,
  EyeOff,
  Sparkles,
  RefreshCw,
  CheckCircle2,
} from "lucide-react";

const stateCycle = ["none", "unseen", "meh", "liked", "favorite"] as const;
type MovieState = (typeof stateCycle)[number];

type Movie = {
  id: number;
  title: string;
  year: number;
  genre: string;
  poster: string;
};

const moviesSeed: Movie[] = [
  { id: 1, title: "Jurassic Park", year: 1993, genre: "Aventure", poster: "🦖" },
  { id: 2, title: "Interstellar", year: 2014, genre: "Science-fiction", poster: "🚀" },
  { id: 3, title: "Home Alone", year: 1990, genre: "Familial", poster: "🏠" },
  { id: 4, title: "Get Out", year: 2017, genre: "Thriller", poster: "👁️" },
  { id: 5, title: "Matilda", year: 1996, genre: "Familial", poster: "📚" },
  { id: 6, title: "The Dark Knight", year: 2008, genre: "Action", poster: "🦇" },
  { id: 7, title: "Jumanji", year: 1995, genre: "Aventure", poster: "🎲" },
  { id: 8, title: "Amélie", year: 2001, genre: "Comédie dramatique", poster: "💚" },
  { id: 9, title: "Inception", year: 2010, genre: "Science-fiction", poster: "🌀" },
  { id: 10, title: "Spirited Away", year: 2001, genre: "Animation", poster: "🐉" },
  { id: 11, title: "National Treasure", year: 2004, genre: "Aventure", poster: "🗺️" },
  { id: 12, title: "Night at the Museum", year: 2006, genre: "Familial", poster: "🏛️" },
];

const stateMeta: Record<
  MovieState,
  { label: string; weight: number; tone: string; badgeTone: string }
> = {
  none: {
    label: "Non classé",
    weight: 1000,
    tone: "#ffffff",
    badgeTone: "#f8fafc",
  },
  unseen: {
    label: "Pas vu",
    weight: 0,
    tone: "#e2e8f0",
    badgeTone: "#e2e8f0",
  },
  meh: {
    label: "Hors course",
    weight: 850,
    tone: "#fef3c7",
    badgeTone: "#fffbeb",
  },
  liked: {
    label: "J'ai aimé",
    weight: 1100,
    tone: "#e0f2fe",
    badgeTone: "#f0f9ff",
  },
  favorite: {
    label: "Coup de cœur",
    weight: 1250,
    tone: "#ede9fe",
    badgeTone: "#f5f3ff",
  },
};

function nextState(current: MovieState): MovieState {
  const i = stateCycle.indexOf(current);
  return stateCycle[(i + 1) % stateCycle.length];
}

function expectedScore(a: number, b: number) {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

function applyElo(
  scores: Record<number, number>,
  winnerId: number,
  loserId: number,
  k = 24
) {
  const a = scores[winnerId] ?? 1000;
  const b = scores[loserId] ?? 1000;
  const ea = expectedScore(a, b);
  const eb = expectedScore(b, a);

  return {
    ...scores,
    [winnerId]: Math.round(a + k * (1 - ea)),
    [loserId]: Math.round(b + k * (0 - eb)),
  };
}

function buildInitialScores(movieStates: Record<number, MovieState>) {
  return Object.fromEntries(
    moviesSeed.map((m) => [m.id, stateMeta[movieStates[m.id]].weight])
  ) as Record<number, number>;
}

function chooseNextPair(
  scores: Record<number, number>,
  movieStates: Record<number, MovieState>,
  recentPairs: string[]
): [Movie, Movie] | null {
  const admissible = moviesSeed.filter((m) => movieStates[m.id] !== "unseen");

  if (admissible.length < 2) return null;

  const preferred = admissible.filter((m) => {
    const s = movieStates[m.id];
    return s === "favorite" || s === "liked" || s === "none";
  });

  const pool = preferred.length >= 2 ? preferred : admissible;
  const candidates: { pair: [Movie, Movie]; gap: number }[] = [];

  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i];
      const b = pool[j];
      const key = [a.id, b.id].sort((x, y) => x - y).join("-");
      if (recentPairs.includes(key)) continue;

      const gap = Math.abs((scores[a.id] ?? 1000) - (scores[b.id] ?? 1000));
      candidates.push({ pair: [a, b], gap });
    }
  }

  if (!candidates.length) {
    return pool.length >= 2 ? [pool[0], pool[1]] : null;
  }

  candidates.sort((x, y) => x.gap - y.gap);
  return candidates[0].pair;
}

function iconForState(state: MovieState) {
  switch (state) {
    case "unseen":
      return <EyeOff size={16} />;
    case "meh":
      return <HeartCrack size={16} />;
    case "liked":
      return <Heart size={16} />;
    case "favorite":
      return <Sparkles size={16} />;
    default:
      return <RotateCcw size={16} style={{ opacity: 0.45 }} />;
  }
}

function ScreenCard({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        borderRadius: 28,
        background: "#ffffff",
        border: "1px solid #e2e8f0",
        boxShadow: "0 8px 24px rgba(15, 23, 42, 0.06)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function BadgePill({
  children,
  dark = false,
}: {
  children: React.ReactNode;
  dark?: boolean;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "8px 14px",
        borderRadius: 999,
        fontSize: 13,
        fontWeight: 600,
        background: dark ? "#0f172a" : "#ffffff",
        color: dark ? "#ffffff" : "#0f172a",
        border: dark ? "none" : "1px solid #dbeafe",
      }}
    >
      {children}
    </div>
  );
}

function MetricBox({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <div
      style={{
        background: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: 24,
        padding: 16,
      }}
    >
      <div style={{ fontSize: 14, color: "#64748b", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#0f172a" }}>{value}</div>
    </div>
  );
}

function MovieTile({
  movie,
  state,
  onTap,
}: {
  movie: Movie;
  state: MovieState;
  onTap: () => void;
}) {
  const meta = stateMeta[state];

  return (
    <motion.button
      whileTap={{ scale: 0.98 }}
      onClick={onTap}
      style={{
        width: "100%",
        borderRadius: 24,
        border: "1px solid #e2e8f0",
        background: meta.tone,
        padding: 12,
        textAlign: "left",
        boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
      }}
    >
      <div
        style={{
          aspectRatio: "3 / 4",
          borderRadius: 18,
          background: "#e2e8f0",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 46,
          marginBottom: 12,
        }}
      >
        {movie.poster}
      </div>

      <div style={{ fontSize: 14, fontWeight: 700, color: "#0f172a", lineHeight: 1.2 }}>
        {movie.title}
      </div>
      <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>
        {movie.year} · {movie.genre}
      </div>

      <div
        style={{
          marginTop: 12,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div
          style={{
            padding: "6px 10px",
            borderRadius: 999,
            background: meta.badgeTone,
            border: "1px solid #dbeafe",
            fontSize: 11,
            fontWeight: 600,
            color: "#0f172a",
          }}
        >
          {meta.label}
        </div>
        <div style={{ color: "#0f172a" }}>{iconForState(state)}</div>
      </div>
    </motion.button>
  );
}

function DuelCard({
  movie,
  onChoose,
}: {
  movie: Movie;
  onChoose: () => void;
}) {
  return (
    <ScreenCard style={{ height: "100%" }}>
      <div style={{ padding: 12, display: "flex", flexDirection: "column", height: "100%" }}>
        <div
          style={{
            aspectRatio: "3 / 4",
            borderRadius: 24,
            background: "#e2e8f0",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 72,
            marginBottom: 14,
          }}
        >
          {movie.poster}
        </div>

        <div style={{ minHeight: 86 }}>
          <div
            style={{
              fontSize: 18,
              fontWeight: 800,
              color: "#0f172a",
              lineHeight: 1.15,
              marginBottom: 6,
            }}
          >
            {movie.title}
          </div>
          <div style={{ fontSize: 14, color: "#64748b" }}>
            {movie.year} · {movie.genre}
          </div>
        </div>

        <button
          onClick={onChoose}
          style={{
            marginTop: "auto",
            height: 46,
            width: "100%",
            borderRadius: 18,
            border: "none",
            background: "#4f46e5",
            color: "#ffffff",
            fontWeight: 700,
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          Je choisis ce film
        </button>
      </div>
    </ScreenCard>
  );
}

export default function Page() {
  const [screen, setScreen] = useState<"welcome" | "triage" | "duels" | "ranking">("welcome");
  const [alias, setAlias] = useState("");
  const [movieStates, setMovieStates] = useState<Record<number, MovieState>>(
    Object.fromEntries(moviesSeed.map((m) => [m.id, "none"])) as Record<number, MovieState>
  );
  const [scores, setScores] = useState<Record<number, number>>(
    Object.fromEntries(moviesSeed.map((m) => [m.id, 1000]))
  );
  const [currentPair, setCurrentPair] = useState<[Movie, Movie] | null>(null);
  const [recentPairs, setRecentPairs] = useState<string[]>([]);
  const [duelsResolved, setDuelsResolved] = useState(0);
  const [duelsSkipped, setDuelsSkipped] = useState(0);

  const stats = useMemo(() => {
    const values = Object.values(movieStates);
    return {
      unseen: values.filter((v) => v === "unseen").length,
      meh: values.filter((v) => v === "meh").length,
      liked: values.filter((v) => v === "liked").length,
      favorite: values.filter((v) => v === "favorite").length,
      triaged: values.filter((v) => v !== "none").length,
    };
  }, [movieStates]);

  const progress = Math.round((stats.triaged / moviesSeed.length) * 100);

  const rankingPreview = useMemo(() => {
    return [...moviesSeed]
      .sort((a, b) => (scores[b.id] ?? 1000) - (scores[a.id] ?? 1000))
      .slice(0, 10);
  }, [scores]);

  useEffect(() => {
    if (screen !== "duels") return;
    if (currentPair) return;
    const nextPair = chooseNextPair(scores, movieStates, recentPairs);
    setCurrentPair(nextPair);
  }, [screen, currentPair, scores, movieStates, recentPairs]);

  const chooseState = (movieId: number) => {
    setMovieStates((prev) => {
      const updated = { ...prev, [movieId]: nextState(prev[movieId]) };
      setScores(buildInitialScores(updated));
      return updated;
    });
  };

  const start = () => {
    if (!alias.trim()) return;
    setScores(buildInitialScores(movieStates));
    setScreen("triage");
  };

  const openDuels = () => {
    const initialScores = buildInitialScores(movieStates);
    setScores(initialScores);
    setRecentPairs([]);
    setCurrentPair(chooseNextPair(initialScores, movieStates, []));
    setScreen("duels");
  };

  const resolveDuel = (winnerId?: number) => {
    if (!currentPair) return;

    const [left, right] = currentPair;
    const pairKey = [left.id, right.id].sort((a, b) => a - b).join("-");
    const nextRecentPairs = [...recentPairs.slice(-14), pairKey];

    let nextScores = scores;

    if (winnerId) {
      const loserId = winnerId === left.id ? right.id : left.id;
      nextScores = applyElo(scores, winnerId, loserId);
      setScores(nextScores);
      setDuelsResolved((n) => n + 1);
    } else {
      setDuelsSkipped((n) => n + 1);
    }

    setRecentPairs(nextRecentPairs);
    setCurrentPair(chooseNextPair(nextScores, movieStates, nextRecentPairs));
  };

  const resetAll = () => {
    const emptyStates = Object.fromEntries(
      moviesSeed.map((m) => [m.id, "none"])
    ) as Record<number, MovieState>;

    setAlias("");
    setMovieStates(emptyStates);
    setScores(Object.fromEntries(moviesSeed.map((m) => [m.id, 1000])));
    setCurrentPair(null);
    setRecentPairs([]);
    setDuelsResolved(0);
    setDuelsSkipped(0);
    setScreen("welcome");
  };

  const duelFinished = screen === "duels" && !currentPair;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f8fafc",
        color: "#0f172a",
        padding: 16,
      }}
    >
      <div style={{ maxWidth: 460, margin: "0 auto", paddingBottom: 72 }}>
        {screen === "welcome" && (
          <div style={{ minHeight: "calc(100vh - 32px)", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
            <div style={{ paddingTop: 20 }}>
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 24,
                  background: "#ddd6fe",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#5b21b6",
                  marginBottom: 24,
                }}
              >
                <Film size={28} />
              </div>

              <div style={{ fontSize: 46, fontWeight: 900, lineHeight: 1.02, letterSpacing: "-0.03em" }}>
                Classement familial de films
              </div>

              <div style={{ marginTop: 14, fontSize: 16, lineHeight: 1.55, color: "#475569" }}>
                Faites émerger votre top personnel à partir d’un tri rapide, puis de duels entre films proches.
              </div>
            </div>

            <ScreenCard>
              <div style={{ padding: 22 }}>
                <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 18 }}>Bienvenue</div>

                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Nom ou pseudo</div>
                  <input
                    value={alias}
                    onChange={(e) => setAlias(e.target.value)}
                    placeholder="Ex. Nico, Timmie, Frère 1"
                    style={{
                      width: "100%",
                      height: 48,
                      borderRadius: 18,
                      border: "1px solid #cbd5e1",
                      padding: "0 14px",
                      fontSize: 16,
                      outline: "none",
                      background: "#ffffff",
                    }}
                  />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
                  <div style={{ borderRadius: 18, background: "#f8fafc", padding: 14 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Phase 1</div>
                    <div style={{ fontSize: 13, color: "#64748b" }}>Tri rapide des films</div>
                  </div>
                  <div style={{ borderRadius: 18, background: "#f8fafc", padding: 14 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Phase 2</div>
                    <div style={{ fontSize: 13, color: "#64748b" }}>Duels de départage</div>
                  </div>
                </div>

                <button
                  onClick={start}
                  style={{
                    width: "100%",
                    height: 48,
                    borderRadius: 18,
                    border: "none",
                    background: "#4f46e5",
                    color: "#ffffff",
                    fontWeight: 800,
                    fontSize: 16,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                    cursor: "pointer",
                  }}
                >
                  Commencer <ChevronRight size={18} />
                </button>
              </div>
            </ScreenCard>
          </div>
        )}

        {screen === "triage" && (
          <div>
            <div
              style={{
                position: "sticky",
                top: 0,
                zIndex: 10,
                background: "rgba(248,250,252,0.96)",
                backdropFilter: "blur(10px)",
                paddingBottom: 12,
                marginBottom: 16,
                borderBottom: "1px solid #e2e8f0",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 14, color: "#64748b" }}>Connecté comme</div>
                  <div style={{ fontWeight: 800 }}>{alias}</div>
                </div>
                <BadgePill dark>Phase 1</BadgePill>
              </div>

              <div
                style={{
                  height: 8,
                  width: "100%",
                  borderRadius: 999,
                  background: "#e2e8f0",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${progress}%`,
                    height: "100%",
                    background: "#4f46e5",
                  }}
                />
              </div>

              <div style={{ marginTop: 8, fontSize: 14, color: "#64748b" }}>
                {stats.triaged} films triés sur {moviesSeed.length}
              </div>
            </div>

            <ScreenCard style={{ marginBottom: 16 }}>
              <div style={{ padding: 18 }}>
                <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 10 }}>
                  Tapotez pour faire défiler l’état
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <BadgePill>✕ Pas vu</BadgePill>
                  <BadgePill>↓ Hors course</BadgePill>
                  <BadgePill>↑ J’ai aimé</BadgePill>
                  <BadgePill>↑↑ Coup de cœur</BadgePill>
                  <BadgePill>↺ Retour</BadgePill>
                </div>
              </div>
            </ScreenCard>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {moviesSeed.map((movie) => (
                <MovieTile
                  key={movie.id}
                  movie={movie}
                  state={movieStates[movie.id]}
                  onTap={() => chooseState(movie.id)}
                />
              ))}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 16 }}>
              <MetricBox label="Coup de cœur" value={stats.favorite} />
              <MetricBox label="Pas vus" value={stats.unseen} />
            </div>

            <button
              onClick={openDuels}
              style={{
                marginTop: 16,
                width: "100%",
                height: 48,
                borderRadius: 18,
                border: "none",
                background: "#4f46e5",
                color: "#ffffff",
                fontWeight: 800,
                fontSize: 16,
                cursor: "pointer",
              }}
            >
              Passer aux duels
            </button>
          </div>
        )}

        {screen === "duels" && (
          <div>
            <div
              style={{
                position: "sticky",
                top: 0,
                zIndex: 10,
                background: "rgba(248,250,252,0.96)",
                backdropFilter: "blur(10px)",
                paddingBottom: 12,
                marginBottom: 16,
                borderBottom: "1px solid #e2e8f0",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 14, color: "#64748b" }}>Phase 2</div>
                  <div style={{ fontSize: 20, fontWeight: 900 }}>Duels de départage</div>
                </div>
                <BadgePill dark>{duelsResolved} tranchés</BadgePill>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                <MetricBox label="Fav." value={stats.favorite} />
                <MetricBox label="Aimés" value={stats.liked} />
                <MetricBox label="Passés" value={duelsSkipped} />
              </div>
            </div>

            {duelFinished ? (
              <ScreenCard>
                <div style={{ padding: 22, textAlign: "center" }}>
                  <div style={{ color: "#10b981", marginBottom: 12, display: "flex", justifyContent: "center" }}>
                    <CheckCircle2 size={52} />
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 10 }}>
                    Aucun autre duel prioritaire
                  </div>
                  <div style={{ fontSize: 14, lineHeight: 1.6, color: "#64748b", marginBottom: 18 }}>
                    Vous avez épuisé les duels utiles pour ce petit corpus. Vous pouvez voir votre classement, revenir au tri initial ou relancer un autre cycle.
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
                    <button
                      onClick={() => setScreen("ranking")}
                      style={{
                        height: 48,
                        borderRadius: 18,
                        border: "none",
                        background: "#4f46e5",
                        color: "#ffffff",
                        fontWeight: 800,
                        fontSize: 15,
                        cursor: "pointer",
                      }}
                    >
                      Voir mon classement
                    </button>

                    <button
                      onClick={openDuels}
                      style={{
                        height: 48,
                        borderRadius: 18,
                        border: "1px solid #cbd5e1",
                        background: "#ffffff",
                        color: "#0f172a",
                        fontWeight: 700,
                        fontSize: 15,
                        cursor: "pointer",
                      }}
                    >
                      Relancer des duels
                    </button>
                  </div>
                </div>
              </ScreenCard>
            ) : currentPair ? (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "stretch" }}>
                  <DuelCard movie={currentPair[0]} onChoose={() => resolveDuel(currentPair[0].id)} />
                  <DuelCard movie={currentPair[1]} onChoose={() => resolveDuel(currentPair[1].id)} />
                </div>

                <button
                  onClick={() => resolveDuel()}
                  style={{
                    marginTop: 14,
                    width: "100%",
                    height: 48,
                    borderRadius: 18,
                    border: "1px solid #cbd5e1",
                    background: "#ffffff",
                    color: "#0f172a",
                    fontWeight: 700,
                    fontSize: 15,
                    cursor: "pointer",
                  }}
                >
                  Passer ce duel
                </button>
              </>
            ) : null}

            <button
              onClick={() => setScreen("ranking")}
              style={{
                marginTop: 12,
                width: "100%",
                height: 48,
                borderRadius: 18,
                border: "none",
                background: "transparent",
                color: "#0f172a",
                fontWeight: 700,
                fontSize: 15,
                cursor: "pointer",
              }}
            >
              Voir mon classement
            </button>
          </div>
        )}

        {screen === "ranking" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 14, color: "#64748b" }}>Résultats</div>
                <div style={{ fontSize: 24, fontWeight: 900 }}>Top provisoire de {alias}</div>
              </div>
              <div
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: 24,
                  background: "#e0e7ff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#d97706",
                }}
              >
                <Trophy size={34} />
              </div>
            </div>

            <ScreenCard>
              <div style={{ padding: 18 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 18, fontWeight: 800, marginBottom: 14 }}>
                  <Users size={18} />
                  Aperçu du classement
                </div>

                <div style={{ display: "grid", gap: 12 }}>
                  {rankingPreview.map((movie, index) => (
                    <div
                      key={movie.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        borderRadius: 20,
                        background: "#f8fafc",
                        padding: 12,
                      }}
                    >
                      <div
                        style={{
                          width: 40,
                          height: 40,
                          borderRadius: 999,
                          background: "#ffffff",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontWeight: 800,
                          boxShadow: "0 4px 10px rgba(15, 23, 42, 0.05)",
                          flexShrink: 0,
                        }}
                      >
                        {index + 1}
                      </div>

                      <div
                        style={{
                          width: 48,
                          height: 48,
                          borderRadius: 18,
                          background: "#ffffff",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 26,
                          boxShadow: "0 4px 10px rgba(15, 23, 42, 0.05)",
                          flexShrink: 0,
                        }}
                      >
                        {movie.poster}
                      </div>

                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                          style={{
                            fontWeight: 800,
                            color: "#0f172a",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {movie.title}
                        </div>
                        <div style={{ fontSize: 14, color: "#64748b" }}>
                          {movie.year} · {movie.genre}
                        </div>
                      </div>

                      <div
                        style={{
                          padding: "8px 12px",
                          borderRadius: 999,
                          background: "#ffffff",
                          border: "1px solid #dbeafe",
                          fontSize: 12,
                          fontWeight: 600,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {stateMeta[movieStates[movie.id]].label}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </ScreenCard>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 16 }}>
              <button
                onClick={openDuels}
                style={{
                  height: 48,
                  borderRadius: 18,
                  border: "none",
                  background: "#4f46e5",
                  color: "#ffffff",
                  fontWeight: 800,
                  fontSize: 15,
                  cursor: "pointer",
                }}
              >
                Continuer
              </button>

              <button
                onClick={() => setScreen("triage")}
                style={{
                  height: 48,
                  borderRadius: 18,
                  border: "1px solid #cbd5e1",
                  background: "#ffffff",
                  color: "#0f172a",
                  fontWeight: 700,
                  fontSize: 15,
                  cursor: "pointer",
                }}
              >
                Ajuster le tri
              </button>
            </div>

            <button
              onClick={resetAll}
              style={{
                marginTop: 14,
                width: "100%",
                height: 48,
                borderRadius: 18,
                border: "none",
                background: "transparent",
                color: "#0f172a",
                fontWeight: 700,
                fontSize: 15,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                cursor: "pointer",
              }}
            >
              <RefreshCw size={16} />
              Recommencer du début
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
