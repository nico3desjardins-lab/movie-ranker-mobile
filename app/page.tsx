"use client";

import React, { useEffect, useMemo, useState } from "react";
import { motion, useMotionValue, useTransform } from "framer-motion";
import { supabase } from "../lib/supabase";
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

type Screen = "welcome" | "triage" | "warmup" | "duels" | "ranking";

type Movie = {
  id: number;
  title: string;
  year: number;
  genre: string;
  poster: string;
  posterUrl?: string | null;
};

const fallbackMovies: Movie[] = [
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
    weight: 1000,
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

function buildInitialScores(
  movies: Movie[],
  movieStates: Record<number, MovieState>
) {
  return Object.fromEntries(
    movies
      .filter((m) => (movieStates[m.id] ?? "none") !== "unseen")
      .map((m) => [m.id, stateMeta[movieStates[m.id] ?? "none"].weight])
  ) as Record<number, number>;
}

function shuffleArray<T>(array: T[]): T[] {
  const copy = [...array];

  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  return copy;
}

function chooseNextPair(
  movies: Movie[],
  scores: Record<number, number>,
  movieStates: Record<number, MovieState>,
  recentPairs: string[],
  recentMovieIds: number[]
): [Movie, Movie] | null {
  const admissible = movies.filter((m) => {
    const state = movieStates[m.id] ?? "none";
    return state !== "unseen";
  });

  if (admissible.length < 2) return null;

  const preferred = admissible.filter((m) => {
    const s = movieStates[m.id] ?? "none";
    return s === "favorite" || s === "liked" || s === "none";
  });

  const basePool = preferred.length >= 2 ? preferred : admissible;
  const pool = shuffleArray(basePool);

  const strictCandidates: { pair: [Movie, Movie]; scoreGap: number }[] = [];
  const relaxedCandidates: {
    pair: [Movie, Movie];
    scoreGap: number;
    recentCount: number;
  }[] = [];

  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i];
      const b = pool[j];

      const key = [a.id, b.id].sort((x, y) => x - y).join("-");
      if (recentPairs.includes(key)) continue;

      const scoreGap = Math.abs((scores[a.id] ?? 1000) - (scores[b.id] ?? 1000));
      const aRecent = recentMovieIds.includes(a.id);
      const bRecent = recentMovieIds.includes(b.id);
      const recentCount = (aRecent ? 1 : 0) + (bRecent ? 1 : 0);

      if (!aRecent && !bRecent) {
        strictCandidates.push({
          pair: [a, b],
          scoreGap,
        });
      }

      relaxedCandidates.push({
        pair: [a, b],
        scoreGap,
        recentCount,
      });
    }
  }

  if (strictCandidates.length > 0) {
    strictCandidates.sort((x, y) => x.scoreGap - y.scoreGap);
    const bestGap = strictCandidates[0].scoreGap;
    const topCandidates = strictCandidates.filter((c) => c.scoreGap === bestGap);
    return topCandidates[Math.floor(Math.random() * topCandidates.length)].pair;
  }

  if (relaxedCandidates.length > 0) {
    relaxedCandidates.sort((x, y) => {
      if (x.recentCount !== y.recentCount) {
        return x.recentCount - y.recentCount;
      }
      return x.scoreGap - y.scoreGap;
    });

    const bestRecentCount = relaxedCandidates[0].recentCount;
    const bestGap = relaxedCandidates[0].scoreGap;
    const topCandidates = relaxedCandidates.filter(
      (c) => c.recentCount === bestRecentCount && c.scoreGap === bestGap
    );

    return topCandidates[Math.floor(Math.random() * topCandidates.length)].pair;
  }

  return pool.length >= 2 ? [pool[0], pool[1]] : null;
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

function PosterBox({
  movie,
  size = "tile",
}: {
  movie: Movie;
  size?: "tile" | "duel" | "mini";
}) {
  const styles: React.CSSProperties =
    size === "duel"
      ? {
          aspectRatio: "3 / 4",
          borderRadius: 24,
          fontSize: 72,
          marginBottom: 14,
        }
      : size === "mini"
      ? {
          width: 48,
          height: 48,
          borderRadius: 18,
          fontSize: 26,
        }
      : {
          aspectRatio: "3 / 4",
          borderRadius: 18,
          fontSize: 46,
          marginBottom: 12,
        };

  return (
    <div
      style={{
        background: "#e2e8f0",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        flexShrink: 0,
        boxShadow: size === "mini" ? "0 4px 10px rgba(15, 23, 42, 0.05)" : undefined,
        ...styles,
      }}
    >
      {movie.posterUrl ? (
        <img
          src={movie.posterUrl}
          alt={movie.title}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
          }}
        />
      ) : (
        movie.poster
      )}
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
      <PosterBox movie={movie} size="tile" />

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
  swipeDirection,
}: {
  movie: Movie;
  onChoose: () => void;
  swipeDirection: "left" | "right";
}) {
  const x = useMotionValue(0);

  const rotate = useTransform(x, [-140, 0, 140], [-8, 0, 8]);
  const overlayOpacity = useTransform(
    x,
    swipeDirection === "right" ? [0, 60, 140] : [-140, -60, 0],
    [0, 0.35, 0.75]
  );

  const chooseOpacity = useTransform(
    x,
    swipeDirection === "right" ? [0, 60, 140] : [-140, -60, 0],
    [0, 0.6, 1]
  );

  return (
    <ScreenCard style={{ height: "100%", overflow: "hidden", position: "relative" }}>
      <motion.div
        drag="x"
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.18}
        style={{
          x,
          rotate,
          padding: 12,
          display: "flex",
          flexDirection: "column",
          height: "100%",
          touchAction: "pan-y",
          cursor: "grab",
          position: "relative",
        }}
        whileTap={{ cursor: "grabbing", scale: 0.99 }}
        onDragEnd={(_, info) => {
          const offsetX = info.offset.x;
          const threshold = 90;

          if (swipeDirection === "right" && offsetX > threshold) {
            onChoose();
            return;
          }

          if (swipeDirection === "left" && offsetX < -threshold) {
            onChoose();
            return;
          }
        }}
      >
        <motion.div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(79, 70, 229, 0.14)",
            pointerEvents: "none",
            opacity: overlayOpacity,
            borderRadius: 28,
          }}
        />

        <motion.div
          style={{
            position: "absolute",
            top: 14,
            left: swipeDirection === "right" ? 14 : undefined,
            right: swipeDirection === "left" ? 14 : undefined,
            padding: "8px 12px",
            borderRadius: 999,
            background: "#4f46e5",
            color: "#ffffff",
            fontSize: 12,
            fontWeight: 800,
            letterSpacing: "0.02em",
            pointerEvents: "none",
            opacity: chooseOpacity,
            zIndex: 2,
          }}
        >
          CHOISIR
        </motion.div>

        <PosterBox movie={movie} size="duel" />

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

        <div
          style={{
            marginTop: 10,
            marginBottom: 12,
            fontSize: 12,
            fontWeight: 700,
            textAlign: "center",
            borderRadius: 999,
            padding: "8px 12px",
            background: "#eef2ff",
            color: "#312e81",
          }}
        >
          {swipeDirection === "right"
            ? "Glissez à droite pour choisir"
            : "Glissez à gauche pour choisir"}
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
      </motion.div>
    </ScreenCard>
  );
}

async function getOrCreateProfile(displayName: string) {
  if (!supabase) return null;

  const { data: existing, error: existingError } = await supabase
    .from("profiles")
    .select("id, display_name")
    .eq("display_name", displayName)
    .maybeSingle();

  if (existingError) {
    console.error("Erreur lecture profile:", existingError.message);
    return null;
  }

  if (existing) return existing.id as string;

  const { data: created, error: createError } = await supabase
    .from("profiles")
    .insert({ display_name: displayName })
    .select("id")
    .single();

  if (createError) {
    console.error("Erreur création profile:", createError.message);
    return null;
  }

  return created.id as string;
}

async function loadSavedStates(profileId: string) {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("movie_states")
    .select("movie_id, state")
    .eq("profile_id", profileId);

  if (error) {
    console.error("Erreur chargement états:", error.message);
    return null;
  }

  if (!data || !data.length) return {};

  const mapped = Object.fromEntries(
    data.map((row) => [Number(row.movie_id), row.state as MovieState])
  ) as Record<number, MovieState>;

  return mapped;
}

async function saveMovieState(
  profileId: string,
  movieId: number,
  state: MovieState
) {
  if (!supabase) return;

  const { error } = await supabase
    .from("movie_states")
    .upsert(
      {
        profile_id: profileId,
        movie_id: movieId,
        state,
      },
      {
        onConflict: "profile_id,movie_id",
      }
    );

  if (error) {
    console.error("Erreur sauvegarde état:", error.message);
  }
}

function PlayerBadge({ alias }: { alias: string }) {
  if (!alias.trim()) return null;

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 14px",
        borderRadius: 999,
        background: "#eef2ff",
        color: "#312e81",
        border: "1px solid #c7d2fe",
        fontSize: 13,
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}
    >
      Profil : {alias}
    </div>
  );
}

export default function Page() {
  const [movies, setMovies] = useState<Movie[]>(fallbackMovies);
  const [isLoadingMovies, setIsLoadingMovies] = useState(true);
  const [moviesSource, setMoviesSource] = useState<"supabase" | "fallback">("fallback");
  const [screen, setScreen] = useState<Screen>("welcome");
  const [alias, setAlias] = useState("");
  const [movieStates, setMovieStates] = useState<Record<number, MovieState>>(
    Object.fromEntries(fallbackMovies.map((m) => [m.id, "none"])) as Record<number, MovieState>
  );
  const [scores, setScores] = useState<Record<number, number>>(
    Object.fromEntries(fallbackMovies.map((m) => [m.id, 1000]))
  );
  const [currentPair, setCurrentPair] = useState<[Movie, Movie] | null>(null);
  const [recentPairs, setRecentPairs] = useState<string[]>([]);
  const [recentMovieIds, setRecentMovieIds] = useState<number[]>([]);
  const [duelsResolved, setDuelsResolved] = useState(0);
  const [duelsSkipped, setDuelsSkipped] = useState(0);
  const [diagnostic, setDiagnostic] = useState("");
  const [profileId, setProfileId] = useState<string | null>(null);

  const [triageOrder, setTriageOrder] = useState<number[]>([]);
  const [triagePage, setTriagePage] = useState(0);

  const [warmupOrder, setWarmupOrder] = useState<number[]>([]);
  const [warmupRound, setWarmupRound] = useState(0);
  const [warmupSelectedIds, setWarmupSelectedIds] = useState<number[]>([]);
  const [warmupRecentlyShownIds, setWarmupRecentlyShownIds] = useState<number[]>([]);

  const warmupRoundsTotal = 8;
  const warmupBatchSize = 6;
  const warmupKeepCount = 2;

  useEffect(() => {
    async function loadMovies() {
      setIsLoadingMovies(true);

      if (!supabase) {
        setDiagnostic("supabase client absent");
        setMovies(fallbackMovies);
        setMoviesSource("fallback");

        const initialStates = Object.fromEntries(
          fallbackMovies.map((m) => [m.id, "none"])
        ) as Record<number, MovieState>;

        setMovieStates(initialStates);
        setScores(Object.fromEntries(fallbackMovies.map((m) => [m.id, 1000])));
        setIsLoadingMovies(false);
        return;
      }

      const { data, error } = await supabase
        .from("movies_catalog")
        .select("id, title, year, genre, poster_emoji, poster_url, title_fr")
        .eq("is_active", true)
        .order("id", { ascending: true });

      if (error) {
        setDiagnostic(`erreur supabase: ${error.message}`);
        setMovies(fallbackMovies);
        setMoviesSource("fallback");

        const initialStates = Object.fromEntries(
          fallbackMovies.map((m) => [m.id, "none"])
        ) as Record<number, MovieState>;

        setMovieStates(initialStates);
        setScores(Object.fromEntries(fallbackMovies.map((m) => [m.id, 1000])));
        setIsLoadingMovies(false);
        return;
      }

      if (data && data.length > 0) {
        setDiagnostic(`supabase ok: ${data.length} films`);

        const fetchedMovies: Movie[] = data.map((m) => ({
          id: Number(m.id),
          title: m.title_fr || m.title,
          year: m.year ?? 0,
          genre: m.genre ?? "",
          poster: m.poster_emoji || "🎬",
          posterUrl: m.poster_url ?? null,
        }));

        setMovies(fetchedMovies);
        setMoviesSource("supabase");

        const initialStates = Object.fromEntries(
          fetchedMovies.map((m) => [m.id, "none"])
        ) as Record<number, MovieState>;

        setMovieStates(initialStates);
        setScores(Object.fromEntries(fetchedMovies.map((m) => [m.id, 1000])));
      } else {
        setDiagnostic("requête ok, mais aucun film retourné");
        setMovies(fallbackMovies);
        setMoviesSource("fallback");

        const initialStates = Object.fromEntries(
          fallbackMovies.map((m) => [m.id, "none"])
        ) as Record<number, MovieState>;

        setMovieStates(initialStates);
        setScores(Object.fromEntries(fallbackMovies.map((m) => [m.id, 1000])));
      }

      setIsLoadingMovies(false);
    }

    loadMovies();
  }, []);

  useEffect(() => {
    if (!movies.length) return;

    setTriageOrder(shuffleArray(movies.map((m) => m.id)));
    setTriagePage(0);
  }, [movies]);

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

  const progress = movies.length ? Math.round((stats.triaged / movies.length) * 100) : 0;

  const rankingPreview = useMemo(() => {
    return [...movies]
      .filter((m) => (movieStates[m.id] ?? "none") !== "unseen")
      .sort((a, b) => (scores[b.id] ?? 1000) - (scores[a.id] ?? 1000))
      .slice(0, 10);
  }, [movies, scores, movieStates]);

  const triageBatch = useMemo(() => {
    const batchSize = 10;
    const start = triagePage * batchSize;
    const currentIds = triageOrder.slice(start, start + batchSize);

    return currentIds
      .map((id) => movies.find((m) => m.id === id))
      .filter((m): m is Movie => Boolean(m));
  }, [movies, triageOrder, triagePage]);

  const warmupEligibleIds = useMemo(() => {
    return movies
      .filter((m) => {
        const state = movieStates[m.id] ?? "none";
        return state !== "unseen" && state !== "meh";
      })
      .map((m) => m.id);
  }, [movies, movieStates]);

  const warmupBatch = useMemo(() => {
    const ids = warmupOrder.slice(0, warmupBatchSize);
    return ids
      .map((id) => movies.find((m) => m.id === id))
      .filter((m): m is Movie => Boolean(m));
  }, [movies, warmupOrder]);

  useEffect(() => {
    if (screen !== "duels") return;
    if (currentPair) return;

    const nextPair = chooseNextPair(
      movies,
      scores,
      movieStates,
      recentPairs,
      recentMovieIds
    );

    setCurrentPair(nextPair);
  }, [screen, currentPair, movies, scores, movieStates, recentPairs, recentMovieIds]);

  const goToNextTriageBatch = () => {
    const batchSize = 10;
    const totalPages = Math.ceil(triageOrder.length / batchSize);

    if (totalPages <= 1) return;

    if (triagePage + 1 < totalPages) {
      setTriagePage((p) => p + 1);
      return;
    }

    setTriageOrder(shuffleArray(movies.map((m) => m.id)));
    setTriagePage(0);
  };

  const chooseState = async (movieId: number) => {
    const next = nextState(movieStates[movieId] ?? "none");
    const updated = { ...movieStates, [movieId]: next };

    setMovieStates(updated);
    setScores(buildInitialScores(movies, updated));

    if (profileId) {
      await saveMovieState(profileId, movieId, next);
    }
  };

  const start = async () => {
    const cleanAlias = alias.trim();
    if (!cleanAlias) return;

    const id = await getOrCreateProfile(cleanAlias);
    setProfileId(id);

    if (id) {
      const savedStates = await loadSavedStates(id);

      if (savedStates && Object.keys(savedStates).length > 0) {
        const mergedStates = Object.fromEntries(
          movies.map((m) => [m.id, savedStates[m.id] ?? "none"])
        ) as Record<number, MovieState>;

        setMovieStates(mergedStates);
        setScores(buildInitialScores(movies, mergedStates));
      } else {
        setScores(buildInitialScores(movies, movieStates));
      }
    } else {
      setScores(buildInitialScores(movies, movieStates));
    }

    setScreen("triage");
  };

  const openWarmup = () => {
    const initialScores = buildInitialScores(movies, movieStates);
    setScores(initialScores);

    const candidates = warmupEligibleIds.length >= warmupBatchSize
      ? shuffleArray(warmupEligibleIds)
      : shuffleArray(
          movies
            .filter((m) => (movieStates[m.id] ?? "none") !== "unseen")
            .map((m) => m.id)
        );

    setWarmupOrder(candidates);
    setWarmupRound(0);
    setWarmupSelectedIds([]);
    setWarmupRecentlyShownIds([]);
    setScreen("warmup");
  };

  const toggleWarmupSelection = (movieId: number) => {
    setWarmupSelectedIds((current) => {
      if (current.includes(movieId)) {
        return current.filter((id) => id !== movieId);
      }

      if (current.length >= warmupKeepCount) {
        return current;
      }

      return [...current, movieId];
    });
  };

  const advanceWarmupBatch = (excludeIds: number[]) => {
    const eligiblePool = warmupEligibleIds.filter(
      (id) => !excludeIds.includes(id) && !warmupRecentlyShownIds.includes(id)
    );

    let nextPool = eligiblePool;

    if (nextPool.length < warmupBatchSize) {
      nextPool = warmupEligibleIds.filter((id) => !excludeIds.includes(id));
    }

    const nextBatchIds = shuffleArray(nextPool).slice(0, warmupBatchSize);
    setWarmupOrder(nextBatchIds);
  };

  const validateWarmupRound = () => {
    if (warmupSelectedIds.length !== warmupKeepCount) return;

    const currentBatchIds = warmupBatch.map((m) => m.id);
    const selectedSet = new Set(warmupSelectedIds);

    setScores((prevScores) => {
      const nextScores = { ...prevScores };

      for (const movieId of currentBatchIds) {
        if ((movieStates[movieId] ?? "none") === "unseen") continue;

        const currentScore = nextScores[movieId] ?? 1000;

        if (selectedSet.has(movieId)) {
          nextScores[movieId] = currentScore + 25;
        } else {
          nextScores[movieId] = currentScore - 8;
        }
      }

      return nextScores;
    });

    const nextRecentlyShown = [...warmupRecentlyShownIds.slice(-18), ...currentBatchIds];
    setWarmupRecentlyShownIds(nextRecentlyShown);
    setWarmupSelectedIds([]);

    if (warmupRound + 1 >= warmupRoundsTotal) {
      setScreen("duels");
      setRecentPairs([]);
      setRecentMovieIds([]);
      setCurrentPair(
        chooseNextPair(movies, scores, movieStates, [], [])
      );
      return;
    }

    setWarmupRound((r) => r + 1);
    advanceWarmupBatch(currentBatchIds);
  };

  const skipWarmup = () => {
    openDuels();
  };

  const openDuels = () => {
    const initialScores = scores && Object.keys(scores).length > 0
      ? scores
      : buildInitialScores(movies, movieStates);

    setScores(initialScores);
    setRecentPairs([]);
    setRecentMovieIds([]);
    setCurrentPair(
      chooseNextPair(movies, initialScores, movieStates, [], [])
    );
    setScreen("duels");
  };

  const resolveDuel = (winnerId?: number) => {
    if (!currentPair) return;

    const [left, right] = currentPair;
    const pairKey = [left.id, right.id].sort((a, b) => a - b).join("-");
    const nextRecentPairs = [...recentPairs.slice(-14), pairKey];
    const nextRecentMovieIds = [...recentMovieIds.slice(-10), left.id, right.id];

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
    setRecentMovieIds(nextRecentMovieIds);

    setCurrentPair(
      chooseNextPair(
        movies,
        nextScores,
        movieStates,
        nextRecentPairs,
        nextRecentMovieIds
      )
    );
  };

  const resetAll = () => {
    const emptyStates = Object.fromEntries(
      movies.map((m) => [m.id, "none"])
    ) as Record<number, MovieState>;

    setAlias("");
    setMovieStates(emptyStates);
    setScores(Object.fromEntries(movies.map((m) => [m.id, 1000])));
    setCurrentPair(null);
    setRecentPairs([]);
    setRecentMovieIds([]);
    setDuelsResolved(0);
    setDuelsSkipped(0);
    setTriagingDefaults();
    setScreen("welcome");
  };

  const setTriagingDefaults = () => {
    setTriageOrder(shuffleArray(movies.map((m) => m.id)));
    setTriagePage(0);
    setWarmupOrder([]);
    setWarmupRound(0);
    setWarmupSelectedIds([]);
    setWarmupRecentlyShownIds([]);
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
          <div
            style={{
              minHeight: "calc(100vh - 32px)",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
            }}
          >
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

              <div
                style={{
                  fontSize: 46,
                  fontWeight: 900,
                  lineHeight: 1.02,
                  letterSpacing: "-0.03em",
                }}
              >
                Classement familial de films
              </div>

              <div style={{ marginTop: 14, fontSize: 16, lineHeight: 1.55, color: "#475569" }}>
                Faites émerger votre top personnel à partir d’un tri rapide, puis de sélections par lot et de duels entre films proches.
              </div>

              <div style={{ marginTop: 16, fontSize: 13, color: "#64748b" }}>
                Source des films : {isLoadingMovies ? "chargement..." : moviesSource}
                <div style={{ marginTop: 6, fontSize: 12, color: "#94a3b8" }}>
                  Diagnostic : {diagnostic || "aucun"}
                </div>
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

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 12,
                    marginBottom: 16,
                  }}
                >
                  <div style={{ borderRadius: 18, background: "#f8fafc", padding: 14 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Phase 1</div>
                    <div style={{ fontSize: 13, color: "#64748b" }}>Tri rapide des films</div>
                  </div>
                  <div style={{ borderRadius: 18, background: "#f8fafc", padding: 14 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Phase 1,5</div>
                    <div style={{ fontSize: 13, color: "#64748b" }}>Gardez les 2 meilleurs du lot</div>
                  </div>
                </div>

                <button
                  onClick={start}
                  disabled={isLoadingMovies || movies.length === 0}
                  style={{
                    width: "100%",
                    height: 48,
                    borderRadius: 18,
                    border: "none",
                    background: isLoadingMovies ? "#94a3b8" : "#4f46e5",
                    color: "#ffffff",
                    fontWeight: 800,
                    fontSize: 16,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                    cursor: isLoadingMovies ? "not-allowed" : "pointer",
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
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                  marginBottom: 10,
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <PlayerBadge alias={alias} />
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
                {stats.triaged} films triés sur {movies.length}
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

            <div style={{ marginBottom: 12, fontSize: 14, color: "#64748b" }}>
              Groupe {triagePage + 1} · {triageBatch.length} films affichés
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {triageBatch.map((movie) => (
                <MovieTile
                  key={movie.id}
                  movie={movie}
                  state={movieStates[movie.id] ?? "none"}
                  onTap={() => chooseState(movie.id)}
                />
              ))}
            </div>

            <button
              onClick={goToNextTriageBatch}
              style={{
                marginTop: 16,
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
              Prochain groupe
            </button>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
                marginTop: 16,
              }}
            >
              <MetricBox label="Coup de cœur" value={stats.favorite} />
              <MetricBox label="Pas vus" value={stats.unseen} />
            </div>

            <button
              onClick={openWarmup}
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
              Passer au tour de chauffe
            </button>
          </div>
        )}

        {screen === "warmup" && (
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
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                  marginBottom: 10,
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <PlayerBadge alias={alias} />
                  <div>
                    <div style={{ fontSize: 14, color: "#64748b" }}>Phase 1,5</div>
                    <div style={{ fontSize: 20, fontWeight: 900 }}>Tour de chauffe</div>
                  </div>
                </div>
                <BadgePill dark>
                  Manche {Math.min(warmupRound + 1, warmupRoundsTotal)} / {warmupRoundsTotal}
                </BadgePill>
              </div>

              <div style={{ fontSize: 14, color: "#64748b" }}>
                Gardez les {warmupKeepCount} meilleurs du lot.
              </div>
            </div>

            <ScreenCard style={{ marginBottom: 16 }}>
              <div style={{ padding: 18 }}>
                <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 8 }}>
                  Sélectionnez exactement {warmupKeepCount} films
                </div>
                <div style={{ fontSize: 14, color: "#64748b" }}>
                  Cette étape sert à dégrossir rapidement avant les vrais duels.
                </div>
              </div>
            </ScreenCard>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {warmupBatch.map((movie) => {
                const selected = warmupSelectedIds.includes(movie.id);

                return (
                  <motion.button
                    key={movie.id}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => toggleWarmupSelection(movie.id)}
                    style={{
                      width: "100%",
                      borderRadius: 24,
                      border: selected ? "2px solid #4f46e5" : "1px solid #e2e8f0",
                      background: selected ? "#eef2ff" : "#ffffff",
                      padding: 12,
                      textAlign: "left",
                      boxShadow: selected
                        ? "0 8px 18px rgba(79, 70, 229, 0.16)"
                        : "0 4px 14px rgba(15, 23, 42, 0.04)",
                    }}
                  >
                    <PosterBox movie={movie} size="tile" />

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
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <div
                        style={{
                          padding: "6px 10px",
                          borderRadius: 999,
                          background: selected ? "#4f46e5" : "#f8fafc",
                          color: selected ? "#ffffff" : "#0f172a",
                          border: selected ? "none" : "1px solid #dbeafe",
                          fontSize: 11,
                          fontWeight: 700,
                        }}
                      >
                        {selected ? "Sélectionné" : "Choisir"}
                      </div>

                      <div style={{ color: "#0f172a" }}>
                        {iconForState(movieStates[movie.id] ?? "none")}
                      </div>
                    </div>
                  </motion.button>
                );
              })}
            </div>

            <button
              onClick={validateWarmupRound}
              disabled={warmupSelectedIds.length !== warmupKeepCount}
              style={{
                marginTop: 16,
                width: "100%",
                height: 48,
                borderRadius: 18,
                border: "none",
                background:
                  warmupSelectedIds.length === warmupKeepCount ? "#4f46e5" : "#94a3b8",
                color: "#ffffff",
                fontWeight: 800,
                fontSize: 16,
                cursor:
                  warmupSelectedIds.length === warmupKeepCount ? "pointer" : "not-allowed",
              }}
            >
              Valider mes {warmupKeepCount} choix
            </button>

            <button
              onClick={skipWarmup}
              style={{
                marginTop: 12,
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
              Passer directement aux duels
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
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                  marginBottom: 10,
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <PlayerBadge alias={alias} />
                  <div>
                    <div style={{ fontSize: 14, color: "#64748b" }}>Phase 2</div>
                    <div style={{ fontSize: 20, fontWeight: 900 }}>Duels de départage</div>
                  </div>
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
                  <div
                    style={{
                      color: "#10b981",
                      marginBottom: 12,
                      display: "flex",
                      justifyContent: "center",
                    }}
                  >
                    <CheckCircle2 size={52} />
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 10 }}>
                    Aucun autre duel prioritaire
                  </div>
                  <div
                    style={{
                      fontSize: 14,
                      lineHeight: 1.6,
                      color: "#64748b",
                      marginBottom: 18,
                    }}
                  >
                    Vous avez épuisé les duels utiles pour ce corpus. Vous pouvez voir votre classement, revenir au tri initial ou relancer un autre cycle.
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
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 12,
                    alignItems: "stretch",
                  }}
                >
                  <DuelCard
                    movie={currentPair[0]}
                    swipeDirection="right"
                    onChoose={() => resolveDuel(currentPair[0].id)}
                  />
                  <DuelCard
                    movie={currentPair[1]}
                    swipeDirection="left"
                    onChoose={() => resolveDuel(currentPair[1].id)}
                  />
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
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                marginBottom: 14,
              }}
            >
              <div>
                <div style={{ fontSize: 14, color: "#64748b" }}>Résultats</div>
                <div style={{ marginTop: 8 }}>
                  <PlayerBadge alias={alias} />
                </div>
                <div style={{ fontSize: 24, fontWeight: 900, marginTop: 8 }}>
                  Top provisoire de {alias}
                </div>
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
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 18,
                    fontWeight: 800,
                    marginBottom: 14,
                  }}
                >
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

                      <PosterBox movie={movie} size="mini" />

                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 15,
                            fontWeight: 700,
                            color: "#0f172a",
                            lineHeight: 1.2,
                            marginBottom: 4,
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
                        {stateMeta[movieStates[movie.id] ?? "none"].label}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </ScreenCard>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
                marginTop: 16,
              }}
            >
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
