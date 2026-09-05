# TeachQRS Design Spec

**Date:** 2026-09-05  
**Product:** TeachQRS — a teacher-owned Quick Response System  
**Source of truth for original behaviour:** Hang Seng University QRS 2.0 user guide (May 2026)

This spec is locked for a first teaching-ready release. Assumptions are explicit so the app can be built without further product questions.

---

## 1. Problem

Institution QRS tools (HSU QRS 2.0) let a teacher start a live session, show a QR code, collect phone answers, and export a chart. They are tied to campus login, weak on student identity, and clumsy when the same questions must be reused across tutorial groups.

TeachQRS is a standalone classroom clicker the teacher runs for their own courses. It copies the live QR session flow and improves the parts that actually matter for teaching: **who answered**, **which subclass they belong to**, **reusable question banks**, and **clean import/export**.

## 2. Goals

1. A teacher can run a live in-class poll from a laptop projector in under a minute.
2. Students cannot see or answer a question until they enter a **student number**.
3. One **question set** can be used by many **subclasses** without duplicating questions.
4. Questions import and export via **CSV and Excel**.
5. Responses export via **CSV** (identity, subclass, answer, correctness, timestamps).
6. Live results are visible per subclass and combined, so the teacher can see who is lost.

Success for v1: a teacher imports a CSV, starts a session for two subclasses, students join by QR, each must enter a student number, answers appear on the projector, and a CSV download matches the live counts.

## 3. Users and jobs

| Role | Job |
|---|---|
| Teacher | Build or import a question set, start/stop a session, show QR on projector, watch live bars, close the item, optionally reopen for a discussion revote, export results |
| Student (phone) | Scan QR or type join code, enter student number (required), pick subclass if more than one is allowed, answer, change answer until the teacher closes that item |

Single-teacher tool. No campus SSO. First visit creates a local teacher password stored as a hash in SQLite.

## 4. What we copy from HSU QRS 2.0

- Teacher admin vs student join URL
- Session with a short join code and QR
- Welcome page then questions
- Start / close (open-close) a live session
- Students may change an answer before the item is closed
- Live submission count
- Bar-chart results after close (and live while open, for the teacher)
- Reset results, hide a question, reorder questions
- Survey mode (all visible questions at once) and Interactive mode (teacher-paced, one question)
- Welcome and thank-you messages
- Excel-style results export (we use CSV as the primary export, Excel optional for questions)

## 5. What we deliberately improve

These are the effectiveness changes, not decorations.

1. **Student-number gate.** Join is blocked until a non-empty student number is submitted. The number is stored on every response. This is the difference between a toy poll and something you can mark, chase absences, or review misconceptions by person.
2. **Question set ≠ subclass.** Questions live in a reusable set. A live session binds that set to one or more subclasses. Students in T01 and T02 answer the same items; results filter by subclass without copying the quiz.
3. **CSV/Excel question import** with a downloadable template, so existing quiz banks drop in.
4. **Question export** in the same schema as import (round-trip).
5. **Response CSV** with student number, subclass, round, answer, correctness, timestamps.
6. **Teacher-paced default.** Interactive mode waits on one question, shows live count, then reveals the distribution. This is better pedagogy than dumping a form.
7. **Peer-instruction revote.** After close, teacher can “Reopen for discussion”. First and final rounds are both stored. Export includes `round`.
8. **Optional correct answer.** If set, export includes `is_correct` and the teacher can show the key after close. If unset, the item is a survey.
9. **Per-subclass live counts** on the projector (tabs: All / each subclass).
10. **LAN-aware join URL.** Projector shows the reachable URL (not `localhost`) so phone QR codes work on classroom WiFi.

### Out of scope for v1

University SSO, lucky draw, custom logo upload, Moodle LTI, multi-teacher accounts, rosters-as-access-control, rich-media questions, accounts for students.

## 6. Approaches considered

### A. Python FastAPI + Jinja + SQLite (recommended)

One process the teacher starts with `python -m app`. Data stays in a local file. Easy for an academic machine. Phones join over classroom LAN or any host the teacher publishes. Matches “I own this tool.”

**Trade-off:** the teacher must keep the process running during class. No serverless magic.

### B. Next.js + hosted database

Polished UI and easy Vercel deploy, but SQLite does not persist on serverless. Needs Postgres/Turso. More moving parts for a single instructor.

### C. Cloudflare Workers + Durable Objects

Excellent for concurrent live rooms and a public URL. Requires a Cloudflare account and is harder to inspect or modify locally.

**Decision:** Approach A. Optional Dockerfile so it can later run on a VPS or a Space. No cloud vendor required for class tomorrow.

## 7. Information architecture

```
Teacher password (first-run)
  └── Question sets
        └── Questions (ordered, hideable)
  └── Subclasses (T01, T02, Lecture, …)
  └── Live sessions
        ├── binds one question set
        ├── allows one or more subclasses
        ├── join_code (4 chars) + status (draft|live|closed)
        ├── current question (interactive mode)
        ├── participants (student_number + subclass)
        └── responses (per question, per student, per round)
```

A **session** is the unit students join. A **question set** is the reusable exam paper. A **subclass** is a label students must choose (or are assigned if the session allows only one).

## 8. Data model

SQLite, WAL mode, foreign keys on.

**teachers** — `id`, `password_hash`, `created_at`  
**subclasses** — `id`, `name`, `code` (short label), `created_at`  
**question_sets** — `id`, `title`, `welcome_message`, `thanks_message`, `mode` (`survey` | `interactive`), `created_at`  
**questions** — `id`, `set_id`, `position`, `prompt`, `type` (`mcq` | `true_false` | `short`), `choices_json`, `correct` (nullable), `points`, `visible`  
**sessions** — `id`, `set_id`, `name`, `join_code` unique, `status`, `current_question_id`, `reveal_results` bool, `created_at`, `started_at`, `closed_at`  
**session_subclasses** — `session_id`, `subclass_id`  
**participants** — `session_id`, `student_number`, `subclass_id`, `joined_at`; unique `(session_id, student_number)`  
**responses** — `session_id`, `question_id`, `student_number`, `subclass_id`, `value`, `round` int default 1, `is_correct` nullable, `created_at`, `updated_at`; unique `(session_id, question_id, student_number, round)`

Student number rules:

- Trimmed, 3–20 characters, letters/digits/`-`/`_` only
- Required before any question is shown
- One participant row per student per session; they cannot switch subclass after joining
- Same student number answering again on an open question updates that round’s `value` (last write wins)

## 9. Question CSV / Excel schema

Header row required. Extra columns ignored. Empty `correct` means survey item.

```
question_number,prompt,type,choice_a,choice_b,choice_c,choice_d,choice_e,correct,points
1,"What is 2+2?",mcq,2,3,4,5,,C,1
2,"Python is used only for snakes.",true_false,,,,,false,1
3,"Name one conservation law.",short,,,,,,1
```

- `type`: `mcq` | `true_false` | `short` (default `mcq`)
- `correct` for mcq: `A`–`E`; for true/false: `true`/`false`/`T`/`F`; for short: optional exact match (case-insensitive)
- Excel is the same columns, first sheet
- Export questions uses this exact header so round-trip import works
- Invalid rows are collected and shown; valid rows still import

## 10. Response CSV schema

```
session_name,join_code,subclass,student_number,question_number,prompt,type,response,correct_answer,is_correct,round,submitted_at,updated_at
```

One row per response (so a revote produces two rows). Filename: `teachqrs-responses-{join_code}-{date}.csv`.

## 11. Core flows

### Teacher — first run

1. Open `/teacher` → set password → cookie session.
2. Dashboard: question sets, subclasses, live/recent sessions.

### Teacher — prepare

1. Create subclasses (e.g. T01, T02).
2. Create a question set, or import CSV/Excel.
3. Edit/reorder/hide questions. Export the set at any time.

### Teacher — live class

1. **Start session:** name, question set, one or more subclasses, mode inherited from set but overridable.
2. Projector `/live/{id}`: huge join code, QR, URL, participant count, per-subclass counts.
3. Interactive: show current prompt on projector; Open answers → students submit; Close item → reveal bars (and key if present); optional Reopen for discussion (round += 1).
4. Survey: all visible questions available until the teacher closes the session.
5. Close session → students see thank-you. Export CSV.

### Student

1. `/j/{code}` from QR or typed code.
2. Welcome message.
3. Form: **Student number (required)** and **Subclass** (hidden and auto-set if only one allowed).
4. Submit identity → cookie for this session → questions.
5. Cannot proceed with blank/invalid number. Duplicate number in the same session resumes that participant (same subclass), it does not create a second identity.
6. After finish or session close: thank-you.

## 12. Architecture

```
Browser (teacher projector) ──┐
Browser (teacher admin)  ─────┼── FastAPI + Jinja + static JS
Browser (student phones) ─────┘
                │
         SQLite (WAL) teachqrs.db
```

- Server-rendered HTML for reliability on bad campus WiFi
- Tiny JS: 1.2s polling on live projector and student wait-for-next-question
- QR generated server-side as PNG (or SVG) from the LAN-aware base URL
- Auth: signed HTTP-only cookie; `TEACHQRS_SECRET` from env with a generated fallback stored in db
- Bind `0.0.0.0` by default; projector computes join URL from `X-Forwarded-Host` or request host, never `127.0.0.1` if a public/LAN host is present

Modules (one job each):

| Module | Job |
|---|---|
| `app/db.py` | Connection, schema, migrations |
| `app/models.py` | Typed row helpers / SQL |
| `app/auth.py` | Password hash, cookie |
| `app/identity.py` | Student-number validation and participant upsert |
| `app/questions_io.py` | CSV/Excel import and question export |
| `app/responses_io.py` | Response CSV export |
| `app/sessions.py` | Start/open/close/reveal/revote |
| `app/main.py` | App factory and routes |
| `app/templates/` | Teacher, live, student |
| `app/static/` | CSS and poll JS |

## 13. UI principles (classroom, not dashboard-saas)

- Projector: very large type, high contrast, a red LIVE pill, bars that read from the back row
- Phone: one column, 48px+ tap targets, student number is the first and blocking control
- Teacher admin: dense but plain — lists, not cards-for-cards’-sake
- Colour: ink navy `#1b2430`, paper `#f6f1e8`, live coral `#d64545`, go green `#2f6f4e`. No purple gradients, no Inter-on-white generic AI look.

## 14. Error handling

- Unknown join code → “Session not found or not live”
- Session closed → thank-you, no answers
- Hidden question → skipped
- Import errors → row-level messages, partial import
- Duplicate join codes → retry generation
- Empty question set cannot start
- Session with zero subclasses cannot start

## 15. Testing

Automated (pytest, no browser required):

- Student number rejected if blank, too short, or illegal charset
- Questions are not returned until a participant exists
- Same question set, two subclasses: responses do not leak across subclass filters
- CSV import creates questions; export round-trips
- Excel import of the same table matches CSV
- Response export contains student_number and subclass
- Revote stores round 1 and round 2
- Changing an open answer updates `updated_at` and does not add a row

Manual / browser after implementation:

- Teacher first-run password
- Import sample CSV
- Start session for two subclasses
- Join on a phone-sized viewport, blocked without student number
- Live bars update
- Download response CSV

## 16. Run and data location

```
cd teachqrs
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m app --host 0.0.0.0 --port 8765
```

Database file: `./data/teachqrs.db` (gitignored). Sample bank: `sample_data/questions.csv`.

---

**Locked decisions:** FastAPI+SQLite, required student numbers, reusable sets × subclasses, CSV+Excel questions, CSV responses, interactive+survey, peer-instruction revote, no SSO/lucky-draw/LTI in v1.
