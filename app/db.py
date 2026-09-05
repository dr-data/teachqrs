from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS teachers (
    id INTEGER PRIMARY KEY,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subclasses (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS question_sets (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    welcome_message TEXT NOT NULL DEFAULT 'Welcome. Enter your student number to begin.',
    thanks_message TEXT NOT NULL DEFAULT 'Thank you. You may close this page.',
    mode TEXT NOT NULL DEFAULT 'interactive' CHECK (mode IN ('survey', 'interactive')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY,
    set_id INTEGER NOT NULL REFERENCES question_sets(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('mcq', 'true_false', 'short')),
    choices_json TEXT NOT NULL DEFAULT '[]',
    correct TEXT,
    points REAL NOT NULL DEFAULT 1,
    visible INTEGER NOT NULL DEFAULT 1,
    UNIQUE (set_id, position)
);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    set_id INTEGER NOT NULL REFERENCES question_sets(id),
    name TEXT NOT NULL,
    join_code TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'closed')),
    current_question_id INTEGER REFERENCES questions(id),
    collecting INTEGER NOT NULL DEFAULT 0,
    reveal_results INTEGER NOT NULL DEFAULT 0,
    current_round INTEGER NOT NULL DEFAULT 1,
    mode TEXT NOT NULL DEFAULT 'interactive' CHECK (mode IN ('survey', 'interactive')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    closed_at TEXT
);

CREATE TABLE IF NOT EXISTS session_subclasses (
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    subclass_id INTEGER NOT NULL REFERENCES subclasses(id),
    PRIMARY KEY (session_id, subclass_id)
);

CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    student_number TEXT NOT NULL,
    subclass_id INTEGER NOT NULL REFERENCES subclasses(id),
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (session_id, student_number)
);

CREATE TABLE IF NOT EXISTS responses (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES questions(id),
    student_number TEXT NOT NULL,
    subclass_id INTEGER NOT NULL REFERENCES subclasses(id),
    value TEXT NOT NULL,
    round INTEGER NOT NULL DEFAULT 1,
    is_correct INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (session_id, question_id, student_number, round)
);
"""


def get_db(path: str | Path) -> sqlite3.Connection:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    conn.commit()
