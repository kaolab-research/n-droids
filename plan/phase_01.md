# Phase 01: (recovered from git history)

> **Provenance**: this file was recovered from commit `cab8424e`
> (2026-07-01 11:58:40 -0700) — the planning record at that point in the project's
> history.  It is kept for its notes and learning points; the
> current status line below reflects today's plan.

**Current status**: `Phase 1: Protocol spec + mock infrastructure ✅ (21 tests)`

---

# Phase 01: (historical plan) Protocol spec + mock infrastructure ✅

**Task 1.1: Protocol types** (14 tests)

- New `c3po/src/c3po/_protocol.py` — 7 message dataclasses + JSON encode/decode + binary frame encode/decode
- Duplicated to `r2d2/src/r2d2/_protocol.py`

**Task 1.2: Mock r2d2 server for c3po tests** (7 tests)

- Rewrote `c3po/tests/conftest.py` — `MockR2D2Server` speaking custom protocol
