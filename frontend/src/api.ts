import type {
  Analysis, DatasetDetail, DatasetMeta, Phase, Review,
} from "./types.js";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body?.detail) detail = typeof body.detail === "string"
        ? body.detail : JSON.stringify(body.detail);
    } catch { /* ignore */ }
    throw new Error(`${res.status}: ${detail}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  listDatasets: () => req<DatasetMeta[]>("/api/datasets"),

  importDataset: (raw: string | ArrayBuffer) =>
    req<{ id: number; name: string }>("/api/datasets/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw as BodyInit,
    }),

  createDemo: () =>
    req<{ id: number; name: string }>("/api/datasets/demo",
      jsonInit("POST")),

  getDetail: (id: number) =>
    req<DatasetDetail>(`/api/datasets/${id}`),

  getAnalysis: (id: number) =>
    req<Analysis>(`/api/datasets/${id}/analysis`),

  deleteDataset: (id: number) =>
    req<{ status: string }>(`/api/datasets/${id}`, { method: "DELETE" }),

  createPick: (ds: number, data: {
    station: string; phase: Phase; time: number;
    uncertainty: number; weight?: number; source?: string;
  }) => req<{ id: number }>(`/api/datasets/${ds}/picks`, jsonInit("POST", data)),

  patchPick: (ds: number, id: number, data: Partial<{
    time: number; uncertainty: number; weight: number; phase: Phase;
  }>) => req<{ status: string }>(
    `/api/datasets/${ds}/picks/${id}`, jsonInit("PATCH", data)),

  rejectPick: (ds: number, id: number) =>
    req<{ status: string }>(
      `/api/datasets/${ds}/picks/${id}/reject`, jsonInit("POST")),

  restorePick: (ds: number, id: number) =>
    req<{ status: string }>(
      `/api/datasets/${ds}/picks/${id}/restore`, jsonInit("POST")),

  deletePick: (ds: number, id: number) =>
    req<{ status: string }>(
      `/api/datasets/${ds}/picks/${id}`, { method: "DELETE" }),

  createReview: (ds: number, data: {
    station: string; phase: Phase; time: number; uncertainty: number;
    method: "manual" | "consensus"; pick_id?: number | null;
    cluster_id?: number | null; note?: string;
  }) => req<Review>(`/api/datasets/${ds}/reviews`, jsonInit("POST", data)),

  undoReview: (ds: number, id: number) =>
    req<{ status: string }>(
      `/api/datasets/${ds}/reviews/${id}`, { method: "DELETE" }),

  exportUrl: (id: number) => `/api/datasets/${id}/export`,
};
