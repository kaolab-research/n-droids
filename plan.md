# Implementation Plan

### Phase 0: Foundation (pre-coding)

**Task 0.1: Initialize LeRobot submodule**
- `git submodule add https://github.com/huggingface/lerobot.git lerobot`
- Pin to a known-good commit
- Create and apply `patches/types-no-torch.patch`
- Verify: `python -c "from lerobot.motors.feetech import FeetechMotorsBus"` imports without torch

**Task 0.2: Prune dead code**
- DELETE all ROS 2 nodes, launch files, `c3po_msgs/`, vendored LeRobot code, DHCP script, old config files, custom adapters, old c3po recorder/lerobot modules
- ADAPT: `__init__.py` files to remove deleted exports
- Verify: `grep -r "rclpy\|rosbridge\|c3po_msgs"` returns nothing

### Phase 1: Protocol spec + mock infrastructure

**Task 1.1: Protocol types** (TDD — 13 tests)
- New `c3po/src/c3po/_protocol.py` — typed dataclasses + encode/decode
- Duplicate the same module at `r2d2/src/r2d2/_protocol.py` (they change rarely)

**Task 1.2: Mock r2d2 server for c3po tests** (7 tests)
- Rewrite `c3po/tests/conftest.py` — `MockR2D2Server` speaking custom protocol

### Phase 2: c3po transport + robot (no recording yet)

**Task 2.1: Rewrite transport** (TDD — 9 tests)
- REWRITE `_transport/_base.py`, `_transport/_websocket.py`
- New protocol: `send_json()`, `recv()`, binary frame support

**Task 2.2: Adapt buffer** (3 new tests + 9 existing)
- ADAPT `_buffer.py` — add JPEG decode support

**Task 2.3: Adapt manifest parser** (5 new tests + 8 adapted)
- ADAPT `_manifest.py` — remove rosbridge wrapping, accept manifest dict directly

**Task 2.4: Rewrite Robot class** (TDD — 17 tests)
- REWRITE `robot.py` — new transport, new timing (blocking `step()`), no recording methods yet
- ADAPT `exceptions.py` — add `ProtocolError`
- ADAPT `__init__.py` — remove deleted exports

### Phase 3: r2d2 server (toy mode)

**Task 3.1: Adapt manifest builder** (2 new tests + 9 existing)
- ADAPT `_manifest.py` — minor cleanup, add `_load_config()`

**Task 3.2: Write protocol handler** (TDD — 6 tests)
- New `_protocol.py` — async WebSocket handler per connection
- Clone c3po's `_protocol.py` types (or re-import) for binary frame encoding

**Task 3.3: Write server entry point** (TDD — 7 tests)
- REWRITE `_server.py` — asyncio server, toy mode with synthetic data
- Robot factory: maps `station.yaml` type strings to LeRobot classes

### Phase 4: c3po recording + keyboard

**Task 4.1: Write keyboard listener** (TDD — 7 tests)
- New `_keyboard.py` — TerminalKeyListener, pure stdlib, n/r/q

**Task 4.2: Write recording context manager** (TDD — 10 tests)
- REWRITE `_recording.py` — `Recording` class, `robot.recording()` method

### Phase 5: r2d2 recording + safety

**Task 5.1: Write LeRobot v3.0 dataset writer** (TDD — 13 tests)
- New `_recording.py` — `DatasetRecorder`, parquet + MP4 via pyarrow + opencv

**Task 5.2: Write command watchdog** (TDD — 6 tests)
- New `_safety.py` — `Watchdog` class, integrated into control loop

### Phase 6: Integration + Docker + docs

**Task 6.1: Dockerfile** — `python:3.12-slim`, LeRobot submodule, hardware deps only
**Task 6.2: End-to-end tests** (10 integration tests)
**Task 6.3: Config files, pyproject.toml updates, READMEs**

---

### Test total: ~80 tests (revised down from 131 after removing adapter tests)

### File delta: ~35 deleted, ~15 created/rewritten, ~5 adapted
