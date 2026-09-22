"""Generate a small synthetic event dataset so the UI is explorable immediately."""
from __future__ import annotations

import json
import math
import random
from datetime import datetime, timezone

from .database import db
from .time_utils import ms_to_iso, now_ms

STATIONS = [
    # network, station, lat-ish label, distance km from source, noise sigma
    ("NET", "STA01", 12.0, 0.06),
    ("NET", "STA02", 28.0, 0.09),
    ("NET", "STA03", 45.0, 0.12),
    ("NET", "STA04", 67.0, 0.15),
]
VP = 6.0   # km/s
VS = 3.4
SAMPLE_RATE = 100.0
DURATION_S = 30.0
CHANNELS = ["HHZ", "HHN", "HHE"]


def _ricker(t: float, width: float) -> float:
    x = (t / width) ** 2
    return (1.0 - 2.0 * x) * math.exp(-x)


def _build_trace(rng: random.Random, p_s: float, s_s: float,
                 noise: float, channel: str) -> list[float]:
    n = int(DURATION_S * SAMPLE_RATE)
    out: list[float] = []
    p_amp = 1.6 if channel == "HHZ" else 0.9
    s_amp = 2.4 if channel != "HHZ" else 1.1
    p_w = 0.06
    s_w = 0.11
    for i in range(n):
        ts = i / SAMPLE_RATE
        v = rng.gauss(0.0, noise)
        if p_s <= ts < p_s + 1.2:
            v += p_amp * _ricker(ts - p_s, p_w)
        if s_s <= ts < s_s + 1.8:
            v += s_amp * _ricker(ts - s_s, s_w)
        out.append(round(v, 5))
    return out


def create_demo_dataset() -> int:
    rng = random.Random(20260922)
    origin = int(datetime(2026, 9, 22, 0, 0, 0, tzinfo=timezone.utc).timestamp() * 1000)

    trace_rows: list[tuple] = []
    pick_rows: list[tuple] = []
    start_min = origin
    end_max = origin + int(DURATION_S * 1000)

    for net, sta, dist, noise in STATIONS:
        p_s = dist / VP
        s_s = dist / VS
        p_ms = origin + int(round(p_s * 1000))
        s_ms = origin + int(round(s_s * 1000))
        for ch in CHANNELS:
            samples = _build_trace(rng, p_s, s_s, noise, ch)
            trace_rows.append((
                sta, net, ch, origin, SAMPLE_RATE,
                json.dumps(samples, separators=(",", ":")),
            ))

        # Three analysts per phase: mostly agreeing windows, one outlier pick.
        pick_rows.append((sta, "P", p_ms + rng.randint(-25, 25), 60,
                          "analyst-a", 1.0))
        pick_rows.append((sta, "P", p_ms + rng.randint(-20, 30), 70,
                          "analyst-b", 0.8))
        pick_rows.append((sta, "P", p_ms + rng.randint(180, 260), 40,
                          "auto-detect", 0.5))
        pick_rows.append((sta, "S", s_ms + rng.randint(-40, 40), 90,
                          "analyst-a", 1.0))
        pick_rows.append((sta, "S", s_ms + rng.randint(-30, 45), 100,
                          "analyst-b", 0.8))
        pick_rows.append((sta, "S", s_ms + rng.randint(-300, -200), 50,
                          "auto-detect", 0.5))

    stamp = ms_to_iso(now_ms())
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO datasets (name, created_at, start_time, end_time) "
            "VALUES (?, ?, ?, ?)",
            (f"demo event 2026-09-22 ({len(STATIONS)} stations)",
             stamp, start_min, end_max),
        )
        ds_id = cur.lastrowid
        conn.executemany(
            "INSERT INTO traces (dataset_id, station, network, channel, "
            "start_time, sample_rate, samples) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [(ds_id, *r) for r in trace_rows],
        )
        conn.executemany(
            "INSERT INTO picks (dataset_id, station, phase, time, uncertainty, "
            "source, weight, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', ?)",
            [(ds_id, sta, ph, t, u, src, w, stamp)
             for sta, ph, t, u, src, w in pick_rows],
        )
    return ds_id
