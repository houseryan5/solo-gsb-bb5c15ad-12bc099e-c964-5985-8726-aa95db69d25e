"""SQLite connection management."""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from typing import Iterator

from .config import DB_PATH


def get_conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS datasets (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL,
                created_at  TEXT NOT NULL,
                start_time  INTEGER NOT NULL,
                end_time    INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS traces (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                dataset_id  INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
                station     TEXT NOT NULL,
                network     TEXT NOT NULL DEFAULT '',
                channel     TEXT NOT NULL,
                start_time  INTEGER NOT NULL,   -- epoch ms
                sample_rate REAL NOT NULL,      -- Hz
                samples     TEXT NOT NULL       -- JSON array of floats
            );

            CREATE TABLE IF NOT EXISTS picks (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                dataset_id    INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
                station       TEXT NOT NULL,
                phase         TEXT NOT NULL CHECK (phase IN ('P','S')),
                time          INTEGER NOT NULL, -- epoch ms
                uncertainty   INTEGER NOT NULL,  -- ±ms
                source        TEXT NOT NULL DEFAULT 'analyst',
                weight        REAL NOT NULL DEFAULT 1.0,
                status        TEXT NOT NULL DEFAULT 'candidate'
                              CHECK (status IN ('candidate','rejected')),
                created_at    TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS reviews (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                dataset_id    INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
                station       TEXT NOT NULL,
                phase         TEXT NOT NULL CHECK (phase IN ('P','S')),
                time          INTEGER NOT NULL,
                uncertainty   INTEGER NOT NULL,
                method        TEXT NOT NULL CHECK (method IN ('manual','consensus')),
                pick_id       INTEGER REFERENCES picks(id) ON DELETE SET NULL,
                cluster_id    INTEGER,
                note          TEXT NOT NULL DEFAULT '',
                created_at    TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_traces_dataset  ON traces(dataset_id);
            CREATE INDEX IF NOT EXISTS idx_picks_dataset   ON picks(dataset_id);
            CREATE INDEX IF NOT EXISTS idx_reviews_dataset ON reviews(dataset_id);
            """
        )
