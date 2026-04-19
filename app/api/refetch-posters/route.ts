import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

type DbMovie = {
  id: number | string;
  title: string | null;
  title_fr: string | null;
  year: number | null;
  poster_url: string | null;
  poster_url_old?: string | null;
  tmdb_id?: number | null;
  tmdb_id_old?: number | null;
  poster_status?: string | null;
};

type TmdbMovie = {
  id: number;
  title?: string;
  original_title?: string;
  release_date?: string;
  poster_path?: string | null;
};

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variable d'environnement manquante: ${name}`);
  }
  return value;
}

function normalize(text: string | null | undefined): string {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getYearFromDate(date?: string): number | null {
  if (!date || date.length < 4) return null;
  const y = Number(date.slice(0, 4));
  return Number.isFinite(y) ? y : null;
}

function scoreMatch(result: TmdbMovie, wantedTitle: string, wantedYear: number | null) {
  const resultTitle = normalize(result.title || result.original_title || "");
  const resultYear = getYearFromDate(result.release_date);

  let score = 0;

  if (resultTitle === wantedTitle) {
    score += 120;
  } else if (
    resultTitle.startsWith(wantedTitle) ||
    wantedTitle.startsWith(resultTitle)
  ) {
    score += 70;
  } else if (
    resultTitle.includes(wantedTitle) ||
    wantedTitle.includes(resultTitle)
  ) {
    score += 35;
  }

  if (wantedYear && resultYear === wantedYear) {
    score += 60;
  } else if (wantedYear && resultYear && Math.abs(resultYear - wantedYear) === 1) {
    score += 15;
  }

  if (result.poster_path) {
    score += 10;
  }

  return {
    score,
    resultTitle,
    resultYear,
  };
}

function chooseBestStrictMatch(
  results: TmdbMovie[],
  title: string,
  year: number | null
): TmdbMovie | null {
  if (!results.length) return null;

  const wantedTitle = normalize(title);

  const scored = results.map((result) => {
    const meta = scoreMatch(result, wantedTitle, year);
    return {
      result,
      ...meta,
    };
  });

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) return null;

  const exactTitle = best.resultTitle === wantedTitle;
  const exactYear = year ? best.resultYear === year : false;

  if (exactTitle && exactYear && best.result.poster_path) {
    return best.result;
  }

  if (exactTitle && best.score >= 130 && best.result.poster_path) {
    return best.result;
  }

  if (exactYear && best.score >= 150 && best.result.poster_path) {
    return best.result;
  }

  if (best.score >= 185 && best.result.poster_path) {
    return best.result;
  }

  return null;
}

async function fetchTmdbConfig(tmdbBearerToken: string) {
  const response = await fetch("https://api.themoviedb.org/3/configuration", {
    headers: {
      Authorization: `Bearer ${tmdbBearerToken}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Erreur TMDB configuration: ${response.status}`);
  }

  const json = await response.json();

  const secureBaseUrl = json?.images?.secure_base_url;
  const posterSizes: string[] = json?.images?.poster_sizes || [];

  if (!secureBaseUrl || !posterSizes.length) {
    throw new Error("Configuration TMDB invalide");
  }

  const posterSize = posterSizes.includes("w500")
    ? "w500"
    : posterSizes[posterSizes.length - 1];

  return { secureBaseUrl, posterSize };
}

async function searchTmdbMovie(
  tmdbBearerToken: string,
  title: string,
  year?: number | null,
  language = "en-US"
): Promise<TmdbMovie[]> {
  const params = new URLSearchParams({
    query: title,
    include_adult: "false",
    language,
  });

  if (year) {
    params.set("year", String(year));
  }

  const response = await fetch(
    `https://api.themoviedb.org/3/search/movie?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${tmdbBearerToken}`,
        Accept: "application/json",
      },
      cache: "no-store",
    }
  );

  if (!response.ok) {
    throw new Error(`Erreur TMDB search: ${response.status}`);
  }

  const json = await response.json();
  return Array.isArray(json?.results) ? json.results : [];
}

async function findBestPoster(
  tmdbBearerToken: string,
  movie: DbMovie
): Promise<{ match: TmdbMovie | null; source: "title" | "title_fr" | "none" }> {
  const originalTitle = (movie.title || "").trim();
  const frenchTitle = (movie.title_fr || "").trim();
  const year = movie.year ?? null;

  if (originalTitle) {
    const originalResults = await searchTmdbMovie(
      tmdbBearerToken,
      originalTitle,
      year,
      "en-US"
    );

    const originalMatch = chooseBestStrictMatch(originalResults, originalTitle, year);
    if (originalMatch) {
      return { match: originalMatch, source: "title" };
    }
  }

  if (frenchTitle && frenchTitle !== originalTitle) {
    const frenchResults = await searchTmdbMovie(
      tmdbBearerToken,
      frenchTitle,
      year,
      "fr-CA"
    );

    const frenchMatch = chooseBestStrictMatch(frenchResults, frenchTitle, year);
    if (frenchMatch) {
      return { match: frenchMatch, source: "title_fr" };
    }
  }

  return { match: null, source: "none" };
}

export async function GET(request: NextRequest) {
  try {
    const secret = getEnv("POSTER_SYNC_SECRET");
    const tmdbBearerToken = getEnv("TMDB_BEARER_TOKEN");
    const supabaseUrl = getEnv("NEXT_PUBLIC_SUPABASE_URL");
    const serviceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

    const requestSecret = request.nextUrl.searchParams.get("secret");
    if (requestSecret !== secret) {
      return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
    }

    const dryRun = request.nextUrl.searchParams.get("dryRun") === "1";
    const force = request.nextUrl.searchParams.get("force") === "1";
    const limitParam = Number(request.nextUrl.searchParams.get("limit") || "20");
    const limit = Math.max(1, Math.min(limitParam, 50));

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { secureBaseUrl, posterSize } = await fetchTmdbConfig(tmdbBearerToken);

    let query = supabase
      .from("movies_catalog")
      .select(
        "id, title, title_fr, year, poster_url, poster_url_old, tmdb_id, tmdb_id_old, poster_status"
      )
      .order("id", { ascending: true })
      .limit(limit);

    if (!force) {
      query = query.in("poster_status", ["not_found", "review"]);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Erreur lecture Supabase: ${error.message}`);
    }

    const movies = (data || []) as DbMovie[];

    const results: Array<{
      id: number | string;
      title: string;
      status: "updated" | "not_found" | "dry_run" | "error";
      source?: "title" | "title_fr" | "none";
      poster_url?: string;
      tmdb_id?: number;
      message?: string;
    }> = [];

    let updated = 0;
    let notFound = 0;
    let failed = 0;

    for (const movie of movies) {
      const label = (movie.title || movie.title_fr || "").trim() || "(sans titre)";

      try {
        const { match, source } = await findBestPoster(tmdbBearerToken, movie);

        if (!match || !match.poster_path) {
          if (!dryRun) {
            await supabase
              .from("movies_catalog")
              .update({
                poster_status: "not_found",
              })
              .eq("id", movie.id);
          }

          results.push({
            id: movie.id,
            title: label,
            status: "not_found",
            source,
            message: "Aucun match strict trouvé",
          });
          notFound += 1;
          continue;
        }

        const posterUrl = `${secureBaseUrl}${posterSize}${match.poster_path}`;

        if (dryRun) {
          results.push({
            id: movie.id,
            title: label,
            status: "dry_run",
            source,
            poster_url: posterUrl,
            tmdb_id: match.id,
          });
          continue;
        }

        const { error: updateError } = await supabase
          .from("movies_catalog")
          .update({
            poster_url: posterUrl,
            tmdb_id: match.id,
            poster_status: "found",
          })
          .eq("id", movie.id);

        if (updateError) {
          results.push({
            id: movie.id,
            title: label,
            status: "error",
            source,
            message: updateError.message,
          });
          failed += 1;
          continue;
        }

        results.push({
          id: movie.id,
          title: label,
          status: "updated",
          source,
          poster_url: posterUrl,
          tmdb_id: match.id,
        });
        updated += 1;

        await new Promise((resolve) => setTimeout(resolve, 250));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Erreur inconnue";
        results.push({
          id: movie.id,
          title: label,
          status: "error",
          source: "none",
          message,
        });
        failed += 1;
      }
    }

    return NextResponse.json({
      ok: true,
      dryRun,
      force,
      processed: movies.length,
      updated,
      notFound,
      failed,
      results,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur inconnue";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
