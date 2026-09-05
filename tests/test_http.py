from pathlib import Path

from fastapi.testclient import TestClient

from app.main import create_app


def make_client(tmp_path: Path) -> TestClient:
    app = create_app(tmp_path / "teachqrs.db")
    return TestClient(app, follow_redirects=False)


def teacher_client(tmp_path: Path) -> TestClient:
    client = make_client(tmp_path)
    assert client.get("/teacher").status_code == 303
    setup = client.post("/teacher/setup", data={"password": "secret1", "confirm": "secret1"})
    assert setup.status_code == 303
    return client


def test_student_questions_require_identity(tmp_path):
    client = teacher_client(tmp_path)
    client.post("/teacher/subclasses", data={"name": "Tutorial 01", "code": "T01"})
    created = client.post("/teacher/sets", data={"title": "Bank", "mode": "interactive"})
    set_url = created.headers["location"]
    sample = Path(__file__).resolve().parents[1] / "sample_data" / "questions.csv"
    client.post(f"{set_url}/import", files={"file": ("questions.csv", sample.read_bytes(), "text/csv")})
    set_id = int(set_url.rsplit("/", 1)[-1])
    subclasses_page = client.get("/teacher")
    assert subclasses_page.status_code == 200
    # subclass id is 1 on a fresh db
    start = client.post(
        "/teacher/sessions",
        data={"set_id": set_id, "name": "L1", "mode": "interactive", "subclass_ids": 1},
    )
    assert start.status_code == 303
    live_url = start.headers["location"]
    session_id = int(live_url.rsplit("/", 1)[-1])
    live = client.get(live_url)
    assert live.status_code == 200
    code = "ABCD"
    # fetch join code from db via live html
    html = live.text
    import re

    match = re.search(r'class="join-code">([A-Z0-9]+)', html)
    assert match
    code = match.group(1)

    guest = TestClient(create_app(tmp_path / "teachqrs.db"), follow_redirects=False)
    denied = guest.get(f"/api/session/{code}/questions")
    assert denied.status_code == 401
    blank = guest.post(f"/j/{code}/join", data={"student_number": "", "subclass_id": 1})
    assert blank.status_code == 303
    play = guest.get(f"/j/{code}/play")
    assert play.status_code == 303

    joined = guest.post(f"/j/{code}/join", data={"student_number": "3035123456", "subclass_id": 1})
    assert joined.status_code == 303
    allowed = guest.get(f"/api/session/{code}/questions")
    assert allowed.status_code == 200
    assert allowed.json()["questions"]

    qid = allowed.json()["questions"][0]["id"]
    ans = guest.post(f"/j/{code}/answer", data={"question_id": qid, "value": "B"})
    assert ans.status_code == 303

    csv = client.get(f"/teacher/sessions/{session_id}/export.csv")
    assert csv.status_code == 200
    body = csv.text
    assert body.splitlines()[0].startswith("session_name,join_code,subclass,student_number")
    assert "3035123456" in body
    assert "T01" in body


def test_two_subclasses_same_questions(tmp_path):
    client = teacher_client(tmp_path)
    client.post("/teacher/subclasses", data={"name": "Tutorial 01", "code": "T01"})
    client.post("/teacher/subclasses", data={"name": "Tutorial 02", "code": "T02"})
    created = client.post("/teacher/sets", data={"title": "Bank", "mode": "interactive"})
    set_url = created.headers["location"]
    sample = Path(__file__).resolve().parents[1] / "sample_data" / "questions.csv"
    client.post(f"{set_url}/import", files={"file": ("questions.csv", sample.read_bytes(), "text/csv")})
    start = client.post(
        "/teacher/sessions",
        data={"set_id": 1, "name": "L1", "mode": "interactive", "subclass_ids": [1, 2]},
    )
    assert start.status_code == 303
    live = client.get(start.headers["location"])
    assert "T01" in live.text and "T02" in live.text
    qr = client.get(start.headers["location"] + "/qr.png")
    assert qr.status_code == 200
    assert qr.content[:8] == b"\x89PNG\r\n\x1a\n"
    import re

    code = re.search(r'class="join-code">([A-Z0-9]+)', live.text).group(1)
    g1 = TestClient(create_app(tmp_path / "teachqrs.db"), follow_redirects=False)
    g2 = TestClient(create_app(tmp_path / "teachqrs.db"), follow_redirects=False)
    assert "Student number" in g1.get(f"/j/{code}").text
    g1.post(f"/j/{code}/join", data={"student_number": "s001", "subclass_id": 1})
    g2.post(f"/j/{code}/join", data={"student_number": "s002", "subclass_id": 2})
    qid = g1.get(f"/api/session/{code}/questions").json()["questions"][0]["id"]
    g1.post(f"/j/{code}/answer", data={"question_id": qid, "value": "B"})
    g2.post(f"/j/{code}/answer", data={"question_id": qid, "value": "A"})
    sid = start.headers["location"].rsplit("/", 1)[-1]
    t01 = client.get(f"/api/live/{sid}?subclass_id=1").json()["results"]
    t02 = client.get(f"/api/live/{sid}?subclass_id=2").json()["results"]
    assert t01["answered"] == 1
    assert t02["answered"] == 1
    export = client.get(f"/teacher/sessions/{sid}/export.csv").text
    assert "s001" in export and "s002" in export
    assert "T01" in export and "T02" in export


def test_question_csv_and_xlsx_export_round_trip(tmp_path):
    client = teacher_client(tmp_path)
    created = client.post("/teacher/sets", data={"title": "Bank", "mode": "survey"})
    set_url = created.headers["location"]
    sample = Path(__file__).resolve().parents[1] / "sample_data" / "questions.csv"
    imp = client.post(f"{set_url}/import", files={"file": ("questions.csv", sample.read_bytes(), "text/csv")})
    assert imp.status_code == 303
    csv_body = client.get(f"{set_url}/export.csv").text
    assert csv_body.splitlines()[0] == (
        "question_number,prompt,type,choice_a,choice_b,choice_c,choice_d,choice_e,correct,points"
    )
    xlsx = client.get(f"{set_url}/export.xlsx")
    assert xlsx.status_code == 200
    assert xlsx.content[:2] == b"PK"
