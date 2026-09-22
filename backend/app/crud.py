"""Persistence helpers for datasets / traces / picks / reviews."""
from __future__ import annotations

import json
from typing import Any

from .database import db
from .importer import ImportedDataset
from .time_utils import ms_to_iso, now_ms


class ConflictUndoStale(Exception):
    """An undo references a resolution that is not the active last one."""


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


# ------------------------------------------------- conflict resolutions -----
def create_conflict_resolution(
    ds_id: int,
    groups: list[dict[str, Any]],
    pick_ids: list[int],
) -> dict[str, Any]:
    """Reject the given outlier-cluster picks in one transaction.

    ``groups`` are the (station, phase) groups the user selected; ``pick_ids``
    are the picks currently classified as outliers of those groups.  Only
    picks still in ``candidate`` status are changed, but every targeted pick is
    snapshotted so a single undo can restore the original state.
    """
    stamp = ms_to_iso(now_ms())
    groups_json = json.dumps(
        [{"station": g["station"], "phase": g["phase"]} for g in groups],
        ensure_ascii=False,
    )
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO conflict_resolutions (dataset_id, groups_json, created_at) "
            "VALUES (?, ?, ?)",
            (ds_id, groups_json, stamp),
        )
        res_id = cur.lastrowid
        changes: list[dict[str, Any]] = []
        if pick_ids:
            placeholders = ",".join("?" for _ in pick_ids)
            rows = conn.execute(
                f"SELECT id, station, phase, time, uncertainty, weight, "
                f"source, status FROM picks WHERE dataset_id = ? AND id IN "
                f"({placeholders}) ORDER BY time",
                (ds_id, *pick_ids),
            ).fetchall()
            item_rows = []
            for r in rows:
                old_status = r["status"]
                item_rows.append((res_id, r["id"], old_status, "rejected"))
                changes.append({
                    "id": r["id"], "station": r["station"], "phase": r["phase"],
                    "time": r["time"], "uncertainty": r["uncertainty"],
                    "weight": r["weight"], "source": r["source"],
                    "from_status": old_status, "to_status": "rejected",
                })
            conn.executemany(
                "INSERT INTO conflict_resolution_items "
                "(resolution_id, pick_id, from_status, to_status) "
                "VALUES (?, ?, ?, ?)",
                item_rows,
            )
            conn.execute(
                f"UPDATE picks SET status = 'rejected' "
                f"WHERE dataset_id = ? AND id IN ({placeholders}) "
                f"AND status = 'candidate'",
                (ds_id, *pick_ids),
            )
    return {
        "id": res_id,
        "created_at": stamp,
        "groups": [{"station": g["station"], "phase": g["phase"]} for g in groups],
        "changes": changes,
    }


def get_last_conflict_resolution(ds_id: int) -> dict[str, Any] | None:
    """Return the most recent resolution (undone or not) with its item count."""
    with db() as conn:
        r = conn.execute(
            "SELECT cr.id, cr.groups_json, cr.created_at, cr.undone_at, "
            "(SELECT COUNT(*) FROM conflict_resolution_items i "
            " WHERE i.resolution_id = cr.id) AS rejected_count "
            "FROM conflict_resolutions cr WHERE cr.dataset_id = ? "
            "ORDER BY cr.id DESC LIMIT 1",
            (ds_id,),
        ).fetchone()
    if r is None:
        return None
    out = dict(r)
    out["groups"] = json.loads(out.pop("groups_json") or "[]")
    return out


def undo_conflict_resolution(ds_id: int, resolution_id: int) -> dict[str, Any]:
    """Restore the original status of every pick touched by one resolution.

    Only the latest, not-yet-undone resolution can be undone.  Picks that no
    longer exist (deleted afterwards) are reported as ``missing`` and their
    snapshot rows stay as historical record.
    """
    with db() as conn:
        meta = conn.execute(
            "SELECT id, groups_json, undone_at FROM conflict_resolutions "
            "WHERE dataset_id = ? ORDER BY id DESC LIMIT 1",
            (ds_id,),
        ).fetchone()
        if meta is None or meta["id"] != resolution_id:
            raise ConflictUndoStale("没有可撤销的冲突处置记录")
        if meta["undone_at"] is not None:
            raise ConflictUndoStale("该冲突处置已撤销，无法重复撤销")
        groups = json.loads(meta["groups_json"] or "[]")

        stamp = ms_to_iso(now_ms())
        conn.execute(
            "UPDATE conflict_resolutions SET undone_at = ? WHERE id = ?",
            (stamp, resolution_id),
        )
        items = conn.execute(
            "SELECT pick_id, from_status, to_status "
            "FROM conflict_resolution_items WHERE resolution_id = ?",
            (resolution_id,),
        ).fetchall()

        restored: list[dict[str, Any]] = []
        missing: list[int] = []
        for it in items:
            row = conn.execute(
                "SELECT id, station, phase, time, uncertainty, weight, source, "
                "status FROM picks WHERE dataset_id = ? AND id = ?",
                (ds_id, it["pick_id"]),
            ).fetchone()
            if row is None:
                missing.append(it["pick_id"])
                continue
            before_status = row["status"]
            conn.execute(
                "UPDATE picks SET status = ? WHERE dataset_id = ? AND id = ?",
                (it["from_status"], ds_id, row["id"]),
            )
            restored.append({
                "id": row["id"], "station": row["station"], "phase": row["phase"],
                "time": row["time"], "uncertainty": row["uncertainty"],
                "weight": row["weight"], "source": row["source"],
                "from_status": before_status, "to_status": it["from_status"],
            })
    return {
        "id": resolution_id,
        "undone_at": stamp,
        "groups": groups,
        "restored": restored,
        "missing_pick_ids": missing,
    }
