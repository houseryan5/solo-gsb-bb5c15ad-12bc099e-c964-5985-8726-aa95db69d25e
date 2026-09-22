"""Interval-overlap conflict detection and weighted consensus arrivals.

Rules
-----
Candidate picks for the same ``(station, phase)`` each carry a central time
``t`` and a symmetric uncertainty window ``[t-u, t+u]`` (milliseconds).

* Two picks are *consistent* when their windows overlap or touch:
  ``|t1 - t2| <= u1 + u2``.
* Consistency is an equivalence relation after transitive closure; we build
  connected components (clusters) with a union-find over the overlap graph.
* A station/phase group with more than one cluster has a **conflict**: the
  members of smaller (outlier) clusters do not agree with the main group.
* Every non-overlapping pair inside the group is reported as a conflict pair.
* Per cluster we compute a weight-consensus arrival.  Each pick contributes a
  composite weight ``c_i = pick.weight / (u_i + 1 ms)``, so precise picks
  count more; the cluster time is the weighted mean and its uncertainty is the
  weighted standard error (with an effective sample size).  A singleton
  cluster simply adopts that pick's time and uncertainty.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Sequence

_PHASES = ("P", "S")


@dataclass
class Pick:
    id: int
    station: str
    phase: str
    time: int          # epoch ms
    uncertainty: int   # ±ms
    weight: float
    source: str
    status: str
    created_at: str


class _DSU:
    def __init__(self, n: int) -> None:
        self.parent = list(range(n))
        self.rank = [0] * n

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        if self.rank[ra] < self.rank[rb]:
            ra, rb = rb, ra
        self.parent[rb] = ra
        if self.rank[ra] == self.rank[rb]:
            self.rank[ra] += 1


def _weighted_consensus(members: Sequence[Pick]) -> tuple[int, int]:
    """Return (consensus_time_ms, consensus_uncertainty_ms)."""
    if len(members) == 1:
        return members[0].time, members[0].uncertainty

    comp = [max(p.weight, 1e-9) / (p.uncertainty + 1.0) for p in members]
    c_total = sum(comp)
    t_mean = sum(c * p.time for c, p in zip(comp, members)) / c_total

    # Weighted variance inside the cluster.
    var = sum(c * (p.time - t_mean) ** 2 for c, p in zip(comp, members)) / c_total
    n_eff = c_total ** 2 / sum(c * c for c in comp)
    stderr = math.sqrt(var / n_eff) if n_eff > 0 else 0.0
    return int(round(t_mean)), max(1, int(round(stderr)))


def analyze(picks: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Run overlap clustering + consensus over raw pick rows.

    Only ``status == 'candidate'`` picks participate; rejected picks are
    returned untouched in ``rejected`` so the UI can dim them.
    """
    active = [Pick(p["id"], p["station"], p["phase"], p["time"],
                   p["uncertainty"], p["weight"], p["source"],
                   p["status"], p["created_at"])
              for p in picks if p["status"] == "candidate"]
    rejected = [p for p in picks if p["status"] != "candidate"]

    groups: dict[tuple[str, str], list[Pick]] = {}
    for pk in active:
        groups.setdefault((pk.station, pk.phase), []).append(pk)

    out_groups: list[dict[str, Any]] = []
    conflict_pairs: list[dict[str, Any]] = []

    # Stable station ordering, P before S.
    for station in sorted({s for s, _ in groups}):
        for phase in _PHASES:
            members = groups.get((station, phase))
            if not members:
                continue
            members.sort(key=lambda p: p.time)
            n = len(members)
            dsu = _DSU(n)

            # First pass: union overlapping windows (transitive closure).
            for i in range(n):
                for j in range(i + 1, n):
                    pi, pj = members[i], members[j]
                    if abs(pi.time - pj.time) <= pi.uncertainty + pj.uncertainty:
                        dsu.union(i, j)

            # Second pass: non-overlapping pairs in *different* clusters
            # are genuine conflicts; intra-cluster non-touching pairs are
            # reconciled through an intermediary and are not reported.
            for i in range(n):
                for j in range(i + 1, n):
                    if dsu.find(i) != dsu.find(j):
                        pi, pj = members[i], members[j]
                        if abs(pi.time - pj.time) > pi.uncertainty + pj.uncertainty:
                            conflict_pairs.append({
                                "station": station, "phase": phase,
                                "pick_a_id": pi.id, "pick_b_id": pj.id,
                            })

            comps: dict[int, list[Pick]] = {}
            for i, pk in enumerate(members):
                comps.setdefault(dsu.find(i), []).append(pk)

            clusters = sorted(
                comps.values(),
                key=lambda ms: (-len(ms), -sum(p.weight for p in ms),
                                min(p.time for p in ms)),
            )
            primary_members = clusters[0]
            primary_ids = {p.id for p in primary_members}

            cluster_payload: list[dict[str, Any]] = []
            for idx, ms in enumerate(clusters):
                ct, cu = _weighted_consensus(ms)
                cluster_payload.append({
                    "cluster_id": idx,
                    "pick_ids": [p.id for p in ms],
                    "size": len(ms),
                    "sum_weight": round(sum(p.weight for p in ms), 6),
                    "consensus_time": ct,
                    "consensus_uncertainty": cu,
                    "primary": idx == 0,
                })

            pick_payload = [{
                "id": p.id, "station": p.station, "phase": p.phase,
                "time": p.time, "uncertainty": p.uncertainty,
                "weight": p.weight, "source": p.source,
                "created_at": p.created_at,
                "cluster_id": _cluster_of(clusters, p),
                "is_outlier": p.id not in primary_ids,
            } for p in members]

            out_groups.append({
                "station": station,
                "phase": phase,
                "conflict": len(clusters) > 1,
                "primary_cluster_id": 0,
                "clusters": cluster_payload,
                "picks": pick_payload,
            })

    return {
        "groups": out_groups,
        "conflicts": conflict_pairs,
        "rejected": [{
            "id": p["id"], "station": p["station"], "phase": p["phase"],
            "time": p["time"], "uncertainty": p["uncertainty"],
            "weight": p["weight"], "source": p["source"],
            "created_at": p["created_at"],
        } for p in rejected],
    }


def _cluster_of(clusters: Sequence[Sequence[Pick]], pick: Pick) -> int:
    for cid, members in enumerate(clusters):
        if pick in members:
            return cid
    return -1
