from __future__ import annotations

import pytest

from app.db import get_db, init_db


@pytest.fixture
def conn(tmp_path):
    db = get_db(tmp_path / "teachqrs.db")
    init_db(db)
    yield db
    db.close()


def add_subclass(conn, name="Tutorial 01", code="T01"):
    cur = conn.execute("INSERT INTO subclasses (name, code) VALUES (?, ?)", (name, code))
    conn.commit()
    return cur.lastrowid


def add_set(conn, title="Mechanics check", mode="interactive"):
    cur = conn.execute(
        "INSERT INTO question_sets (title, mode) VALUES (?, ?)",
        (title, mode),
    )
    conn.commit()
    return cur.lastrowid
