# TeachQRS

A teacher-owned **Quick Response System** for live classes. Students join from their phones with a QR code, **must enter a student number before any question is shown**, and can sit in different subclasses while answering the **same question set**.

This is a standalone replica of the HSU QRS classroom flow, with a stricter identity gate and proper import/export so you can run it for your own teaching without campus SSO.

## What it does

- Teacher projector: join code, QR, live bars, per-subclass filter
- Interactive mode (one question at a time) or survey mode (all at once)
- Peer-instruction **reopen for discussion** (round 1 and round 2 are both stored)
- Import questions from **CSV or Excel**; export the set the same way
- Export responses as **CSV** (student number, subclass, answer, correctness, round, timestamps)

## Run

Python 3.11+.

```bash
cd teachqrs
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m app
```

Open [http://127.0.0.1:8765/teacher](http://127.0.0.1:8765/teacher). First visit sets a local teacher password. The projector QR uses your LAN address when you open the live view as `localhost`, so phones on classroom Wi-Fi can join.

Default bind: `0.0.0.0:8765`. Override with `TEACHQRS_HOST` / `TEACHQRS_PORT`. Database file: `data/teachqrs.db` (gitignored).

## Classroom path

1. Add subclasses (`T01`, `T02`, …).
2. Create a question set. Import `sample_data/questions.csv` or download the template from the set page.
3. Start a live session, pick the set and the subclasses that may join.
4. Put the projector page on the screen. Students scan the QR, enter a **student number**, pick a subclass if more than one is allowed, then answer.
5. Close the item to reveal the distribution. Optionally reopen after peer discussion.
6. Download **Export CSV** when the session ends.

## Question file format

Header (required):

```
question_number,prompt,type,choice_a,choice_b,choice_c,choice_d,choice_e,correct,points
```

`type` is `mcq`, `true_false`, or `short`. Leave `correct` blank for an ungraded survey item. Excel uses the same columns on the first sheet.

## Response CSV

```
session_name,join_code,subclass,student_number,question_number,prompt,type,response,correct_answer,is_correct,round,submitted_at,updated_at
```

## Tests

```bash
pytest -q
```

## Design

See `docs/superpowers/specs/2026-09-05-teachqrs-design.md`.
