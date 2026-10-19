// client-side import of spotify liked songs from an exportify csv. each row
// is searched against the catalog and the best confident match is liked.
// everything runs through the regular api client, already-liked tracks are
// skipped, and stopping is safe — a rerun picks up where the last one stopped.
import { create } from "zustand";
import { api, ApiError } from "@/shared/api";
import {
  parseSpotifyCsv,
  scoreMatch,
  isConfidentMatch,
  looksLikeStub,
  type SpotifyCsvRow,
  type MatchCandidate,
} from "../services/import/spotifyCsv";

export interface CsvImportProgress {
  total: number;
  done: number;
  liked: number;
  skipped: number;
  failed: number;
  current: string;
}

type CsvImportPhase = "idle" | "ready" | "running" | "done";

interface SpotifyCsvImportState {
  phase: CsvImportPhase;
  rows: SpotifyCsvRow[];
  fileName: string;
  progress: CsvImportProgress;
  stopRequested: boolean;
  loadFile: (file: File) => Promise<void>;
  run: () => Promise<void>;
  stop: () => void;
  reset: () => void;
}

// two workers with a small floor between request starts keeps the run quick
// without hammering the api
const WORKER_COUNT = 2;
const PACE_MS = 450;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchLikedIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await api.listLikedTracks(100, cursor);
    for (const item of page.items ?? []) {
      if (item.track?.id) ids.add(item.track.id);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return ids;
}

async function withRetry<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await action();
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      const transient = status === 429 || status >= 500 || status === 0;
      if (transient && attempt < 4) {
        await sleep(4000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

function searchCandidates(row: SpotifyCsvRow): Promise<MatchCandidate[]> {
  const primaryArtist = row.artist ? row.artist.split(/[,;]/)[0].trim() : "";
  const query = primaryArtist ? `${primaryArtist} ${row.title}` : row.title;
  return api.search(query, "track").then((res) =>
    ((res.items ?? []) as unknown as Record<string, unknown>[])
      .filter(
        (item) =>
          typeof item.id === "string" &&
          typeof item.title === "string" &&
          item.artists !== undefined,
      )
      .map((item) => item as unknown as MatchCandidate)
      .filter((item) => !looksLikeStub(item)),
  );
}

function bestMatch(row: SpotifyCsvRow, candidates: MatchCandidate[]): { candidate: MatchCandidate | null; confident: boolean } {
  let best: { candidate: MatchCandidate | null; score: ReturnType<typeof scoreMatch> } = {
    candidate: null,
    score: { overall: 0, title: 0, artist: 0 },
  };
  for (const candidate of candidates) {
    const score = scoreMatch(row, candidate);
    if (score.overall > best.score.overall) {
      best = { candidate, score };
    }
  }
  return { candidate: best.candidate, confident: Boolean(best.candidate) && isConfidentMatch(best.score, Boolean(row.artist)) };
}

export const useSpotifyCsvImportStore = create<SpotifyCsvImportState>((set, get) => ({
  phase: "idle",
  rows: [],
  fileName: "",
  progress: { total: 0, done: 0, liked: 0, skipped: 0, failed: 0, current: "" },
  stopRequested: false,

  loadFile: async (file) => {
    const text = await file.text();
    const rows = parseSpotifyCsv(text);
    if (rows.length === 0) {
      set({ phase: "idle", rows: [], fileName: file.name });
      return;
    }
    set({
      phase: "ready",
      rows,
      fileName: file.name,
      progress: { total: rows.length, done: 0, liked: 0, skipped: 0, failed: 0, current: "" },
    });
  },

  stop: () => set({ stopRequested: true }),

  reset: () =>
    set({
      phase: "idle",
      rows: [],
      fileName: "",
      stopRequested: false,
      progress: { total: 0, done: 0, liked: 0, skipped: 0, failed: 0, current: "" },
    }),

  run: async () => {
    const { rows, phase } = get();
    if (phase !== "ready" || rows.length === 0) return;
    set({ phase: "running", stopRequested: false });

    const progress = { ...get().progress };

    try {
      let likedIds: Set<string>;
      try {
        likedIds = await fetchLikedIds();
      } catch {
        likedIds = new Set();
      }

      let nextIndex = 0;
      const worker = async () => {
        while (!get().stopRequested) {
          const index = nextIndex++;
          if (index >= rows.length) break;
          const row = rows[index];
          const startedAt = Date.now();

          progress.current = `${row.artist ? `${row.artist} — ` : ""}${row.title}`;

          try {
            const { candidate, confident } = bestMatch(row, await searchCandidates(row));
            if (candidate && confident) {
              if (likedIds.has(candidate.id)) {
                progress.skipped++;
              } else {
                await withRetry(() => api.likeTrack(candidate.id));
                likedIds.add(candidate.id);
                progress.liked++;
              }
            } else {
              progress.failed++;
            }
          } catch {
            progress.failed++;
          }

          progress.done++;
          set({ progress: { ...progress } });

          const wait = PACE_MS - (Date.now() - startedAt);
          if (wait > 0) await sleep(wait);
        }
      };

      await Promise.all(Array.from({ length: WORKER_COUNT }, () => worker()));
    } finally {
      set({ phase: "done" });
    }
  },
}));
