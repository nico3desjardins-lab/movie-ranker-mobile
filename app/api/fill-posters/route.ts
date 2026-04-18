import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

type DbMovie = {
  id: number | string;
  title: string | null;
  title_fr: string | null;
  year: number | null;
  poster_url: string | null;
  tmdb_id?: number | null;
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

function chooseBestMatch(results: TmdbMovie[], movie: DbMovie): TmdbMovie | null {
  if (!results.length) return null;

  const wantedTitle = normalize(movie.title_fr || movie.title || "");
  const wantedYear = movie.year ?? null;

  const scored = results.map((result) => {
    const resultTitle = normalize(result.title || result.original_title || "");
    const resultYear = getYearFromDate(result.release_date);

    let score = 0;

    if (resultTitle === wantedTitle) score += 100;
    else if (resultTitle.includes(wantedTitle) || wantedTitle.includes(resultTitle)) score += 40;

    if (wantedYear && resultYear === wantedYear) score += 50;
    else if (
      wantedYear &&
      resultYear &&
      Math.abs(resultYear - wantedYear) === 1
    ) {
      score += 20;
    }

    if (result.poster_path) score += 10;

    return { result, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].result : results[0];
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
  year?: number | null
): Promise<TmdbMovie[]> {
  const params = new URLSearchParams({
    query: title,
    include_adult: "false",
    language: "fr-CA",
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

    const limitParam = Number(request.nextUrl.searchParams.get("limit") || "20");
    const limit = Math.max(1, Math.min(limitParam, 50));

    const dryRun = request.nextUrl.searchParams.get("dryRun") === "1";

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { secureBaseUrl, posterSize } = await fetchTmdbConfig(tmdbBearerToken);

    const { data, error } = await supabase
      .from("movies_catalog")
      .select("id, title, title_fr, year, poster_url, tmdb_id")
      .or("poster_url.is.null,poster_url.eq.")
      .order("id", { ascending: true })
      .limit(limit);

    if (error) {
      throw new Error(`Erreur lecture Supabase: ${error.message}`);
    }

    const movies = (data || []) as DbMovie[];

    const results: Array<{
      id: number | string;
      title: string;
      status: "updated" | "not_found" | "dry_run" | "error";
      poster_url?: string;
      tmdb_id?: number;
      message?: string;
    }> = [];

    let updated = 0;
    let notFound = 0;
    let failed = 0;

    for (const movie of movies) {
      const titleToSearch = (movie.title_fr || movie.title || "").trim();

      if (!titleToSearch) {
        results.push({
          id: movie.id,
          title: "(sans titre)",
          status: "error",
          message: "Titre manquant",
        });
        failed += 1;
        continue;
      }

      try {
        const searchResults = await searchTmdbMovie(
          tmdbBearerToken,
          titleToSearch,
          movie.year
        );

        const bestMatch = chooseBestMatch(searchResults, movie);

        if (!bestMatch || !bestMatch.poster_path) {
          results.push({
            id: movie.id,
            title: titleToSearch,
            status: "not_found",
            message: "Aucune affiche trouvée",
          });
          notFound += 1;
          continue;
        }

        const posterUrl = `${secureBaseUrl}${posterSize}${bestMatch.poster_path}`;

        if (dryRun) {
          results.push({
            id: movie.id,
            title: titleToSearch,
            status: "dry_run",
            poster_url: posterUrl,
            tmdb_id: bestMatch.id,
          });
          continue;
        }

        const { error: updateError } = await supabase
          .from("movies_catalog")
          .update({
            poster_url: posterUrl,
            tmdb_id: bestMatch.id,
          })
          .eq("id", movie.id);

        if (updateError) {
          results.push({
            id: movie.id,
            title: titleToSearch,
            status: "error",
            message: updateError.message,
          });
          failed += 1;
          continue;
        }

        results.push({
          id: movie.id,
          title: titleToSearch,
          status: "updated",
          poster_url: posterUrl,
          tmdb_id: bestMatch.id,
        });
        updated += 1;

        await new Promise((resolve) => setTimeout(resolve, 250));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Erreur inconnue";
        results.push({
          id: movie.id,
          title: titleToSearch,
          status: "error",
          message,
        });
        failed += 1;
      }
    }

    return NextResponse.json({
      ok: true,
      dryRun,
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
