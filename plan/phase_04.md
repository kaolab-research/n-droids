# Phase 04: (recovered from git history)

> **Provenance**: this file was recovered from commit `cab8424e`
> (2026-07-01 11:58:40 -0700) — the planning record at that point in the project's
> history.  It is kept for its notes and learning points; the
> current status line below reflects today's plan.

**Current status**: `Phase 4: c3po recording + keyboard ✅ (18 tests, 2 skipped)`

---

# Phase 04: (historical plan) c3po recording + keyboard ← CURRENT

**Task 4.1: Write keyboard listener** (TDD — 5 tests)

- New `_keyboard.py` — `KeyboardListener`, pure stdlib on Unix (termios/tty/select)
- Captures: q (stop), n (next episode), r (re-record)
- Context manager restores terminal settings. Windows: graceful no-op.

**Task 4.2: Write recording context manager** (TDD — 10 tests)

- New `_recording.py` — `Recording` class, `robot.recording()` convenience method
- start_recording on enter, stop_recording on exit, keyboard flags
