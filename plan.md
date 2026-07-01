# Implementation Plan

### Phase 0: Foundation (pre-coding) ✅

**Task 0.1: Set up LeRobot**

- Clone LeRobot v0.5.1 via `git clone --branch v0.5.1 --depth 1`
- Create and apply `patches/types-no-torch.patch` (only one patch needed — v0.5.1 has no `utils/__init__.py`)
- Verify: `from lerobot.motors.feetech import FeetechMotorsBus` imports without torch

**Task 0.2: Prune dead code**

- DELETE all ROS 2 nodes, launch files, `c3po_msgs/`, vendored LeRobot code, DHCP script, old config files, custom adapters, old c3po recorder/lerobot modules
- ADAPT: `__init__.py` files to remove deleted exports
- Verify: `grep -r "rclpy\|rosbridge\|c3po_msgs"` returns nothing

### Phase 1: Protocol spec + mock infrastructure ✅

**Task 1.1: Protocol types** (14 tests)

- New `c3po/src/c3po/_protocol.py` — 7 message dataclasses + JSON encode/decode + binary frame encode/decode
- Duplicated to `r2d2/src/r2d2/_protocol.py`

**Task 1.2: Mock r2d2 server for c3po tests** (7 tests)

- Rewrote `c3po/tests/conftest.py` — `MockR2D2Server` speaking custom protocol

### Phase 2: c3po transport + robot ✅

**Task 2.1: Rewrite transport** (9 tests)

- REWRITE `_transport/_base.py`, `_transport/_websocket.py` — custom protocol

**Task 2.2: Adapt buffer** (12 tests: 9 existing + 3 JPEG)

- ADAPT `_buffer.py` — add `update_from_frame()` for JPEG decode via Pillow

**Task 2.3: Adapt manifest parser** (16 tests)

- ADAPT `_manifest.py` — accept manifest dict directly, remove rosbridge wrapping

**Task 2.4: Rewrite Robot class** (20 tests)

- REWRITE `robot.py` — new transport, blocking `step()`, recording commands

### Phase 3: r2d2 server ✅

**Task 3.1: Adapt manifest builder** (11 tests)

- ADAPT `_manifest.py` — toy manifest returns 1 arm + 1 camera

**Task 3.2–3.3: Server + protocol handler** (8 tests)

- New `_server.py` — asyncio server with `_ToySensor`, `_handler`, `create_server()`, `main()`

### Phase 4: c3po recording + keyboard ← CURRENT

**Task 4.1: Write keyboard listener** (TDD — 5 tests)

- New `_keyboard.py` — `KeyboardListener`, pure stdlib on Unix (termios/tty/select)
- Captures: q (stop), n (next episode), r (re-record)
- Context manager restores terminal settings. Windows: graceful no-op.

**Task 4.2: Write recording context manager** (TDD — 10 tests)

- New `_recording.py` — `Recording` class, `robot.recording()` convenience method
- start_recording on enter, stop_recording on exit, keyboard flags

### Phase 5: r2d2 recording + safety

**Task 5.1: Write LeRobot v3.0 dataset writer** (TDD — 13 tests)

- New `_recording.py` — `DatasetRecorder`, parquet + MP4 via pyarrow + opencv

**Task 5.2: Write command watchdog** (TDD — 6 tests)

- New `_safety.py` — `Watchdog` class, integrated into control loop

### Phase 6: Integration + docs

**Task 6.1: Dockerfile** — `python:3.12-slim` multi-stage, git clone v0.5.1, hardware deps only
**Task 6.2: End-to-end tests** (10 integration tests)
**Task 6.3: Config files, pyproject.toml updates, READMEs**

---

### Test totals (so far)

| Phase             | Tests                                                 |
| ----------------- | ----------------------------------------------------- |
| Phase 1           | 21 (14 protocol + 7 mock)                             |
| Phase 2           | 57 (9 transport + 12 buffer + 16 manifest + 20 robot) |
| Phase 3           | 19 (11 manifest + 8 server)                           |
| **Running total** | **97**                                                |
