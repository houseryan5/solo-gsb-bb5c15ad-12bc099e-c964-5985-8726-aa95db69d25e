"""FastAPI application: seismic arrival-pick review workbench."""
from __future__ import annotations

import io
import json
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import crud
from .config import STATIC_DIR
from .consensus import analyze
from .database import init_db
from .demo import create_demo_dataset
from .importer import ImportError_, parse_payload
from .time_utils import ms_to_iso, now_ms

app = FastAPI(title="Seismic Pick Review Workbench", version="1.0.0")


@app.on_event("startup")
def _startup() -> None:
    init_db()


# ---------------------------------------------------------------- schemas ----
class PickIn(BaseModel):
    station: str = Field(min_length=1, max_length=40)
    phase: Literal["P", "S"]
    time: int
    uncertainty: int = Field(default=0, ge=0)
    weight: float = Field(default=1.0, gt=0, le=100)
    source: str = Field(default="analyst", max_length=40)


class PickPatch(BaseModel):
    time: int | None = None
    uncertainty: int | None = Field(default=None, ge=0)
    weight: float | None = Field(default=None, gt=0, le=100)
    phase: Literal["P", "S"] | None = None


class ReviewIn(BaseModel):
    station: str = Field(min_length=1, max_length=40)
    phase: Literal["P", "S"]
    time: int
    uncertainty: int = Field(default=0, ge=0)
    method: Literal["manual", "consensus"] = "manual"
    pick_id: int | None = None
    cluster_id: int | None = None
    note: str = Field(default="", max_length=400)


# ------------------------------------------------------------- datasets ------
@app.get("/api/datasets")
def api_list_datasets() -> list[dict[str, Any]]:
    return crud.list_datasets()


@app.post("/api/datasets/import")
async def api_import_dataset(request: Request) -> dict[str, Any]:
    raw = await request.body()
    try:
        imp = parse_payload(raw)
    except ImportError_ as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    ds_id = crud.create_dataset(imp)
    meta = crud.get_dataset_meta(ds_id)
    return {"id": ds_id, "name": meta["name"], "created_at": meta["created_at"]}


@app.post("/api/datasets/demo")
def api_create_demo() -> dict[str, Any]:
    ds_id = create_demo_dataset()
    meta = crud.get_dataset_meta(ds_id)
    return {"id": ds_id, "name": meta["name"], "created_at": meta["created_at"]}


def _require_dataset(ds_id: int) -> dict[str, Any]:
    meta = crud.get_dataset_meta(ds_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="dataset not found")
    return meta


@app.get("/api/datasets/{ds_id}")
def api_dataset_detail(ds_id: int) -> dict[str, Any]:
    meta = _require_dataset(ds_id)
    return {
        "dataset": meta,
        "traces": crud.get_traces(ds_id),
        "picks": crud.get_picks(ds_id),
        "reviews": crud.get_reviews(ds_id),
    }


@app.get("/api/datasets/{ds_id}/analysis")
def api_analysis(ds_id: int) -> dict[str, Any]:
    _require_dataset(ds_id)
    result = analyze(crud.get_picks(ds_id))
    result["reviews"] = crud.get_reviews(ds_id)
    return result


@app.delete("/api/datasets/{ds_id}")
def api_delete_dataset(ds_id: int) -> dict[str, str]:
    _require_dataset(ds_id)
    crud.delete_dataset(ds_id)
    return {"status": "deleted"}


@app.get("/api/datasets/{ds_id}/export")
def api_export(ds_id: int) -> StreamingResponse:
    meta = _require_dataset(ds_id)
    analysis = analyze(crud.get_picks(ds_id))
    payload = {
        "dataset": {
            "id": meta["id"], "name": meta["name"],
            "created_at": meta["created_at"],
            "start_time": meta["start_time"],
            "start_time_iso": ms_to_iso(meta["start_time"]),
            "end_time": meta["end_time"],
            "end_time_iso": ms_to_iso(meta["end_time"]),
        },
        "accepted_arrivals": [],
        "candidate_picks": [],
        "rejected_picks": [],
        "conflict_groups": [g for g in analysis["groups"] if g["conflict"]],
        "conflict_pairs": analysis["conflicts"],
        "exported_at": ms_to_iso(now_ms()),
    }

    for r in crud.get_reviews(ds_id):
        payload["accepted_arrivals"].append({
            "id": r["id"], "station": r["station"], "phase": r["phase"],
            "time": r["time"], "time_iso": ms_to_iso(r["time"]),
            "uncertainty": r["uncertainty"],
            "uncertainty_window": {
                "start": r["time"] - r["uncertainty"],
                "end": r["time"] + r["uncertainty"],
            },
            "method": r["method"], "pick_id": r["pick_id"],
            "cluster_id": r["cluster_id"], "note": r["note"],
            "created_at": r["created_at"],
        })

    for g in analysis["groups"]:
        for p in g["picks"]:
            payload["candidate_picks"].append({
                "id": p["id"], "station": p["station"], "phase": p["phase"],
                "time": p["time"], "time_iso": ms_to_iso(p["time"]),
                "uncertainty": p["uncertainty"],
                "uncertainty_window": {
                    "start": p["time"] - p["uncertainty"],
                    "end": p["time"] + p["uncertainty"],
                },
                "weight": p["weight"], "source": p["source"],
                "cluster_id": p["cluster_id"],
                "outlier_cluster": p["is_outlier"],
            })
    for p in analysis["rejected"]:
        payload["rejected_picks"].append({
            "id": p["id"], "station": p["station"], "phase": p["phase"],
            "time": p["time"], "time_iso": ms_to_iso(p["time"]),
            "uncertainty": p["uncertainty"], "weight": p["weight"],
            "source": p["source"],
        })

    buf = io.BytesIO(json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8"))
    safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in meta["name"])
    return StreamingResponse(
        buf, media_type="application/json",
        headers={"Content-Disposition":
                 f'attachment; filename="review_{meta["id"]}_{safe_name}.json"'},
    )


# ---------------------------------------------------------------- picks ------
def _require_pick(ds_id: int, pick_id: int) -> dict[str, Any]:
    pick = crud.get_pick(ds_id, pick_id)
    if pick is None:
        raise HTTPException(status_code=404, detail="pick not found")
    return pick


def _station_window(ds_id: int, station: str) -> tuple[int, int] | None:
    for t in crud.get_traces(ds_id):
        if t["station"] == station:
            return t["start_time"], t["end_time"]
    return None


def _check_station_time(ds_id: int, station: str, time_ms: int) -> None:
    win = _station_window(ds_id, station)
    if win is None:
        raise HTTPException(status_code=422,
                            detail=f"unknown station {station!r}")
    lo, hi = win
    if not lo <= time_ms <= hi:
        raise HTTPException(
            status_code=422,
            detail=f"pick time {ms_to_iso(time_ms)} outside waveform span of "
                   f"{station} ({ms_to_iso(lo)} .. {ms_to_iso(hi)})")


@app.post("/api/datasets/{ds_id}/picks")
def api_create_pick(ds_id: int, body: PickIn) -> dict[str, Any]:
    _require_dataset(ds_id)
    _check_station_time(ds_id, body.station.strip(), body.time)
    return crud.create_pick(
        ds_id, body.station.strip(), body.phase, body.time,
        body.uncertainty, body.source.strip() or "analyst", body.weight,
    )


@app.patch("/api/datasets/{ds_id}/picks/{pick_id}")
def api_patch_pick(ds_id: int, pick_id: int, body: PickPatch) -> dict[str, str]:
    pick = _require_pick(ds_id, pick_id)
    if body.time is not None:
        _check_station_time(ds_id, pick["station"], body.time)
    crud.update_pick(
        ds_id, pick_id, time_ms=body.time, uncertainty_ms=body.uncertainty,
        weight=body.weight, phase=body.phase,
    )
    return {"status": "updated"}


@app.post("/api/datasets/{ds_id}/picks/{pick_id}/reject")
def api_reject_pick(ds_id: int, pick_id: int) -> dict[str, str]:
    _require_pick(ds_id, pick_id)
    crud.set_pick_status(ds_id, pick_id, "rejected")
    return {"status": "rejected"}


@app.post("/api/datasets/{ds_id}/picks/{pick_id}/restore")
def api_restore_pick(ds_id: int, pick_id: int) -> dict[str, str]:
    _require_pick(ds_id, pick_id)
    crud.set_pick_status(ds_id, pick_id, "candidate")
    return {"status": "candidate"}


@app.delete("/api/datasets/{ds_id}/picks/{pick_id}")
def api_delete_pick(ds_id: int, pick_id: int) -> dict[str, str]:
    _require_pick(ds_id, pick_id)
    crud.delete_pick(ds_id, pick_id)
    return {"status": "deleted"}


# --------------------------------------------------------------- reviews -----
@app.post("/api/datasets/{ds_id}/reviews")
def api_create_review(ds_id: int, body: ReviewIn) -> dict[str, Any]:
    _require_dataset(ds_id)
    _check_station_time(ds_id, body.station.strip(), body.time)
    if body.pick_id is not None and crud.get_pick(ds_id, body.pick_id) is None:
        raise HTTPException(status_code=404, detail="referenced pick not found")
    return crud.create_review(
        ds_id, body.station.strip(), body.phase, body.time,
        body.uncertainty, body.method, body.pick_id, body.cluster_id, body.note,
    )


@app.delete("/api/datasets/{ds_id}/reviews/{review_id}")
def api_delete_review(ds_id: int, review_id: int) -> dict[str, str]:
    reviews = {r["id"] for r in crud.get_reviews(ds_id)}
    if review_id not in reviews:
        raise HTTPException(status_code=404, detail="review not found")
    crud.delete_review(ds_id, review_id)
    return {"status": "deleted"}


# ---------------------------------------------------------------- static -----
@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
