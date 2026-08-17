# Phase 02: (recovered from git history)

> **Provenance**: this file was recovered from commit `cab8424e`
> (2026-07-01 11:58:40 -0700) — the planning record at that point in the project's
> history.  It is kept for its notes and learning points; the
> current status line below reflects today's plan.

**Current status**: `Phase 2: c3po transport + robot ✅ (57 tests)`

---

# Phase 02: (historical plan) c3po transport + robot ✅

**Task 2.1: Rewrite transport** (9 tests)

- REWRITE `_transport/_base.py`, `_transport/_websocket.py` — custom protocol

**Task 2.2: Adapt buffer** (12 tests: 9 existing + 3 JPEG)

- ADAPT `_buffer.py` — add `update_from_frame()` for JPEG decode via Pillow

**Task 2.3: Adapt manifest parser** (16 tests)

- ADAPT `_manifest.py` — accept manifest dict directly, remove rosbridge wrapping

**Task 2.4: Rewrite Robot class** (20 tests)

- REWRITE `robot.py` — new transport, blocking `step()`, recording commands
