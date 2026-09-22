"""Import waveform JSON payloads.

Two payload shapes are accepted.

Flat shape::

    {
      "name": "event 1",
      "traces": [
        {"network": "NET", "station": "STA", "channel": "HHZ",
         "start_time": "2026-09-22T00:00:00Z",
         "sample_rate": 100.0, "samples": [0.1, 0.2, ...]}
      ],
      "picks": [
        {"station": "STA", "phase": "P", "time": "...", "uncertainty": 50}
      ]
    }

Nested shape::

    {"name": "...", "stations": [{"network": ..., "station": ...,
                                   "traces": [...], "picks": [...]}]}

Times may be ISO-8601 strings or epoch milliseconds (number / digit string).
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from .time_utils import parse_time


class ImportError_(ValueError):
    pass


def _parse(value: Any, what: str) -> int:
    try:
        return parse_time(value)
    except (ValueError, TypeError) as exc:
        raise ImportError_(f"invalid {what}: {value!r} ({exc})") from exc


@dataclass
class ImportedPick:
    station: str
    phase: str
    time_ms: int
    uncertainty_ms: int
    source: str = "analyst"
    weight: float = 1.0


@dataclass
class ImportedTrace:
    network: str
    station: str
    channel: str
    start_time_ms: int
    sample_rate: float
    samples_json: str
    n_samples: int
    end_time_ms: int


@dataclass
class ImportedDataset:
    name: str
    traces: list[ImportedTrace] = field(default_factory=list)
    picks: list[ImportedPick] = field(default_factory=list)


def _coerce_trace(raw: dict[str, Any], net_default: str = "", sta_default: str = "") -> ImportedTrace:
    def req(key: str) -> Any:
        if key not in raw or raw[key] is None:
            raise ImportError_(f"trace missing required field {key!r}: {raw.get('channel')}")
        return raw[key]

    station = str(raw.get("station") or sta_default or "").strip()
    network = str(raw.get("network") or net_default or "").strip()
    channel = str(req("channel")).strip()
    if not station:
        raise ImportError_("trace has no station code")
    if not channel:
        raise ImportError_("trace has no channel code")

    start_ms = _parse(req("start_time"), "trace start_time")
    sr = req("sample_rate")
    try:
        sr = float(sr)
    except (TypeError, ValueError) as exc:
        raise ImportError_(f"sample_rate must be numeric (got {sr!r})") from exc
    if sr <= 0:
        raise ImportError_(f"sample_rate must be > 0 (got {sr})")

    samples = req("samples")
    if not isinstance(samples, list) or not samples:
        raise ImportError_(f"trace {station}.{channel} samples must be a non-empty array")
    try:
        floats = [float(x) for x in samples]
    except (TypeError, ValueError) as exc:
        raise ImportError_(f"trace {station}.{channel} samples must all be numeric") from exc

    duration_ms = (len(floats) - 1) / sr * 1000.0
    end_ms = start_ms + int(round(duration_ms))
    return ImportedTrace(
        network=network, station=station, channel=channel,
        start_time_ms=start_ms, sample_rate=sr,
        samples_json=json.dumps(floats, separators=(",", ":")),
        n_samples=len(floats), end_time_ms=end_ms,
    )


def _coerce_pick(raw: dict[str, Any], sta_default: str = "") -> ImportedPick:
    station = str(raw.get("station") or sta_default or "").strip()
    if not station:
        raise ImportError_("pick has no station code")
    phase = str(raw.get("phase", "")).strip().upper()
    if phase not in ("P", "S"):
        raise ImportError_(f"pick phase must be 'P' or 'S' (got {raw.get('phase')!r})")
    try:
        time_ms = _parse(raw["time"], "pick time")
    except KeyError as exc:
        raise ImportError_("pick missing required field 'time'") from exc
    try:
        uncertainty_ms = int(round(float(raw.get("uncertainty", 0))))
    except (TypeError, ValueError) as exc:
        raise ImportError_("pick uncertainty must be a number of milliseconds") from exc
    if uncertainty_ms < 0:
        raise ImportError_("pick uncertainty must be >= 0")
    try:
        weight = float(raw.get("weight", 1.0))
    except (TypeError, ValueError) as exc:
        raise ImportError_("pick weight must be numeric") from exc
    if weight <= 0:
        raise ImportError_("pick weight must be > 0")
    source = str(raw.get("source", "analyst"))[:40]
    return ImportedPick(station, phase, time_ms, uncertainty_ms, source, weight)


def parse_payload(data: bytes | str | dict[str, Any]) -> ImportedDataset:
    if isinstance(data, (bytes, str)):
        try:
            payload = json.loads(data)
        except json.JSONDecodeError as exc:
            raise ImportError_(f"payload is not valid JSON: {exc}") from exc
    else:
        payload = data
    if not isinstance(payload, dict):
        raise ImportError_("payload must be a JSON object")

    name = str(payload.get("name") or "imported dataset")[:120]
    traces: list[ImportedTrace] = []
    picks: list[ImportedPick] = []

    for raw in payload.get("traces", []) or []:
        if not isinstance(raw, dict):
            raise ImportError_("traces[] entries must be objects")
        traces.append(_coerce_trace(raw))

    for raw in payload.get("stations", []) or []:
        if not isinstance(raw, dict):
            raise ImportError_("stations[] entries must be objects")
        net = str(raw.get("network") or "").strip()
        sta = str(raw.get("station") or raw.get("code") or "").strip()
        if not sta:
            raise ImportError_("station entry missing station code")
        for t in raw.get("traces", []) or []:
            traces.append(_coerce_trace(t, net_default=net, sta_default=sta))
        for p in raw.get("picks", []) or []:
            picks.append(_coerce_pick(p, sta_default=sta))

    for raw in payload.get("picks", []) or []:
        if not isinstance(raw, dict):
            raise ImportError_("picks[] entries must be objects")
        picks.append(_coerce_pick(raw))

    if not traces:
        raise ImportError_("payload contains no traces")

    station_span: dict[str, tuple[int, int]] = {}
    for t in traces:
        lo, hi = station_span.get(t.station, (t.start_time_ms, t.end_time_ms))
        station_span[t.station] = (min(lo, t.start_time_ms), max(hi, t.end_time_ms))

    for pk in picks:
        if pk.station not in station_span:
            raise ImportError_(
                f"pick references unknown station {pk.station!r}")
        lo, hi = station_span[pk.station]
        if not lo <= pk.time_ms <= hi:
            raise ImportError_(
                f"{pk.station} {pk.phase} pick at {pk.time_ms} lies outside "
                f"its waveform span ({lo} .. {hi})")

    return ImportedDataset(name=name, traces=traces, picks=picks)
