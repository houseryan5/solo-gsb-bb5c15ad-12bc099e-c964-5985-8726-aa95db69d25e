"""Persistence helpers for datasets / traces / picks / reviews."""
from __future__ import annotations

import json
from typing import Any

from .database import db
from .importer import ImportedDataset
from .time_utils import ms_to_iso, now_ms


def create_dataset(imp: ImportedDataset) -> int:
    start = min(t.start_time_ms for t in imp.traces)
    end = max(t.end_time_ms for t in imp.traces)
    stamp = ms_to_iso(now_ms())
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO datasets (name, created_at, start_time, end_time) "
            "VALUES (?, ?, ?, ?)",
            (imp.name, stamp, start, end),
        )
        ds_id = cur.lastrowid
        conn.executemany(
            "INSERT INTO traces (dataset_id, station, network, channel, "
            "start_time, sample_rate, samples) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [(ds_id, t.station, t.network, t.channel, t.start_time_ms,
              t.sample_rate, t.samples_json) for t in imp.traces],
        )
        if imp.picks:
            conn.executemany(
                "INSERT INTO picks (dataset_id, station, phase, time, "
                "uncertainty, source, weight, status, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', ?)",
                [(ds_id, p.station, p.phase, p.time_ms, p.uncertainty_ms,
                  p.source, p.weight, stamp) for p in imp.picks],
            )
    return ds_id


def list_datasets() -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            """
            SELECT d.id, d.name, d.created_at, d.start_time, d.end_time,
                   (SELECT COUNT(*) FROM traces t WHERE t.dataset_id = d.id) AS trace_count,
                   (SELECT COUNT(*) FROM picks p WHERE p.dataset_id = d.id) AS pick_count
            FROM datasets d ORDER BY d.id DESC
            """
        ).fetchall()
    return [dict(r) for r in rows]


def get_dataset_meta(ds_id: int) -> dict[str, Any] | None:
    with db() as conn:
        r = conn.execute("SELECT * FROM datasets WHERE id = ?", (ds_id,)).fetchone()
    return dict(r) if r else None


def get_traces(ds_id: int) -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            "SELECT id, station, network, channel, start_time, sample_rate, samples "
            "FROM traces WHERE dataset_id = ? ORDER BY station, channel",
            (ds_id,),
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["samples"] = json.loads(d["samples"])
        d["n_samples"] = len(d["samples"])
        d["end_time"] = d["start_time"] + int(
            round((d["n_samples"] - 1) / d["sample_rate"] * 1000.0)
        )
        out.append(d)
    return out


def get_picks(ds_id: int) -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM picks WHERE dataset_id = ? ORDER BY time", (ds_id,)
        ).fetchall()
    return [dict(r) for r in rows]


def get_pick(ds_id: int, pick_id: int) -> dict[str, Any] | None:
    with db() as conn:
        r = conn.execute(
            "SELECT * FROM picks WHERE id = ? AND dataset_id = ?",
            (pick_id, ds_id),
        ).fetchone()
    return dict(r) if r else None


def create_pick(ds_id: int, station: str, phase: str, time_ms: int,
                uncertainty_ms: int, source: str = "analyst",
                weight: float = 1.0) -> dict[str, Any]:
    stamp = ms_to_iso(now_ms())
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO picks (dataset_id, station, phase, time, uncertainty, "
            "source, weight, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', ?)",
            (ds_id, station, phase, time_ms, uncertainty_ms, source, weight, stamp),
        )
        pick_id = cur.lastrowid
        r = conn.execute("SELECT * FROM picks WHERE id = ?", (pick_id,)).fetchone()
    return dict(r)


def update_pick(ds_id: int, pick_id: int, *, time_ms: int | None = None,
                uncertainty_ms: int | None = None, weight: float | None = None,
                phase: str | None = None) -> None:
    fields, values = [], []
    if time_ms is not None:
        fields.append("time = ?"); values.append(time_ms)
    if uncertainty_ms is not None:
        fields.append("uncertainty = ?"); values.append(uncertainty_ms)
    if weight is not None:
        fields.append("weight = ?"); values.append(weight)
    if phase is not None:
        fields.append("phase = ?"); values.append(phase)
    if not fields:
        return
    values.extend([ds_id, pick_id])
    with db() as conn:
        conn.execute(
            f"UPDATE picks SET {', '.join(fields)} "
            "WHERE dataset_id = ? AND id = ?", values,
        )


def set_pick_status(ds_id: int, pick_id: int, status: str) -> None:
    with db() as conn:
        conn.execute(
            "UPDATE picks SET status = ? WHERE dataset_id = ? AND id = ?",
            (status, ds_id, pick_id),
        )


def delete_pick(ds_id: int, pick_id: int) -> None:
    with db() as conn:
        conn.execute(
            "DELETE FROM picks WHERE dataset_id = ? AND id = ?",
            (ds_id, pick_id),
        )


def get_reviews(ds_id: int) -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM reviews WHERE dataset_id = ? ORDER BY station, phase, id",
            (ds_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def create_review(ds_id: int, station: str, phase: str, time_ms: int,
                  uncertainty_ms: int, method: str, pick_id: int | None = None,
                  cluster_id: int | None = None, note: str = "") -> dict[str, Any]:
    stamp = ms_to_iso(now_ms())
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO reviews (dataset_id, station, phase, time, uncertainty, "
            "method, pick_id, cluster_id, note, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (ds_id, station, phase, time_ms, uncertainty_ms, method,
             pick_id, cluster_id, note, stamp),
        )
        rid = cur.lastrowid
        r = conn.execute("SELECT * FROM reviews WHERE id = ?", (rid,)).fetchone()
    return dict(r)


def delete_review(ds_id: int, review_id: int) -> None:
    with db() as conn:
        conn.execute(
            "DELETE FROM reviews WHERE dataset_id = ? AND id = ?",
            (ds_id, review_id),
        )


def delete_dataset(ds_id: int) -> None:
    with db() as conn:
        conn.execute("DELETE FROM datasets WHERE id = ?", (ds_id,))
