# Phase 10: Bug fixes & signal handling ✅

**Goal**: Fix the four issues discovered during manual hardware testing.

**Status**: Implemented with 16 tests.  StatusMessage protocol added to both repos,
r2d2 sends lifecycle events (recording_started/stopped, episode_finalized,
watchdog_triggered, cycle_overrun), c3po ingests and logs them with optional
on_status callback.  SIGTERM handler added for graceful shutdown with torque
disable.  Health check noise suppressed.  Connect/disconnect logging added.

Key bugs fixed during implementation:
- DatasetRecorder camera_buffers now initialized in __init__ (was empty dict)
- ResetEpisode captures frame_count before start_episode() resets it
- StopRecording uses saved _recording_name (StopRecording has no .name field)
- Cycle overrun rate limiter starts at time.monotonic() (was 0.0)
- _disconnect_hardware is async with serial buffer flush
- SIGTERM handled via loop.add_signal_handler (not just KeyboardInterrupt)

#### Task 10.1: Protocol — add StatusMessage for server→client notifications (3 tests)

**Files**: ADAPT `c3po/src/c3po/_protocol.py`, ADAPT `r2d2/src/r2d2/_protocol.py`

- Add a `StatusMessage` dataclass for asynchronous server→client updates:
  ```python
  @dataclass
  class StatusMessage:
      event: str        # "episode_finalized", "recording_started", "watchdog_triggered", ...
      message: str      # human-readable description
      data: dict[str, Any] = field(default_factory=dict)
      type: str = field(default="status", init=False)
  ```
- Register in `_MESSAGE_REGISTRY`.
- Events defined:
  - `episode_finalized` — `end_episode()` completed (payload: `{episode_index, frame_count, duration_ms}`)
  - `recording_started` — `start_recording` received (payload: `{dataset_name}`)
  - `recording_stopped` — `stop_recording` received (payload: `{dataset_name, total_episodes, total_frames, size_bytes}`)
  - `watchdog_triggered` — watchdog fired (payload: `{seconds_since_last_action}`)
  - `cycle_overrun` — control cycle exceeded period (payload: `{elapsed_ms, period_ms}`)
- **Tests**: encode/decode roundtrip, event string validation, optional data roundtrip.

#### Task 10.2: r2d2 — send StatusMessage for key lifecycle events (5 tests)

**Files**: ADAPT `r2d2/src/r2d2/_server.py`

- `_recv_loop`: after `end_episode()` completes, send `StatusMessage(event="episode_finalized", ...)`
- `_recv_loop`: on `start_recording` / `stop_recording`, send status messages
- Control loop: after watchdog triggers, send `StatusMessage(event="watchdog_triggered", ...)`
- Control loop: on cycle overrun, send `StatusMessage(event="cycle_overrun", ...)` (rate-limited to once per 10s)
- **Tests**: status sent on episode finalization, status sent on recording start/stop,
  status sent on watchdog trigger, cycle overrun status rate-limited,
  status NOT sent when recording not active.

#### Task 10.3: c3po — ingest and log StatusMessage (2 tests)

**Files**: ADAPT `c3po/src/c3po/robot.py`

- `_ingest()`: handle `StatusMessage` — log at appropriate level (info for lifecycle,
  warning for watchdog, debug for overrun).
- Expose a `on_status` callback property so the researcher can hook custom behavior:
  ```python
  robot.on_status = lambda event, message, data: print(f"[{event}] {message}")
  ```
- **Tests**: status logged at correct level, callback invoked when set.

#### Task 10.4: r2d2 — fix torque-on-disconnect with proper SIGTERM handling (4 tests)

**Files**: ADAPT `r2d2/src/r2d2/_server.py`

- Make `_disconnect_hardware` async — add `await asyncio.sleep(0.1)` after
  `robot.disconnect()` to let the serial buffer flush before the event loop closes.
- Add explicit `SIGTERM` handler in `main()` using `loop.add_signal_handler()`
  so Docker stops trigger graceful shutdown (not just `KeyboardInterrupt`).
- Log "Shutting down — disabling motor torque" during disconnect.
- **Tests**: `_disconnect_hardware` calls `robot.disconnect()`, async sleep after
  disconnect, SIGTERM handler registered, disconnect logged.

#### Task 10.5: r2d2 — suppress health check log spam + add connect/disconnect logs (2 tests)

**Files**: ADAPT `r2d2/src/r2d2/_server.py`

- Set `websockets` logger to WARNING level at server startup.
- In `_handler`: log "c3po client connected" on successful describe handshake.
- In `_handler` finally: log "c3po client disconnected".
- **Tests**: health check probe does not produce ERROR log, connect message appears
  after handshake, disconnect message appears on close.

#### Task 10.6: c3po — better rate reporting in logs (1 test)

**Files**: ADAPT `c3po/src/c3po/robot.py`

- On `reset()`, log the station's configured and effective control rates from manifest.
- Track `step()` call intervals and log a warning if the policy loop is slower
  than the control rate (i.e., the researcher's policy is the bottleneck).
- **Tests**: rate info logged on reset, slow-loop warning triggered.

---
