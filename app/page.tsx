"use client";

import { useMemo, useState } from "react";

type MovieState = "none" | "unseen" | "meh" | "liked" | "favorite";

type Movie = {
  id: number;
  title: string;
  year: number;
  genre: string;
  poster: string;
};

const stateCycle: MovieState[] = ["none", "unseen", "meh", "liked", "favorite"];

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

const duelSeed: [Movie, Movie][] = [
  [moviesSeed[1], moviesSeed[8]],
  [moviesSeed[0], moviesSeed[10]],
  [moviesSeed[3], moviesSeed[5]],
  [moviesSeed[2], moviesSeed[6]],
  [moviesSeed[7], moviesSeed[9]],
];

const stateMeta: Record<MovieState, { label: string; className: string }> = {
  none: { label: "Non classé", className: "state-none" },
  unseen: { label: "✕ Pas vu", className: "state-unseen" },
  meh: { label: "↓ Hors course", className: "state-meh" },
  liked: { label: "↑ J'ai aimé", className: "state-liked" },
  favorite: { label: "↑↑ Coup de cœur", className: "state-favorite" },
};

function nextState(current: MovieState): MovieState {
  const i = stateCycle.indexOf(current);
  return stateCycle[(i + 1) % stateCycle.length];
}

function scoreForState(state: MovieState): number {
  switch (state) {
    case "favorite":
      return 4;
    case "liked":
      return 3;
    case "meh":
      return 2;
    case "none":
      return 1;
    case "unseen":
      return 0;
    default:
      return 0;
  }
}

export default function HomePage() {
  const [screen, setScreen] = useState<"welcome" | "triage" | "duels" | "ranking">("welcome");
  const [alias, setAlias] = useState("");
  const [movieStates, setMovieStates] = useState<Record<number, MovieState>>(
    Object.fromEntries(moviesSeed.map((movie) => [movie.id, "none"])) as Record<number, MovieState>
  );
  const [duelIndex, setDuelIndex] = useState(0);
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
      .sort((a, b) => {
        const scoreDiff = scoreForState(movieStates[b.id]) - scoreForState(movieStates[a.id]);
        if (scoreDiff !== 0) return scoreDiff;
        return a.title.localeCompare(b.title, "fr");
      })
      .slice(0, 8);
  }, [movieStates]);

  const duelPair = duelSeed[Math.min(duelIndex, duelSeed.length - 1)];

  function chooseState(movieId: number) {
    setMovieStates((prev) => ({ ...prev, [movieId]: nextState(prev[movieId]) }));
  }

  function resolveDuel() {
    setDuelsResolved((n) => n + 1);
    setDuelIndex((i) => Math.min(i + 1, duelSeed.length - 1));
  }

  function skipDuel() {
    setDuelsSkipped((n) => n + 1);
    setDuelIndex((i) => Math.min(i + 1, duelSeed.length - 1));
  }

  return (
    <main className="app-shell">
      {screen === "welcome" && (
        <section className="screen screen-center">
          <div className="hero-icon">🎬</div>
          <h1>Classement familial de films</h1>
          <p className="lead">
            Une base mobile-first pour trier rapidement des films, puis les départager en duel.
          </p>

          <div className="card">
            <h2>Bienvenue</h2>
            <label className="label" htmlFor="alias">Nom ou pseudo</label>
            <input
              id="alias"
              className="input"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="Ex. Nico, Timmie, Frère 1"
            />

            <div className="two-col-grid small-cards">
              <div className="mini-card">
                <strong>Phase 1</strong>
                <span>Tri rapide</span>
              </div>
              <div className="mini-card">
                <strong>Phase 2</strong>
                <span>Duels</span>
              </div>
            </div>

            <button
              className="button button-primary"
              onClick={() => alias.trim() && setScreen("triage")}
            >
              Commencer
            </button>
          </div>
        </section>
      )}

      {screen === "triage" && (
        <section className="screen">
          <div className="sticky-header">
            <div className="header-row">
              <div>
                <div className="muted">Connecté comme</div>
                <strong>{alias || "Invité"}</strong>
              </div>
              <span className="pill pill-dark">Phase 1</span>
            </div>
            <div className="progress-track">
              <div className="progress-bar" style={{ width: `${progress}%` }} />
            </div>
            <div className="muted top-gap">{stats.triaged} films triés sur {moviesSeed.length}</div>
          </div>

          <div className="card compact-card">
            <strong>Tapotez pour faire défiler l’état</strong>
            <div className="legend-wrap top-gap">
              <span className="legend-pill">✕ Pas vu</span>
              <span className="legend-pill">↓ Hors course</span>
              <span className="legend-pill">↑ J&apos;ai aimé</span>
              <span className="legend-pill">↑↑ Coup de cœur</span>
              <span className="legend-pill">↺ Retour</span>
            </div>
          </div>

          <div className="movie-grid">
            {moviesSeed.map((movie) => (
              <button
                key={movie.id}
                className={`movie-tile ${stateMeta[movieStates[movie.id]].className}`}
                onClick={() => chooseState(movie.id)}
              >
                <div className="poster-box">{movie.poster}</div>
                <div className="movie-title">{movie.title}</div>
                <div className="movie-subtitle">{movie.year} · {movie.genre}</div>
                <div className="tile-footer">
                  <span className="state-badge">{stateMeta[movieStates[movie.id]].label}</span>
                </div>
              </button>
            ))}
          </div>

          <div className="two-col-grid">
            <div className="card stat-card">
              <div className="muted">Coups de cœur</div>
              <div className="big-number">{stats.favorite}</div>
            </div>
            <div className="card stat-card">
              <div className="muted">Pas vus</div>
              <div className="big-number">{stats.unseen}</div>
            </div>
          </div>

          <button className="button button-primary" onClick={() => setScreen("duels")}>Passer aux duels</button>
        </section>
      )}

      {screen === "duels" && (
        <section className="screen">
          <div className="sticky-header">
            <div className="header-row">
              <div>
                <div className="muted">Phase 2</div>
                <strong>Duels de départage</strong>
              </div>
              <span className="pill pill-dark">{duelsResolved} tranchés</span>
            </div>

            <div className="three-col-grid top-gap">
              <div className="card tiny-stat"><div className="muted">Fav.</div><strong>{stats.favorite}</strong></div>
              <div className="card tiny-stat"><div className="muted">Aimés</div><strong>{stats.liked}</strong></div>
              <div className="card tiny-stat"><div className="muted">Passés</div><strong>{duelsSkipped}</strong></div>
            </div>
          </div>

          <div className="card duel-card">
            <div className="duel-poster">{duelPair[0].poster}</div>
            <h2>{duelPair[0].title}</h2>
            <div className="muted">{duelPair[0].year} · {duelPair[0].genre}</div>
            <button className="button button-primary top-gap" onClick={resolveDuel}>Je choisis ce film</button>
          </div>

          <div className="duel-separator">OU</div>

          <div className="card duel-card">
            <div className="duel-poster">{duelPair[1].poster}</div>
            <h2>{duelPair[1].title}</h2>
            <div className="muted">{duelPair[1].year} · {duelPair[1].genre}</div>
            <button className="button button-primary top-gap" onClick={resolveDuel}>Je choisis ce film</button>
          </div>

          <button className="button button-secondary" onClick={skipDuel}>Passer ce duel</button>
          <button className="button button-ghost" onClick={() => setScreen("ranking")}>Voir mon classement</button>
        </section>
      )}

      {screen === "ranking" && (
        <section className="screen">
          <div className="header-row top-gap-small">
            <div>
              <div className="muted">Résultats</div>
              <h1 className="ranking-title">Top provisoire de {alias}</h1>
            </div>
            <div className="trophy">🏆</div>
          </div>

          <div className="card">
            <h2>Aperçu du classement</h2>
            <div className="ranking-list top-gap">
              {rankingPreview.map((movie, index) => (
                <div key={movie.id} className="ranking-row">
                  <div className="rank-number">{index + 1}</div>
                  <div className="rank-poster">{movie.poster}</div>
                  <div className="rank-text">
                    <div className="movie-title single-line">{movie.title}</div>
                    <div className="movie-subtitle">{movie.year} · {movie.genre}</div>
                  </div>
                  <span className="state-badge">{stateMeta[movieStates[movie.id]].label}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="two-col-grid">
            <button className="button button-primary" onClick={() => setScreen("duels")}>Continuer</button>
            <button className="button button-secondary" onClick={() => setScreen("triage")}>Ajuster le tri</button>
          </div>
        </section>
      )}
    </main>
  );
}
