"""Bulk "conflict disposition" workflow.

For every station/phase group whose overlap clustering yields more than one
non-overlapping cluster, the reviewer can reject **all outlier-cluster
picks of several groups at once**.  Each bulk operation:

* re-runs the clustering inside a single SQLite transaction so the
  primary/outlier decision is always taken against the freshest data;
* records the batch (``conflict_actions``) and every individual status change
  (``conflict_action_changes``) so the *one* most recent batch can be undone,
  restoring the exact previous status of every pick;
* returns each individual change for immediate UI feedback.

Only one batch per dataset is undoable: issuing a new batch supersedes the
previous one (it stays in the table, marked ``superseded``).
"""
from __future__ import annotations

from typing import Any, Sequence

from .consensus import analyze
from .database import db
from .time_utils import ms_to_iso, now_ms


class ConflictError(Exception):
    """Client-facing conflict-workflow error (mapped to HTTP 422/404)."""

    def __init__(self, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.status_code = status_code


def _analysis_index(picks: Sequence[dict[str, Any]]) -> dict[tuple[str, str], dict[str, Any]]:
    result = analyze(picks)
    return {(g["station"], g["phase"]): g for g in result["groups"]}


def reject_outlier_clusters(
    ds_id: int, selections: Sequence[dict[str, str]],
) -> dict[str, Any]:
    """Reject every outlier-cluster pick of the selected groups.

    The whole operation — clustering check, bookkeeping rows and status
    updates — runs in one transaction; any error rolls everything back.
    """
    requested: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for sel in selections:
        key = (sel["station"].strip(), sel["phase"])
        if key not in seen:
            seen.add(key)
            requested.append(key)

    stamp = ms_to_iso(now_ms())
    with db() as conn:
        pick_rows = [dict(r) for r in conn.execute(
            "SELECT * FROM picks WHERE dataset_id = ? ORDER BY time", (ds_id,)
        ).fetchall()]
        groups = _analysis_index(pick_rows)

        group_payload: list[dict[str, Any]] = []
        skipped: list[dict[str, str]] = []
        outlier_ids: list[int] = []
        per_group_ids: dict[tuple[str, str], list[int]] = {}

        for station, phase in requested:
            g = groups.get((station, phase))
            if g is None or not g["conflict"]:
                # Group vanished (all picks rejected/deleted) or its clusters
                # merged in the meantime — nothing to do for it.
                skipped.append({
                    "station": station, "phase": phase,
                    "reason": "not_conflicted",
                })
                continue

            primary = next(c for c in g["clusters"] if c["primary"])
            outliers = [c for c in g["clusters"] if not c["primary"]]
            ids = [pid for c in outliers for pid in c["pick_ids"]]
            per_group_ids[(station, phase)] = ids
            outlier_ids.extend(ids)

            def _cluster_summary(c: dict[str, Any]) -> dict[str, Any]:
                return {
                    "cluster_id": c["cluster_id"],
                    "size": c["size"],
                    "sum_weight": c["sum_weight"],
                    "consensus_time": c["consensus_time"],
                    "consensus_time_iso": ms_to_iso(c["consensus_time"]),
                    "consensus_uncertainty": c["consensus_uncertainty"],
                    "pick_ids": c["pick_ids"],
                }

            group_payload.append({
                "station": station,
                "phase": phase,
                "primary_cluster": _cluster_summary(primary),
                "outlier_clusters": [_cluster_summary(c) for c in outliers],
                "rejected_pick_ids": ids,
            })

        if not outlier_ids:
            raise ConflictError("所选分组当前没有可拒绝的离群簇拾取")

        picks_by_id = {p["id"]: p for p in pick_rows}

        # The previous active batch can no longer be undone once a new batch
        # is recorded.
        conn.execute(
            "UPDATE conflict_actions SET status = 'superseded' "
            "WHERE dataset_id = ? AND status = 'active'",
            (ds_id,),
        )
        cur = conn.execute(
            "INSERT INTO conflict_actions (dataset_id, kind, status, "
            "group_count, change_count, created_at) "
            "VALUES (?, 'reject_outliers', 'active', ?, ?, ?)",
            (ds_id, len(group_payload), len(outlier_ids), stamp),
        )
        action_id = cur.lastrowid
        conn.executemany(
            "INSERT INTO conflict_action_changes (action_id, pick_id, "
            "station, phase, previous_status) VALUES (?, ?, ?, ?, 'candidate')",
            [(action_id, pid, station, phase)
             for (station, phase), ids in per_group_ids.items() for pid in ids],
        )

        # Guard with status = 'candidate': never overwrite picks that were
        # rejected/deleted by a concurrent single-pick action.
        conn.executemany(
            "UPDATE picks SET status = 'rejected' "
            "WHERE dataset_id = ? AND id = ? AND status = 'candidate'",
            [(ds_id, pid) for pid in outlier_ids],
        )

        changes: list[dict[str, Any]] = []
        for pid in outlier_ids:
            p = picks_by_id[pid]
            changes.append(_change_payload(pid, p, previous="candidate",
                                           current="rejected"))

        action = {
            "id": action_id,
            "group_count": len(group_payload),
            "change_count": len(changes),
            "created_at": stamp,
            "status": "active",
        }
    return {"action": action, "groups": group_payload,
            "changes": changes, "skipped": skipped}


def undo_last_action(ds_id: int) -> dict[str, Any]:
    """Restore the picks of the most recent active batch (single undo)."""
    stamp = ms_to_iso(now_ms())
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM conflict_actions WHERE dataset_id = ? "
            "AND status = 'active' ORDER BY id DESC LIMIT 1",
            (ds_id,),
        ).fetchone()
        if row is None:
            raise ConflictError("没有可撤销的冲突处置", status_code=404)
        action = dict(row)

        change_rows = [dict(r) for r in conn.execute(
            "SELECT * FROM conflict_action_changes WHERE action_id = ? ORDER BY id",
            (action["id"],),
        ).fetchall()]

        restored: list[dict[str, Any]] = []
        missing: list[int] = []
        for ch in change_rows:
            pid = ch["pick_id"]
            cur = conn.execute(
                "UPDATE picks SET status = ? WHERE id = ? AND dataset_id = ? "
                "AND status = 'rejected'",
                (ch["previous_status"], pid, ds_id),
            )
            if cur.rowcount == 0:
                # Pick was deleted in the meantime (or already restored);
                # report instead of failing the rollback.
                if conn.execute(
                    "SELECT 1 FROM picks WHERE id = ? AND dataset_id = ?",
                    (pid, ds_id),
                ).fetchone() is None:
                    missing.append(pid)
                continue
            r = conn.execute(
                "SELECT * FROM picks WHERE id = ?", (pid,),
            ).fetchone()
            p = dict(r)
            restored.append(_change_payload(pid, p, previous="rejected",
                                            current=p["status"]))
        conn.execute(
            "UPDATE conflict_actions SET status = 'undone', undone_at = ? "
            "WHERE id = ?",
            (stamp, action["id"]),
        )

        payload = {
            "id": action["id"],
            "group_count": action["group_count"],
            "change_count": action["change_count"],
            "created_at": action["created_at"],
            "undone_at": stamp,
            "status": "undone",
        }
    return {"action": payload, "changes": restored,
            "missing_pick_ids": missing}


def get_active_action(ds_id: int) -> dict[str, Any] | None:
    """Summary of the currently undoable batch, if any."""
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM conflict_actions WHERE dataset_id = ? "
            "AND status = 'active' ORDER BY id DESC LIMIT 1",
            (ds_id,),
        ).fetchone()
        if row is None:
            return None
        action = dict(row)
        change_rows = [dict(r) for r in conn.execute(
            "SELECT * FROM conflict_action_changes WHERE action_id = ? ORDER BY id",
            (action["id"],),
        ).fetchall()]

    groups: list[dict[str, Any]] = []
    index: dict[tuple[str, str], dict[str, Any]] = {}
    for ch in change_rows:
        key = (ch["station"], ch["phase"])
        g = index.get(key)
        if g is None:
            g = {"station": ch["station"], "phase": ch["phase"],
                 "rejected_pick_ids": []}
            index[key] = g
            groups.append(g)
        g["rejected_pick_ids"].append(ch["pick_id"])

    return {
        "id": action["id"],
        "status": action["status"],
        "group_count": action["group_count"],
        "change_count": action["change_count"],
        "created_at": action["created_at"],
        "groups": groups,
    }


def _change_payload(pick_id: int, p: dict[str, Any], *,
                    previous: str, current: str) -> dict[str, Any]:
    return {
        "pick_id": pick_id,
        "id": pick_id,
        "station": p["station"],
        "phase": p["phase"],
        "time": p["time"],
        "time_iso": ms_to_iso(p["time"]),
        "uncertainty": p["uncertainty"],
        "weight": p["weight"],
        "source": p["source"],
        "previous_status": previous,
        "status": current,
    }
