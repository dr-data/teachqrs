from __future__ import annotations

import io
import json
import os
import socket
from pathlib import Path

import qrcode
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.auth import (
    COOKIE_STUDENT,
    COOKIE_TEACHER,
    dumps,
    hash_password,
    load_secret,
    loads,
    make_signer,
    verify_password,
)
from app.db import get_db, init_db
from app.identity import IdentityError, join_session, validate_student_number
from app.questions_io import CSV_HEADER, export_csv, export_xlsx, import_table, parse_csv, parse_xlsx
from app.responses_io import export_responses_csv
from app.sessions import (
    SessionError,
    close_question,
    close_session,
    create_session,
    next_question,
    open_question,
    reopen_for_discussion,
    reset_session_responses,
    results_for_question,
    start_session,
    submit_response,
)

ROOT = Path(__file__).resolve().parent
TEMPLATES = Jinja2Templates(directory=str(ROOT / "templates"))


def lan_ip() -> str | None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return None
    finally:
        sock.close()


def public_base_url(request: Request) -> str:
    forwarded_host = request.headers.get("x-forwarded-host")
    host = forwarded_host or request.headers.get("host") or request.url.netloc
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    hostname = host.split(":")[0]
    if hostname in {"127.0.0.1", "localhost"}:
        detected = lan_ip()
        if detected:
            port = host.split(":")[1] if ":" in host else str(request.url.port or 8765)
            host = f"{detected}:{port}"
    return f"{proto}://{host}"


def create_app(db_path: str | Path | None = None) -> FastAPI:
    chosen = Path(db_path or os.environ.get("TEACHQRS_DB", "data/teachqrs.db"))
    conn = get_db(chosen)
    init_db(conn)
    signer = make_signer(load_secret(chosen.parent))

    app = FastAPI(title="TeachQRS", docs_url=None, redoc_url=None)
    app.state.conn = conn
    app.state.signer = signer
    static_dir = ROOT / "static"
    static_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    def db():
        return app.state.conn

    def teacher_id(request: Request) -> int | None:
        payload = loads(app.state.signer, request.cookies.get(COOKIE_TEACHER))
        return int(payload["id"]) if payload and "id" in payload else None

    def require_teacher(request: Request) -> int:
        tid = teacher_id(request)
        if tid is None:
            raise HTTPException(status_code=303, headers={"Location": "/teacher/login"})
        return tid

    def student_payload(request: Request) -> dict | None:
        return loads(app.state.signer, request.cookies.get(COOKIE_STUDENT))

    def teacher_exists() -> bool:
        row = db().execute("SELECT id FROM teachers LIMIT 1").fetchone()
        return row is not None

    def set_row(set_id: int):
        row = db().execute("SELECT * FROM question_sets WHERE id = ?", (set_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Question set not found")
        return row

    def session_row(session_id: int):
        row = db().execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Session not found")
        return row

    def session_by_code(code: str):
        row = db().execute(
            "SELECT * FROM sessions WHERE join_code = ?", (code.strip().upper(),)
        ).fetchone()
        if row is None:
            raise HTTPException(404, "Unknown join code")
        return row

    def allowed_subclasses(session_id: int) -> list:
        return db().execute(
            """
            SELECT sc.* FROM subclasses sc
            JOIN session_subclasses ss ON ss.subclass_id = sc.id
            WHERE ss.session_id = ?
            ORDER BY sc.code
            """,
            (session_id,),
        ).fetchall()

    def questions_for_set(set_id: int, visible_only: bool = False):
        sql = "SELECT * FROM questions WHERE set_id = ?"
        if visible_only:
            sql += " AND visible = 1"
        sql += " ORDER BY position, id"
        return db().execute(sql, (set_id,)).fetchall()

    def flash_redirect(url: str, message: str, error: bool = False) -> RedirectResponse:
        response = RedirectResponse(url, status_code=303)
        response.set_cookie("teachqrs_flash", dumps(app.state.signer, {"m": message, "e": error}), max_age=20)
        return response

    def pop_flash(request: Request):
        payload = loads(app.state.signer, request.cookies.get("teachqrs_flash"))
        return payload

    def html(request: Request, name: str, status: int = 200, **ctx):
        flash = pop_flash(request)
        response = TEMPLATES.TemplateResponse(
            request,
            name,
            {"flash": flash, **ctx},
            status_code=status,
        )
        if flash:
            response.delete_cookie("teachqrs_flash")
        return response

    @app.get("/", response_class=HTMLResponse)
    def home(request: Request):
        return html(request, "home.html")

    @app.post("/join")
    def join_redirect(code: str = Form(...)):
        return RedirectResponse(f"/j/{code.strip().upper()}", status_code=303)

    @app.get("/teacher/setup", response_class=HTMLResponse)
    def setup_form(request: Request):
        if teacher_exists():
            return RedirectResponse("/teacher/login", status_code=303)
        return html(request, "teacher/setup.html")

    @app.post("/teacher/setup")
    def setup_submit(password: str = Form(...), confirm: str = Form(...)):
        if teacher_exists():
            return RedirectResponse("/teacher/login", status_code=303)
        if len(password) < 6:
            return flash_redirect("/teacher/setup", "Password must be at least 6 characters.", True)
        if password != confirm:
            return flash_redirect("/teacher/setup", "Passwords do not match.", True)
        db().execute("INSERT INTO teachers (password_hash) VALUES (?)", (hash_password(password),))
        db().commit()
        tid = db().execute("SELECT id FROM teachers").fetchone()["id"]
        response = RedirectResponse("/teacher", status_code=303)
        response.set_cookie(COOKIE_TEACHER, dumps(app.state.signer, {"id": tid}), httponly=True, samesite="lax")
        return response

    @app.get("/teacher/login", response_class=HTMLResponse)
    def login_form(request: Request):
        if not teacher_exists():
            return RedirectResponse("/teacher/setup", status_code=303)
        return html(request, "teacher/login.html")

    @app.post("/teacher/login")
    def login_submit(password: str = Form(...)):
        row = db().execute("SELECT * FROM teachers LIMIT 1").fetchone()
        if row is None or not verify_password(password, row["password_hash"]):
            return flash_redirect("/teacher/login", "Wrong password.", True)
        response = RedirectResponse("/teacher", status_code=303)
        response.set_cookie(COOKIE_TEACHER, dumps(app.state.signer, {"id": row["id"]}), httponly=True, samesite="lax")
        return response

    @app.post("/teacher/logout")
    def logout():
        response = RedirectResponse("/", status_code=303)
        response.delete_cookie(COOKIE_TEACHER)
        return response

    @app.get("/teacher", response_class=HTMLResponse)
    def dashboard(request: Request):
        if not teacher_exists():
            return RedirectResponse("/teacher/setup", status_code=303)
        require_teacher(request)
        sets = db().execute("SELECT * FROM question_sets ORDER BY id DESC").fetchall()
        subclasses = db().execute("SELECT * FROM subclasses ORDER BY code").fetchall()
        sessions = db().execute(
            """
            SELECT s.*, qs.title AS set_title
            FROM sessions s JOIN question_sets qs ON qs.id = s.set_id
            ORDER BY s.id DESC LIMIT 20
            """
        ).fetchall()
        return html(
            request,
            "teacher/dashboard.html",
            sets=sets,
            subclasses=subclasses,
            sessions=sessions,
        )

    @app.post("/teacher/subclasses")
    def add_subclass(request: Request, name: str = Form(...), code: str = Form(...)):
        require_teacher(request)
        code_n = code.strip().upper()
        name_n = name.strip()
        if not code_n or not name_n:
            return flash_redirect("/teacher", "Subclass name and code are required.", True)
        try:
            db().execute("INSERT INTO subclasses (name, code) VALUES (?, ?)", (name_n, code_n))
            db().commit()
        except Exception:
            return flash_redirect("/teacher", "That subclass code already exists.", True)
        return flash_redirect("/teacher", f"Subclass {code_n} added.")

    @app.post("/teacher/subclasses/{subclass_id}/delete")
    def delete_subclass(request: Request, subclass_id: int):
        require_teacher(request)
        db().execute("DELETE FROM subclasses WHERE id = ?", (subclass_id,))
        db().commit()
        return flash_redirect("/teacher", "Subclass removed.")

    @app.post("/teacher/sets")
    def create_set(request: Request, title: str = Form(...), mode: str = Form("interactive")):
        require_teacher(request)
        cur = db().execute(
            "INSERT INTO question_sets (title, mode) VALUES (?, ?)",
            (title.strip() or "Untitled set", mode if mode in {"survey", "interactive"} else "interactive"),
        )
        db().commit()
        return RedirectResponse(f"/teacher/sets/{cur.lastrowid}", status_code=303)

    @app.get("/teacher/sets/template.csv")
    def question_template(request: Request):
        require_teacher(request)
        body = ",".join(CSV_HEADER) + "\n"
        return Response(body, media_type="text/csv", headers={"Content-Disposition": "attachment; filename=teachqrs-questions-template.csv"})

    @app.get("/teacher/sets/{set_id}", response_class=HTMLResponse)
    def edit_set(request: Request, set_id: int):
        require_teacher(request)
        qset = set_row(set_id)
        questions = questions_for_set(set_id)
        parsed = []
        for q in questions:
            item = dict(q)
            item["choices"] = json.loads(q["choices_json"] or "[]")
            parsed.append(item)
        return html(request, "teacher/set.html", qset=qset, questions=parsed)

    @app.post("/teacher/sets/{set_id}")
    def update_set(
        request: Request,
        set_id: int,
        title: str = Form(...),
        mode: str = Form(...),
        welcome_message: str = Form(""),
        thanks_message: str = Form(""),
    ):
        require_teacher(request)
        set_row(set_id)
        db().execute(
            """
            UPDATE question_sets
            SET title = ?, mode = ?, welcome_message = ?, thanks_message = ?
            WHERE id = ?
            """,
            (title.strip(), mode, welcome_message.strip(), thanks_message.strip(), set_id),
        )
        db().commit()
        return flash_redirect(f"/teacher/sets/{set_id}", "Set saved.")

    @app.post("/teacher/sets/{set_id}/questions")
    def add_question(
        request: Request,
        set_id: int,
        prompt: str = Form(...),
        type: str = Form("mcq"),
        choice_a: str = Form(""),
        choice_b: str = Form(""),
        choice_c: str = Form(""),
        choice_d: str = Form(""),
        choice_e: str = Form(""),
        correct: str = Form(""),
        points: float = Form(1),
    ):
        require_teacher(request)
        set_row(set_id)
        result = import_table(
            db(),
            set_id,
            [
                {
                    "prompt": prompt,
                    "type": type,
                    "choice_a": choice_a,
                    "choice_b": choice_b,
                    "choice_c": choice_c,
                    "choice_d": choice_d,
                    "choice_e": choice_e,
                    "correct": correct,
                    "points": points,
                }
            ],
        )
        if result.errors:
            return flash_redirect(f"/teacher/sets/{set_id}", result.errors[0], True)
        return flash_redirect(f"/teacher/sets/{set_id}", "Question added.")

    @app.post("/teacher/sets/{set_id}/questions/{question_id}/delete")
    def delete_question(request: Request, set_id: int, question_id: int):
        require_teacher(request)
        db().execute("DELETE FROM questions WHERE id = ? AND set_id = ?", (question_id, set_id))
        db().commit()
        return flash_redirect(f"/teacher/sets/{set_id}", "Question deleted.")

    @app.post("/teacher/sets/{set_id}/questions/{question_id}/toggle")
    def toggle_question(request: Request, set_id: int, question_id: int):
        require_teacher(request)
        db().execute(
            "UPDATE questions SET visible = 1 - visible WHERE id = ? AND set_id = ?",
            (question_id, set_id),
        )
        db().commit()
        return RedirectResponse(f"/teacher/sets/{set_id}", status_code=303)

    @app.post("/teacher/sets/{set_id}/questions/{question_id}/move")
    def move_question(request: Request, set_id: int, question_id: int, direction: str = Form(...)):
        require_teacher(request)
        questions = list(questions_for_set(set_id))
        ids = [q["id"] for q in questions]
        if question_id not in ids:
            raise HTTPException(404)
        idx = ids.index(question_id)
        swap = idx - 1 if direction == "up" else idx + 1
        if 0 <= swap < len(questions):
            a, b = questions[idx], questions[swap]
            db().execute("UPDATE questions SET position = ? WHERE id = ?", (b["position"], a["id"]))
            db().execute("UPDATE questions SET position = ? WHERE id = ?", (a["position"], b["id"]))
            db().commit()
        return RedirectResponse(f"/teacher/sets/{set_id}", status_code=303)

    @app.post("/teacher/sets/{set_id}/import")
    async def import_questions(request: Request, set_id: int, file: UploadFile = File(...)):
        require_teacher(request)
        set_row(set_id)
        data = await file.read()
        name = (file.filename or "").lower()
        try:
            if name.endswith(".xlsx") or name.endswith(".xls"):
                rows = parse_xlsx(data)
            else:
                rows = parse_csv(data.decode("utf-8-sig"))
        except Exception as exc:
            return flash_redirect(f"/teacher/sets/{set_id}", f"Could not read file: {exc}", True)
        result = import_table(db(), set_id, rows)
        msg = f"Imported {result.imported} question(s)."
        if result.errors:
            msg += " " + " ".join(result.errors[:5])
        return flash_redirect(f"/teacher/sets/{set_id}", msg, bool(result.errors) and result.imported == 0)

    @app.get("/teacher/sets/{set_id}/export.csv")
    def export_questions_csv(request: Request, set_id: int):
        require_teacher(request)
        qset = set_row(set_id)
        body = export_csv(db(), set_id)
        filename = f"teachqrs-questions-{qset['id']}.csv"
        return Response(body, media_type="text/csv", headers={"Content-Disposition": f"attachment; filename={filename}"})

    @app.get("/teacher/sets/{set_id}/export.xlsx")
    def export_questions_xlsx(request: Request, set_id: int):
        require_teacher(request)
        qset = set_row(set_id)
        body = export_xlsx(db(), set_id)
        filename = f"teachqrs-questions-{qset['id']}.xlsx"
        return Response(
            body,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )

    @app.post("/teacher/sessions")
    def start_new_session(
        request: Request,
        set_id: int = Form(...),
        name: str = Form(...),
        mode: str = Form("interactive"),
        subclass_ids: list[int] | None = Form(None),
    ):
        require_teacher(request)
        if isinstance(subclass_ids, int):
            subclass_ids = [subclass_ids]
        subclass_ids = subclass_ids or []
        try:
            session = create_session(db(), set_id, name, subclass_ids, mode=mode)
            start_session(db(), session["id"])
        except SessionError as exc:
            return flash_redirect("/teacher", str(exc), True)
        return RedirectResponse(f"/live/{session['id']}", status_code=303)

    @app.get("/live/{session_id}", response_class=HTMLResponse)
    def live_view(request: Request, session_id: int):
        require_teacher(request)
        session = session_row(session_id)
        qset = set_row(session["set_id"])
        subclasses = allowed_subclasses(session_id)
        questions = questions_for_set(session["set_id"], visible_only=True)
        join_url = f"{public_base_url(request)}/j/{session['join_code']}"
        return html(
            request,
            "teacher/live.html",
            session=session,
            qset=qset,
            subclasses=subclasses,
            questions=questions,
            join_url=join_url,
        )

    @app.post("/live/{session_id}/open")
    def live_open(request: Request, session_id: int):
        require_teacher(request)
        open_question(db(), session_id)
        return RedirectResponse(f"/live/{session_id}", status_code=303)

    @app.post("/live/{session_id}/close-question")
    def live_close_q(request: Request, session_id: int):
        require_teacher(request)
        close_question(db(), session_id)
        return RedirectResponse(f"/live/{session_id}", status_code=303)

    @app.post("/live/{session_id}/reopen")
    def live_reopen(request: Request, session_id: int):
        require_teacher(request)
        reopen_for_discussion(db(), session_id)
        return RedirectResponse(f"/live/{session_id}", status_code=303)

    @app.post("/live/{session_id}/next")
    def live_next(request: Request, session_id: int, direction: str = Form("next")):
        require_teacher(request)
        next_question(db(), session_id, step=1 if direction == "next" else -1)
        return RedirectResponse(f"/live/{session_id}", status_code=303)

    @app.post("/live/{session_id}/close")
    def live_close(request: Request, session_id: int):
        require_teacher(request)
        close_session(db(), session_id)
        return RedirectResponse(f"/live/{session_id}", status_code=303)

    @app.post("/live/{session_id}/reset")
    def live_reset(request: Request, session_id: int):
        require_teacher(request)
        reset_session_responses(db(), session_id)
        start_session(db(), session_id)
        return RedirectResponse(f"/live/{session_id}", status_code=303)

    @app.get("/live/{session_id}/qr.png")
    def live_qr(request: Request, session_id: int):
        require_teacher(request)
        session = session_row(session_id)
        url = f"{public_base_url(request)}/j/{session['join_code']}"
        img = qrcode.make(url)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return Response(buf.getvalue(), media_type="image/png")

    @app.get("/teacher/sessions/{session_id}/export.csv")
    def export_session_csv(request: Request, session_id: int):
        require_teacher(request)
        session = session_row(session_id)
        body = export_responses_csv(db(), session_id)
        filename = f"teachqrs-responses-{session['join_code']}.csv"
        return Response(body, media_type="text/csv", headers={"Content-Disposition": f"attachment; filename={filename}"})

    @app.get("/api/live/{session_id}")
    def api_live(request: Request, session_id: int, subclass_id: int | None = None):
        require_teacher(request)
        session = session_row(session_id)
        qid = session["current_question_id"]
        results = results_for_question(db(), session_id, qid, subclass_id=subclass_id) if qid else None
        if results and results.get("question"):
            results["question"]["choices"] = json.loads(results["question"].get("choices_json") or "[]")
        subclasses = [dict(s) for s in allowed_subclasses(session_id)]
        return {
            "session": dict(session),
            "subclasses": subclasses,
            "results": results,
            "join_code": session["join_code"],
        }

    @app.get("/j/{code}", response_class=HTMLResponse)
    def student_welcome(request: Request, code: str):
        session = session_by_code(code)
        qset = set_row(session["set_id"])
        subclasses = allowed_subclasses(session["id"])
        payload = student_payload(request)
        already = (
            payload
            and payload.get("session_id") == session["id"]
            and payload.get("student_number")
        )
        if already and session["status"] == "live":
            return RedirectResponse(f"/j/{session['join_code']}/play", status_code=303)
        return html(
            request,
            "student/welcome.html",
            session=session,
            qset=qset,
            subclasses=subclasses,
        )

    @app.post("/j/{code}/join")
    def student_join(
        request: Request,
        code: str,
        student_number: str = Form(""),
        subclass_id: int | None = Form(None),
    ):
        session = session_by_code(code)
        subclasses = allowed_subclasses(session["id"])
        if not subclasses:
            return flash_redirect(f"/j/{session['join_code']}", "This session has no subclass.", True)
        if subclass_id is None:
            if len(subclasses) == 1:
                subclass_id = subclasses[0]["id"]
            else:
                return flash_redirect(f"/j/{session['join_code']}", "Choose your subclass.", True)
        try:
            validate_student_number(student_number)
            participant = join_session(db(), session["id"], student_number, subclass_id)
        except (IdentityError, SessionError) as exc:
            return flash_redirect(f"/j/{session['join_code']}", str(exc), True)
        response = RedirectResponse(f"/j/{session['join_code']}/play", status_code=303)
        response.set_cookie(
            COOKIE_STUDENT,
            dumps(
                app.state.signer,
                {
                    "session_id": session["id"],
                    "student_number": participant["student_number"],
                    "subclass_id": participant["subclass_id"],
                },
            ),
            httponly=True,
            samesite="lax",
        )
        return response

    def require_student(request: Request, session) -> dict:
        payload = student_payload(request)
        if (
            not payload
            or payload.get("session_id") != session["id"]
            or not payload.get("student_number")
        ):
            raise HTTPException(status_code=303, headers={"Location": f"/j/{session['join_code']}"})
        return payload

    @app.get("/j/{code}/play", response_class=HTMLResponse)
    def student_play(request: Request, code: str):
        session = session_by_code(code)
        qset = set_row(session["set_id"])
        if session["status"] != "live":
            return html(request, "student/thanks.html", session=session, qset=qset)
        payload = require_student(request, session)
        questions = questions_for_set(session["set_id"], visible_only=True)
        parsed = []
        for q in questions:
            item = dict(q)
            item["choices"] = json.loads(q["choices_json"] or "[]")
            parsed.append(item)
        mine = db().execute(
            """
            SELECT question_id, value, round FROM responses
            WHERE session_id = ? AND student_number = ?
            """,
            (session["id"], payload["student_number"]),
        ).fetchall()
        answers = {}
        for row in mine:
            key = row["question_id"]
            prev = answers.get(key)
            if prev is None or row["round"] >= prev["round"]:
                answers[key] = dict(row)
        return html(
            request,
            "student/play.html",
            session=session,
            qset=qset,
            questions=parsed,
            answers=answers,
            student_number=payload["student_number"],
        )

    @app.post("/j/{code}/answer")
    def student_answer(
        request: Request,
        code: str,
        question_id: int = Form(...),
        value: str = Form(...),
    ):
        session = session_by_code(code)
        payload = require_student(request, session)
        try:
            submit_response(db(), session["id"], question_id, payload["student_number"], value)
        except (IdentityError, SessionError) as exc:
            return flash_redirect(f"/j/{session['join_code']}/play", str(exc), True)
        return RedirectResponse(f"/j/{session['join_code']}/play", status_code=303)

    @app.get("/api/j/{code}/state")
    def student_state(request: Request, code: str):
        session = session_by_code(code)
        payload = student_payload(request)
        identified = bool(payload and payload.get("session_id") == session["id"] and payload.get("student_number"))
        return {
            "identified": identified,
            "status": session["status"],
            "mode": session["mode"],
            "collecting": bool(session["collecting"]),
            "current_question_id": session["current_question_id"],
            "reveal_results": bool(session["reveal_results"]),
            "current_round": session["current_round"],
        }

    @app.get("/api/session/{code}/questions")
    def student_questions_api(request: Request, code: str):
        session = session_by_code(code)
        payload = student_payload(request)
        if not payload or payload.get("session_id") != session["id"] or not payload.get("student_number"):
            raise HTTPException(401, "Student number required before questions are shown.")
        questions = questions_for_set(session["set_id"], visible_only=True)
        out = []
        for q in questions:
            item = dict(q)
            item["choices"] = json.loads(q["choices_json"] or "[]")
            if session["mode"] == "interactive" and q["id"] != session["current_question_id"]:
                continue
            out.append(item)
        return {"questions": out}

    @app.exception_handler(HTTPException)
    async def http_exc(request: Request, exc: HTTPException):
        if exc.status_code == 303 and exc.headers and "Location" in exc.headers:
            return RedirectResponse(exc.headers["Location"], status_code=303)
        if exc.status_code == 401:
            return Response(exc.detail, status_code=401)
        if exc.status_code == 404:
            return html(request, "error.html", status=404, message=exc.detail or "Not found")
        return HTMLResponse(exc.detail or "Error", status_code=exc.status_code)

    return app


app = create_app()
