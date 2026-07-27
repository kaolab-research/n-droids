# Implementation Plan

### Phase 0: Foundation ✅
- Clone LeRobot v0.5.1, create torch-optional patch, prune dead code

### Phase 1: Protocol spec + mock infrastructure ✅ (21 tests)
- Protocol dataclasses + encode/decode, MockR2D2Server

### Phase 2: c3po transport + robot ✅ (57 tests)
- WebSocket transport, buffer, manifest parser, Robot class

### Phase 3: r2d2 server (toy mode) ✅ (19 tests)
- Manifest builder, asyncio server, _ToySensor

### Phase 4: c3po recording + keyboard ✅ (18 tests, 2 skipped)
- KeyboardListener (n/r/q), Recording context manager

### Phase 5: r2d2 recording + safety ✅ (17 tests)
- DatasetRecorder (parquet + MP4), Watchdog

### Phase 6: Integration + Docker + E2E ✅ (5 tests)
- Docker multi-stage build, end-to-end recording lifecycle

### Phase 7: SO-101 Hardware + UVC Camera ✅ (12 tests)
- Config loader, key mapping, hardware server mode, configurable rate
- **Proven**: leader→follower teleop, camera streaming, dataset recording

---

### Phase 8: Camera Transmission Pipeline ✅

**Status**: Implemented and tested.  Raw RGB/depth streaming with hash-based
deduplication, fully decoupled from control loop, JPEG encoding for recording
in thread pool, frame ID tracking for diagnostics.

**Design audit findings.** LeRobot already provides everything we need at the
capture layer: background capture threads per camera, `read_latest()` (instant
non-blocking peek), `latest_color_frame` / `latest_depth_frame` caches.  What
LeRobot does **not** provide is a non-blocking depth read (`read_depth_latest`
is explicitly marked "Missing implementation").  We fill this gap with
`_NonBlockingCamera`, a thin wrapper that routes `read()` → `read_latest()`
and `read_depth()` → direct cache access.

The fundamental issue discovered in Phase 8 is that JPEG/PNG encoding in the
control loop blocks action application for 50-150ms per cycle, throttling
teleop to ~9Hz.  The root cause: encoding 1280×720 frames takes longer than
the 20ms control cycle budget.

**New architecture.** Camera transmission is fully decoupled from the control
loop.  A single background asyncio task reads raw frames from LeRobot's cache
at the camera's native rate, sends raw numpy bytes (`arr.tobytes()`, a single
memcpy) when a new frame arrives, and skips when the frame hasn't changed.
The control loop at 50Hz only handles joint state, actions, and timing.

```
LeRobot bg threads (capture @ native rate)
       │ read_latest()  (instant)
       ▼
r2d2 _camera_send_loop  (background asyncio task)
       │ BinaryFrame(RAW_RGB, payload=tobytes(), frame_id)
       │ Only sends when frame changes (id() check)
       ▼
c3po buffer  (ObservationBuffer.get() reuses last frame naturally)
```

**Encoding.** Raw numpy is the default.  1280×720 RGB at 20Hz = 55 MB/s — 55%
of gigabit Ethernet.  At our scale (1-2 cameras, 640×480) it's 18-36 MB/s with
ample headroom.  JPEG encoding is preserved as a configurable fallback for
bandwidth-constrained deployments, behind the existing `Encoding` enum — no
architectural change needed.  Raw is zero-cost: `tobytes()` is a single memcpy
with no compression artifacts and no encode/decode CPU cost.

#### Task 8.1: Protocol — add raw encodings and frame ID (4 tests)

**Files**: ADAPT `c3po/src/c3po/_protocol.py`, ADAPT `r2d2/src/r2d2/_protocol.py`

- Add `Encoding.RAW_RGB = 3`, `Encoding.RAW_DEPTH = 4`
- Add `frame_id: int = 0` to `BinaryFrame` (uint32 in wire format, 4 bytes
  after the existing encoding byte)
- Update `encode_binary_frame()` / `decode_binary_frame()` for frame_id
- Keep `jpeg_bytes` field name (protocol stability), document that it holds
  raw payload for non-JPEG encodings
- **Tests**: encode/decode RAW_RGB roundtrip, RAW_DEPTH roundtrip, frame_id
  serialization, backward-compat with frames missing frame_id field

#### Task 8.2: r2d2 — camera send loop (5 tests)

**Files**: ADAPT `r2d2/src/r2d2/_server.py`

- Replace `_encode_loop` (JPEG encoding) with `_camera_send_loop` (raw send)
- Per camera: `arr = cam.read()` (wrapper → `read_latest()`, instant), if
  `id(arr) == last_id` skip, else `payload = arr.tobytes()`, build
  `BinaryFrame` with `RAW_RGB`, `frame_id` counter, send via WebSocket
- Same pattern for depth when `use_depth`: `RAW_DEPTH` with uint16 raw bytes
- Run at ~200Hz check rate (`asyncio.sleep(0.005)`) to minimize capture-to-
  send latency
- Send is non-blocking (asyncio WebSocket send)
- **Tests**: sends on new frame, skips repeated frame, frame_id increments,
  depth sends raw uint16, no send when camera not connected

#### Task 8.3: r2d2 — strip camera sending from control loop (3 tests)

**Files**: ADAPT `r2d2/src/r2d2/_server.py`

- Remove binary frame sending from hardware-mode control loop
- Control loop: consume action → `get_observation()` (joint state only,
  camera arrays read via `read_latest()` are instant and ignored) →
  teleop leader position → `send(Observation JSON)` → apply action →
  record if active → sleep
- Remove `cv2` import, `loop.run_in_executor`, `_encoded` dict, `_encoded_lock`
- **Tests**: observation JSON sent at 50Hz, action applied within period,
  no binary frames in control loop output

#### Task 8.4: r2d2 — adapt recording to raw frames (3 tests)

**Files**: ADAPT `r2d2/src/r2d2/_server.py`, ADAPT `r2d2/src/r2d2/_recording.py`

- Control loop passes raw numpy arrays from `le_obs` to `recorder.append_frame`
  (they're already in `le_obs` from `get_observation()`)
- `DatasetRecorder.append_frame()` accepts `np.ndarray | bytes` for
  `camera_frames` — already typed this way, minor adjustment to handle raw
  arrays in `end_episode` MP4 encoding
- JPEG encoding for recording happens in `end_episode` (finalization), not
  in the control loop — zero impact on teleop latency
- **Tests**: recording with raw arrays, MP4 output valid, depth in parquet

#### Task 8.5: c3po — handle raw encodings in buffer (4 tests)

**Files**: ADAPT `c3po/src/c3po/_protocol.py`, ADAPT `c3po/src/c3po/_buffer.py`

- `update_from_frame()`: `RAW_RGB` → `np.frombuffer(payload, dtype=np.uint8)
  .reshape(h, w, 3)`, `RAW_DEPTH` → `np.frombuffer(payload, dtype=np.uint16)
  .reshape(h, w)`
- Keep existing JPEG and PNG decode paths unchanged
- **Tests**: raw RGB decode produces correct shape/dtype, raw depth decode
  produces uint16, JPEG still works, unknown encoding raises ValueError

#### Task 8.6: c3po — frame ID tracking for diagnostics (2 tests)

**Files**: ADAPT `c3po/src/c3po/_buffer.py`

- Store `_last_frame_ids: dict[str, int]` in `ObservationBuffer`
- On `update_from_frame()`: if gap (`frame_id > last_id + 1`), log warning
  with camera name and count of dropped frames
- **Tests**: no warning on sequential IDs, warning on gap

#### Task 8.7: Integration — full smoke test (manual)

- SO-101 teleop + 1× UVC + 1× RealSense (RGB + depth) simultaneously
- Verify: 50Hz control loop (no Cycle overrun warnings), camera frames
  arrive at native rate, teleop responsive, recording produces valid
  parquet + MP4 with all cameras
- Verify: `use_depth: true` works — depth frames appear in c3po observations
  and in recorded dataset

---

---

### Robustness & Bugfix Pass ✅

**Completed**: Comprehensive audit and fix of all 🔴/🟠/🟡 issues across r2d2
and c3po.  25 issues identified, 23 fixed, 2 deferred.

Key fixes applied:
- **Double `asyncio.sleep`** removed — control loop was sleeping twice per
  cycle, halving the effective control rate and causing watchdog false-triggers.
- **`NameError` in finally block** — `loop` reference was out of scope when
  recording was active on disconnect.
- **`robot.disconnect()` on shutdown** — arms now release torque when r2d2
  stops (previously stayed rigid until physically unplugged).
- **Watchdog timeout** loosened from 3 to 10 cycles (60ms→200ms at 50Hz) to
  accommodate real-world policy computation latency.
- **`id()`-based frame dedup** replaced with `hash()`-based fingerprinting —
  immune to camera buffer reuse.
- **`action_from_protocol` bimanual fix** — added `arm_prefix` parameter so
  actions are correctly routed per-arm in multi-arm stations.
- **`_NonBlockingCamera.read_depth()`** guarded against LeRobot API changes.
- **`DatasetRecorder`** public `frame_count` property, `cancel_episode()` state
  fix, `_recording_frames` staleness fix (cleared after consumption).
- **`_config.py` lazy imports** — module now importable without LeRobot
  installed, enabling local test collection.
- **Launch scripts** unique container names per config.
- **`_mapping.py`** debug logging for missing joints (instead of silent 0.0).
- **`simulate_key()` test helper** added to `KeyboardListener`.
- **`DeprecationWarning`** eliminated in test cleanup (stored loop reference).
- **Protocol sync warning** added to both `_protocol.py` copies.
- **Toy arm name** changed from `""` to `"toy_arm"` for meaningful namespacing.
- **`await _disconnect_hardware`** fixed — was calling sync function with `await`.

Test totals unchanged: 141 passing (41 r2d2 + 100 c3po).

---

### Phase 9: Camera Streaming Resolution ✅
Ethernet by 2× (249 MB/s vs ~112 MB/s practical).  Some form of bandwidth
reduction is required for multi-camera stations — it is not optional.

Rather than per-camera encoding choices that burden the naive user
("should my wrist camera use JPEG or raw? what quality?"), we expose **one
number**: a streaming resolution cap.  Every camera is downscaled to fit
within this cap while preserving aspect ratio.  Recording uses full-resolution
frames from LeRobot — completely unaffected.

**User mental model.**  "Cameras record at full quality.  The live feed is at
a lower resolution so it fits over Ethernet.  If I need higher-res streaming,
I change one number."

**Bandwidth at common caps (3 cameras, raw RGB, 30fps):**

| Cap (max height) | Example dims (16:9) | Per camera | 3 cameras total | Fits gigabit? |
|---|---|---|---|---|
| 720p (no cap) | 1280×720 | 82.9 MB/s | 248.8 MB/s | ❌ |
| 480p | 854×480 | 36.9 MB/s | 110.8 MB/s | ✅ (98% util) |
| 480p (4:3) | 640×480 | 27.6 MB/s | 82.9 MB/s | ✅ (74% util) |
| 360p | 640×360 | 20.7 MB/s | 62.2 MB/s | ✅ (55% util) |

Default cap: **480p**.  Fits 3 cameras with comfortable headroom.  Matches
what most policies actually use (224×224 or 256×256 model input).  Power users
can bump to 720p for single-camera stations or accept JPEG fallback.

**No c3po protocol changes needed.**  The `BinaryFrame` header already carries
`width` and `height` of the actual payload (not the capture resolution).
c3po's `ObservationBuffer.update_from_frame()` already reshapes using
`frame.height` and `frame.width` — it auto-adapts to whatever size r2d2 sends.

#### Task 9.1: Station config — add `stream_max_height` (2 tests)

**Files**: ADAPT `r2d2/src/r2d2/_config.py`

- Add an optional `stream_max_height: int | None` field to `StationConfig`.
  `None` means no cap (stream at capture resolution).  Default: `480`.
- Parse from the top-level `stream_max_height` key in station YAML:
  ```yaml
  station_model: so101_teleop
  stream_max_height: 480  # default — can omit

  robot:
    type: so_follower
    cameras:
      front_rgb:
        type: opencv
        width: 640    # capture resolution (recording)
        height: 480
        fps: 30
        # stream_width: 320   # OPTIONAL per-camera override (advanced)
        # stream_height: 240
  ```
- Per-camera `stream_width` / `stream_height` override the global cap for
  that camera.  When set, the camera streams at exactly this resolution
  regardless of `stream_max_height`.  Default: absent (use global cap).
- Camera configs already parsed in `_make_camera_config` — add filtering
  for `stream_width` / `stream_height` there.
- **Tests**: config with `stream_max_height` parses, omitted defaults to 480,
  per-camera override takes precedence, `null` disables cap.

#### Task 9.2: `_NonBlockingCamera` — streaming resize (5 tests)

**Files**: ADAPT `r2d2/src/r2d2/_server.py`

- Add `stream_max_height: int | None` and `stream_width: int | None` /
  `stream_height: int | None` parameters to `_NonBlockingCamera.__init__`.
- In `read()`: after getting the frame (via `read_latest()` or `read()`),
  determine the target streaming dimensions:
  1. If per-camera `stream_width` and `stream_height` are set, use those.
  2. Else if `stream_max_height` is set and `frame.shape[0] > stream_max_height`:
     compute `new_w = int(frame.shape[1] * stream_max_height / frame.shape[0])`,
     `cv2.resize(frame, (new_w, stream_max_height))`.
  3. Else return the frame unchanged.
- `read_depth()`: same logic for depth frames (uint16, single-channel).
- The resize happens inside the wrapper — `_camera_send_loop` and the control
  loop are completely unaware.  They just call `cam.read()` and get whatever
  size comes out.
- `cv2.resize` with `INTER_LINEAR` on 720p→480p takes ~1-2ms — negligible
  compared to the 5ms check interval.
- **Tests**: resize when frame exceeds cap, no resize when under cap,
  per-camera override applied, aspect ratio preserved, depth resize produces
  correct uint16 output, no resize when cap is None.

#### Task 9.3: r2d2 — wire streaming config to cameras (3 tests)

**Files**: ADAPT `r2d2/src/r2d2/_server.py` (`create_server`)

- In hardware mode, after `robot.connect()` and before wrapping cameras:
  read `stream_max_height`, plus per-camera `stream_width`/`stream_height`
  from the station config.
- When constructing `_NonBlockingCamera` wrappers (line ~579):
  ```python
  cam_cfg = station.camera_configs.get(name)
  stream_w = getattr(cam_cfg, "stream_width", None)
  stream_h = getattr(cam_cfg, "stream_height", None)
  robot.cameras[name] = _NonBlockingCamera(
      cam,
      stream_max_height=station.stream_max_height,
      stream_width=stream_w,
      stream_height=stream_h,
  )
  ```
- In toy mode, `_ToySensor` is unaffected (its frames are already 64×64).
- **Tests**: camera wrapper receives stream config, toy mode ignores it,
  per-camera override is correctly passed to wrapper.

#### Task 9.4: Manifest — communicate stream resolution (2 tests)

**Files**: ADAPT `r2d2/src/r2d2/_server.py` (`create_server` manifest building)

- In each camera entry in the manifest, add an optional `stream_resolution`
  field:
  ```json
  {
    "name": "front_rgb",
    "resolution": [720, 1280],        // capture resolution
    "stream_resolution": [480, 854]   // actual streamed resolution (may differ)
  }
  ```
- If no downscaling occurs (capture == stream), omit `stream_resolution`
  or set it equal to `resolution`.
- This is purely informational — the researcher's code can check it.
  c3po does not need it for decoding (the `BinaryFrame` header is
  self-describing).
- **Tests**: manifest includes stream_resolution when cap is active, omitted
  when cap is None or camera is under cap, per-camera override reflected.

#### Task 9.5: c3po — expose stream resolution info (2 tests)

**Files**: ADAPT `c3po/src/c3po/_manifest.py`, ADAPT `c3po/src/c3po/robot.py`

- `parse_manifest()`: preserve `stream_resolution` on camera entries.
- Add a `camera_stream_info` property to `Robot`:
  ```python
  @property
  def camera_stream_info(self) -> dict[str, dict]:
      """Mapping from camera name to {capture_resolution, stream_resolution}."""
  ```
- This lets the researcher's code adapt: "I know my policy expects 224×224
  input — let me check if the stream resolution is sufficient."
- **Tests**: property returns correct info, stream_resolution equals capture
  when no cap, per-camera override reflected.

#### Task 9.6: Advanced — per-camera encoding override (3 tests)

**Files**: ADAPT `r2d2/src/r2d2/_config.py`, ADAPT `r2d2/src/r2d2/_server.py`

- Add an optional `stream_encoding` field per camera in station config:
  ```yaml
  cameras:
    wrist_rgb:
      type: opencv
      width: 640
      height: 480
      fps: 30
      stream_encoding: raw       # default — no change
    front_rgb:
      type: opencv
      width: 1280
      height: 720
      fps: 30
      stream_encoding: grayscale # send single-channel to save bandwidth
  ```
- Supported values: `"raw"` (default), `"grayscale"`, `"jpeg"`.
- `_NonBlockingCamera.read()` applies the encoding transform after
  (optional) resize:
  - `"grayscale"`: `cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)`, output shape
    `(h, w)` — use `Encoding.RAW_RGB`?  No — need a new encoding or just
    send as single-channel.  Simpler: send as 3-channel grayscale
    (R=G=B) so c3po doesn't need a new decode path.  But that doesn't save
    bandwidth...  Better: add `Encoding.GRAYSCALE = 5` to the protocol.
    Actually, the simplest path that requires zero c3po changes: encode
    as JPEG with `cv2.imencode` using `Encoding.JPEG_RGB`.  Grayscale
    JPEGs are typically 3-channel on decode anyway.
  - `"jpeg"`: `cv2.imencode(".jpg", cv2.cvtColor(arr, cv2.COLOR_RGB2BGR))`
    → `Encoding.JPEG_RGB`.
  - `"raw"`: existing `Encoding.RAW_RGB` behavior.
- `_camera_send_loop` already reads `Encoding` from the camera?  No — it
  hardcodes `Encoding.RAW_RGB`.  For this task, we let the wrapper
  communicate the encoding back to the send loop.  Simplest approach:
  the wrapper sets `self._stream_encoding` and the send loop reads it.
  Or: the wrapper stores the encoding alongside the frame data, and the
  send loop uses it.
- Actually, the cleanest approach: `_NonBlockingCamera` exposes a
  `stream_encoding` property, and `_camera_send_loop` uses it when
  building the `BinaryFrame`.  This is a 2-line change in the send loop.
- **Tests**: grayscale encoding produces 1-channel output, JPEG encoding
  produces valid JPEG bytes, raw encoding unchanged, unknown encoding
  falls back to raw.

#### Task 9.7: Update existing station configs (no new tests)

**Files**: ADAPT `r2d2/config/station.*.yaml`

- Add `stream_max_height: 480` as a commented default to the example config.
- All existing configs work without it (default applies).
- Add a new `station.so101.all_cams_720p.yaml` that sets
  `stream_max_height: null` for power users who want full-res streaming
  (with the understanding that 3 cameras at 720p requires JPEG).

#### Task 9.8: Integration — multi-camera bandwidth smoke test (manual)

- 3× RealSense at 720p capture, `stream_max_height: 480`.
- Verify: all 3 camera feeds arrive at c3po without dropped frames
  (check frame_id continuity in c3po logs).
- Verify: control loop maintains 50Hz (no overrun warnings).
- Verify: recorded dataset has full 720p frames (not 480p).
- Verify: bumping `stream_max_height` to `null` causes dropped frames
  as expected (demonstrates the bandwidth ceiling).

---

### Phase 10: Bug fixes & signal handling ✅

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

### Phase 11: Status protocol & runtime introspection ✅

**Goal**: Full-duplex status channel + `spec` request/response for live debugging.

#### Task 11.1: Protocol — add SpecRequest / SpecResponse (3 tests)

**Files**: ADAPT both `_protocol.py` files

```python
@dataclass
class SpecRequest:
    type: str = field(default="spec_request", init=False)

@dataclass
class SpecResponse:
    effective_control_rate: float
    uptime_seconds: float
    cameras: list[dict[str, Any]]
    recording: dict[str, Any] | None
    watchdog_trigger_count: int
    type: str = field(default="spec_response", init=False)
```

#### Task 11.2: r2d2 — serve spec requests with live metrics (4 tests)

- Track per-camera frame send count and drop count.
- Track effective control rate (rolling average over last 100 cycles).
- Respond to `SpecRequest` with current metrics.
- **Tests**: spec includes camera stats, spec includes recording state,
  effective rate is measured, uptime increments.

#### Task 11.3: c3po — Robot.spec() convenience method (2 tests)

- `robot.spec()` sends `SpecRequest`, returns parsed `SpecResponse`.
- Expose as a property-like method for one-shot debugging.
- **Tests**: spec returns expected keys, spec works mid-session.

---

### Recent Robustness Fixes ✅

**Camera failure resilience.**  When a USB camera disconnects mid-session,
the control loop and teleop now continue unaffected:

- `_NonBlockingCamera.read_latest()` added — delegates to `read()` so
  `get_observation()` gets the same blank-frame fallback as the camera send
  loop.  Previously a crashed OpenCV thread would raise `RuntimeError` on
  every control cycle, locking the follower arm.
- `get_observation()` error handler rate-limited to 1 log per 5 seconds;
  sends `camera_error` StatusMessage to c3po.
- Camera error status rate-limited to 1 per second per camera (was ~200/sec
  from the 200Hz check loop).

**Recording fixes.**  Several issues discovered during hardware testing:

- `Recording.clear()` now increments `_episode_count` only for non-discarded
  episodes (checks `rerecord` flag before clearing).  Discarded episodes
  (`r` key) reuse the same episode number.
- Keyboard `r` key now also sets `done = True` so the inner teleop loop
  exits immediately (previously required also pressing `n`).
- `CancelEpisode` sends `episode_discarded` StatusMessage so c3po logs
  "Episode discarded — redo from start".
- Watchdog timer reset on `ResetEpisode` so the user gets the full timeout
  window to start the next teleop session.
- `episode_ready` StatusMessage sent after episode finalization:
  "Episode N ready — begin teleop".

**Spec fixes.**  Runtime introspection improvements:

- `robot.spec()` now drains stale Observations/BinaryFrames before
  returning the `SpecResponse` (was returning the first queued message).
- `SpecResponse.__str__()` replaced fixed-width box-drawing table with
  plain text that adapts to any terminal width.

---

### Phase 12: Dataset forwarding over Ethernet ✅

**Goal**: Get datasets off the NUC and onto the inference machine with zero
friction, using the existing Ethernet link.  No cloud services, no auth tokens.

HTTP is the right mechanism: simplest possible server (Python stdlib), no
extra dependencies, point-to-point trusted link.

#### Task 12.1: r2d2 — HTTP file server on port 9091 (3 tests) ✅

**Files**: ADAPT `r2d2/src/r2d2/_server.py`

- Start a background `http.server.HTTPServer` on port 9091 serving `/datasets`.
  Read-only, directory listing enabled, binds `0.0.0.0` (accessible from the
  inference machine at `http://10.42.0.1:9091/datasets/`).
- Runs in a daemon thread alongside the WebSocket server — no asyncio
  integration needed for a simple file server.
- Stops cleanly when the main server shuts down.
- **Tests**: server starts on port 9091, directory listing shows dataset
  directories, parquet file is downloadable via HTTP GET.

#### Task 12.2: r2d2 — DatasetReady notification with URL (2 tests) ✅

**Files**: ADAPT `r2d2/src/r2d2/_server.py`

- After `stop_recording` → `finalize()`, send a `dataset_ready` StatusMessage:
  ```json
  {
    "event": "dataset_ready",
    "message": "session_001 ready (5 episodes, 210 MB)",
    "data": {
      "name": "session_001",
      "episodes": 5,
      "frames": 1250,
      "size_bytes": 220200960,
      "url": "http://10.42.0.1:9091/session_001/"
    }
  }
  ```
- Compute dataset size with `du` or by walking the directory tree.
- **Tests**: status sent after stop_recording, URL is correct, size is
  non-zero for non-empty datasets.

#### Task 12.3: c3po — Robot.download_dataset() convenience method (5 tests) ✅

**Files**: ADAPT `c3po/src/c3po/robot.py`

- `robot.download_dataset(name, dest=".")` downloads the dataset from
  `http://10.42.0.1:9091/datasets/{name}/` to `dest/{name}/`.
- Uses `requests` (already available as a transitive dependency via
  `websocket-client`).
- Shows a progress bar via `tqdm` if available.
- **Tests**: download succeeds for small test dataset, files are written
  to correct destination.

---

### Phase 13: LeRobot v0.6.0 Bump ✅

**Goal**: Bump the vendored LeRobot source in r2d2 from v0.5.1 to v0.6.0.
v0.6.0 adds native ReBot support (enabling Phase 14), fixes Feetech position
overflow bugs, standardizes bimanual robot patterns, and splits dependencies
into finer-grained extras.

**Key finding**: ``torch`` remains a core dependency (not moved to an extra),
so the ``types-no-torch.patch`` is still required — regenerated against the
new ``types.py`` line offsets.

Import paths for ``SOFollowerRobotConfig``, ``SOLeaderTeleopConfig``,
``OpenCVCameraConfig``, ``make_robot_from_config``, and
``make_teleoperator_from_config`` are all **unchanged**.  The bump is mostly
a tag change in the Dockerfile.

#### Task 13.1: Regenerate torch-optional patch ✅

**Files**: ``r2d2/patches/types-no-torch.patch``

- Regenerated the patch against v0.6.0's ``types.py``.  Same logic, updated
  line offsets (v0.6.0 added ``from __future__ import annotations`` shifting
  everything by 1 line; the ``try/except`` block adds 4 more).
- Verified hunk headers match the new file's line numbers.

#### Task 13.2: Update r2d2 Dockerfile ✅

**Files**: ``r2d2/Dockerfile``

- Changed ``git clone --branch v0.5.1`` → ``git clone --branch v0.6.0``.
- No new pip packages needed: hardware-only code path does not import
  ``gymnasium``, ``einops``, ``safetensors``, or other training deps.
  Existing package list is sufficient.

#### Task 13.3: Register ReBot config in r2d2 ✅

**Files**: ``r2d2/src/r2d2/_config.py``

- Added ``RebotB601FollowerRobotConfig`` import and ``_ROBOT_REGISTRY["rebot_b601"]``
  entry.  Since v0.6.0 natively supports ReBot, this is just a registry entry —
  no custom driver needed.  LeRobot's ``make_robot_from_config`` handles the rest.

#### Task 13.4: Verify test suite ✅

- ``test_config.py`` uses ``pytest.importorskip("lerobot")`` — safely skipped
  when lerobot is not importable.  No test changes needed.
- Full r2d2 test suite (79 tests) and c3po test suite (132 tests) pass.

---

### Phase 14: ReBot B601-DM Support

**Goal**: Support the ReBot B601-DM bimanual robot station using LeRobot's
existing ``RebotB601Follower`` driver.  Follow the same pattern established
for SO-101: register the config class, create a station YAML, write a launch
script, and validate end-to-end.

Because ReBot is bimanual, this phase also stress-tests the protocol's
multi-arm support (already designed into the manifest, mapping layer, and
protocol spec — see ``MOCK_MANIFEST_BIMANUAL`` in c3po's test conftest).

#### Task 14.1: Register ReBot config in r2d2

**Files**: ``r2d2/src/r2d2/_config.py``

- Import ``RebotB601FollowerRobotConfig`` from LeRobot and register it
  as ``"rebot_b601"`` in ``_ROBOT_REGISTRY``.
- The ReBot robot object exposes two arms; LeRobot's ``get_observation()``
  already returns keys with a prefix (e.g. ``"left/j0.pos"``).  Verify that
  ``obs_to_protocol`` handles this with the correct ``arm_prefix``.

#### Task 14.2: Station config for ReBot

**Files**: NEW ``r2d2/config/station.rebot_b601.yaml``

- Create a YAML config following the existing pattern with:
  - ``station_model: rebot_b601``
  - ``robot.type: rebot_b601``
  - CAN bus port (e.g. ``/dev/pcan32`` or socketcan interface)
  - Camera configs for wrist and scene cameras
  - No teleop section (ReBot teleop uses the leader arms on the same robot)

#### Task 14.3: Launch script

**Files**: NEW ``r2d2/launch_scripts/rebot_b601.sh``

- Docker run command following the existing pattern.
- Bind-mount CAN bus device and cameras.
- Expose ports 9090 (WebSocket) and 9091 (HTTP).

#### Task 14.4: Manifest and mapping validation

**Files**: ADAPT ``r2d2/src/r2d2/_manifest.py`` (if needed)

- Verify that ``build_manifest`` correctly produces two arms when the
  robot reports multiple joint name sets.
- If LeRobot's ReBot driver uses a different observation key convention
  than SO-101 (e.g. ``left_follower/j0.pos`` vs ``shoulder_pan.pos``),
  add a mapping adapter in ``_mapping.py``.  Reuse existing code — do not
  write a second mapping path.

#### Task 14.5: Integration test (toy mode first)

**Files**: ADAPT ``r2d2/tests/test_integration.py``

- Add a test that creates a bimanual manifest (two arms, multiple cameras)
  and verifies the full lifecycle: handshake → step → record → verify
  parquet has both arms' state.
- Reuse the existing ``MOCK_MANIFEST_BIMANUAL`` from c3po's tests as a
  starting point.

#### Task 14.6: Hardware validation (manual)

- Connect to a physical ReBot station over CAN bus.
- Verify leader-follower teleoperation with c3po.
- Record a short dataset and verify it loads with LeRobot's training tools.


---

### Deferred Phases

**Deferred**: HuggingFace Hub and Dropbox upload backends.  These require
auth tokens (HF_TOKEN, DROPBOX_TOKEN) and the existing HTTP forwarding
covers the immediate need.  Will be implemented when tokens are available.

---

### Phase 15: Controller Architecture (powered leaders, haptic feedback, auto-reset)

**Design rationale.**  The current architecture has two categories: ``arms``
(receive actions from c3po) and ``controllers`` (read-only, appear in
observations).  ALOHA-style powered leader arms blur this line — they produce
joint positions AND receive haptic feedback / execute reset motions — but
**the researcher never directly commands a leader arm.**  The leader either
moves passively (pushed by the human) or actively (haptics / reset computed
by r2d2 server-side).  Therefore:

- **No new protocol category is needed.**  Powered leaders remain in the
  existing ``controllers`` bucket.  Their state streams to c3po in observations;
  any commands they receive are generated within r2d2, not sent over the
  WebSocket.
- **The protocol's ``Action`` message targets only ``arms``** (followers).  The
  researcher commands the follower; the leader follows physics.

**Controller boundary — NUC vs. researcher's machine.**  The dividing line is
**physical coupling to the robot station**:

| Controller | Location | Rationale |
|---|---|---|
| Leader arms (powered or unpowered) | **NUC** | Physically coupled to workcell; needs calibration; part of station config |
| Joysticks, gamepads, SpaceMouse | **Researcher's machine** | Generic HID peripherals; researcher brings their own; reads in policy code with ``pygame`` / ``pynput`` / ``spacymouse`` |
| Keyboard (q/n/r) | **Researcher's machine** | Already handled by c3po's ``KeyboardListener`` as a small convenience; no additional scope |

**c3po does not become a general controller library.**  The ``KeyboardListener``
stays as the only built-in controller convenience.  For joysticks, gamepads,
and SpaceMouse, the researcher imports whatever library they prefer directly
in their policy script — c3po has no opinion and no dependency on HID libraries.

#### Task 15.1: Manifest — add ``capabilities`` to controllers (3 tests)

**Files**: ADAPT ``r2d2/src/r2d2/_manifest.py``, ADAPT ``c3po/src/c3po/_manifest.py``

- Add an optional ``capabilities: list[str]`` field to each controller entry
  in the manifest:
  ```json
  {
    "name": "left_leader",
    "type": "joint_position",
    "joint_count": 6,
    "capabilities": ["haptic_feedback", "auto_reset"]
  }
  ```
- Supported capability values:
  - ``"haptic_feedback"`` — controller can receive force/torque feedback from r2d2
  - ``"auto_reset"`` — controller can move to a home position on initialization
  - Absence of ``capabilities`` (or an empty list) means a passive sensor-only
    controller (e.g., unpowered SO-101 leader).
- r2d2's ``build_manifest()``: include ``capabilities`` from the station config's
  teleop section when present, default to ``[]``.
- c3po's ``parse_manifest()``: expose ``capabilities`` on the parsed controller
  entries so ``Robot`` can provide a ``controller_capabilities`` property.
- **Tests**: manifest roundtrip with capabilities, missing capabilities
  defaults to empty list, unknown capability value does not break parsing.

#### Task 15.2: Station config — add teleop capabilities (2 tests)

**Files**: ADAPT ``r2d2/src/r2d2/_config.py``

- Add an optional ``capabilities`` list to the ``teleop`` section in station YAML:
  ```yaml
  teleop:
    type: so_leader
    id: my_leader_arm
    port: /dev/serial/by-path/...
    baudrate: 1000000
    capabilities: []  # passive leader (default)
  ```
  ```yaml
  teleop:
    type: aloha_leader
    id: left_leader
    port: /dev/serial/by-path/...
    capabilities: [haptic_feedback, auto_reset]
  ```
- ``StationConfig`` dataclass: add ``teleop_capabilities: list[str]`` field,
  default ``[]``.
- ``load_station_config()``: parse ``capabilities`` from the teleop section.
- **Tests**: config with capabilities parses correctly, missing capabilities
  defaults to empty, unknown capability warns but does not error.

#### Task 15.3: r2d2 — haptic feedback loop (4 tests)

**Files**: ADAPT ``r2d2/src/r2d2/_server.py``

- In hardware-mode control loop, **after** reading ``get_observation()`` (which
  includes motor currents for Feetech / libfranka / Kortex arms), compute
  haptic feedback torques and send them to the teleop if it supports it.
- Add a ``_send_haptic_feedback(teleop, le_obs, joint_names)`` helper:
  - Extract motor currents/efforts from ``le_obs``.
  - Map to joint torques using a simple proportional gain (configurable,
    default ``0.05``).  Exact mapping is hardware-specific — start with a
    generic interface that each teleop backend can override.
  - Call ``teleop.send_feedback(torques)`` if the teleop exposes that method.
- The haptic loop runs at the control rate (every cycle).  It must be fast
  (sub-millisecond) — no I/O, just arithmetic + a serial write if the motor
  bus supports it.
- Guard with ``"haptic_feedback" in teleop_capabilities`` — passive leaders
  skip this entirely.
- **Tests**: haptic loop skipped when capability absent, feedback computed
  from mock observations, feedback not sent when teleop lacks ``send_feedback``,
  proportional gain is configurable.

#### Task 15.4: r2d2 — auto-reset on connect (5 tests)

**Files**: ADAPT ``r2d2/src/r2d2/_server.py``

- After the ``describe`` handshake completes, if the teleop supports
  ``"auto_reset"``, execute an initialization sequence:
  1. Send the leader to a configured home position (joint-space waypoints).
  2. Wait for the leader to reach each waypoint (position error < threshold).
  3. Once at home, release any active torque and hand control to the human.
- The home position is read from the station config (new ``home_position``
  field in the teleop section) or from a calibration file.  If neither
  exists, skip auto-reset and log a warning.
- The reset sequence runs **after** the ``describe_response`` is sent but
  **before** the control loop starts streaming observations.  This way c3po's
  ``reset()`` call receives observations from a leader already at its home
  position.
- Add a ``leader_home_position`` property to ``Robot`` so the researcher can
  introspect where the leader will reset to.
- **Tests**: auto-reset skips when capability absent, home position read
  from config, reset sequence runs to completion, timeout if leader fails
  to reach home, observations stream only after reset completes.

#### Task 15.5: c3po — expose controller capabilities (2 tests)

**Files**: ADAPT ``c3po/src/c3po/robot.py``, ADAPT ``c3po/src/c3po/_manifest.py``

- Add a ``controller_capabilities`` property to ``Robot``:
  ```python
  @property
  def controller_capabilities(self) -> dict[str, list[str]]:
      """Mapping from controller name to its capabilities list."""
      return {
          c["name"]: c.get("capabilities", [])
          for c in self._manifest["controllers"]
      }
  ```
- Add a ``leader_home_position`` property that returns the home position from
  the manifest (if present), or ``None``.
- These are informational — the researcher's code can check them but the
  protocol does not change.
- **Tests**: property returns correct capabilities, empty dict for stations
  with no controllers, home position is None when not configured.

#### Task 15.6: Station config — ALOHA-style powered leader example (1 test)

**Files**: NEW ``r2d2/config/station.aloha.yaml``

- Create a reference config for an ALOHA-style bimanual station:
  ```yaml
  station_model: aloha_bimanual

  robot:
    type: so_follower
    # ... left follower config ...

  robot_right:
    type: so_follower
    # ... right follower config ...

  teleop_left:
    type: aloha_leader
    port: /dev/serial/by-path/...
    capabilities: [haptic_feedback, auto_reset]
    home_position: [0.0, -0.5, 0.3, 0.0, 0.0, 0.0]

  teleop_right:
    type: aloha_leader
    port: /dev/serial/by-path/...
    capabilities: [haptic_feedback, auto_reset]
    home_position: [0.0, 0.5, -0.3, 0.0, 0.0, 0.0]
  ```
- **Test**: config loads without error, capabilities and home position
  parsed correctly.

---

### Phase 16: Lightweight LeRobot v3.0 Dataset Parser (c3po)

**Goal**: Let researchers read LeRobot v3.0 datasets (parquet + MP4) without
installing the full ``lerobot`` package — which pulls PyTorch, HuggingFace Hub,
and training dependencies.  This directly supports the project's core value
prop: minimal dependencies on the researcher's machine.

**Design**.  A new ``c3po.data`` submodule (or a standalone ``c3po-datasets``
entry point) that reads the on-disk format produced by r2d2's
``DatasetRecorder``.  Dependencies: ``pyarrow`` (already a c3po dependency),
``av`` or ``opencv-python-headless`` for MP4 decoding.

API sketch:

```python
from c3po.data import open_dataset

with open_dataset("session_001") as ds:
    print(ds.info)         # info.json contents
    print(ds.stats)        # stats.json contents
    for episode in ds.episodes():
        for frame in episode:
            obs = frame["observation.state"]  # np.ndarray
            act = frame["action"]             # np.ndarray
            img = frame["observation.images.front_rgb"]  # np.ndarray (H, W, 3)
```

The parser is read-only and does not depend on LeRobot's type system or
``LeRobotDataset`` class.  It should produce plain dicts of numpy arrays
that are trivially convertible to PyTorch tensors if needed.

#### Task 16.1: Episode reader — parquet + video (5 tests)

**Files**: NEW ``c3po/src/c3po/data/__init__.py``, ``c3po/src/c3po/data/_reader.py``

- ``EpisodeReader`` class: opens a chunk directory, reads parquet files in
  episode order, decodes MP4 videos lazily.
- Index episodes by number without loading all data into memory.
- Handle depth frames stored as PNG sequences (produced by r2d2 when MP4
  encoding is not applicable to uint16 data).
- **Tests**: read single-episode dataset, read multi-episode dataset, video
  frame count matches parquet frame count, depth PNG sequence decoded
  correctly, missing video directory handled gracefully.

#### Task 16.2: Dataset metadata — info.json + stats.json (2 tests)

**Files**: ADAPT ``c3po/src/c3po/data/_reader.py``

- Parse ``meta/info.json`` and ``meta/stats.json`` into typed dicts.
- Expose ``fps``, ``robot_type``, ``total_episodes``, ``total_frames``.
- Expose per-feature statistics (min, max, mean, std) from ``stats.json``.
- **Tests**: info fields match recorded values, stats contain all expected
  features, gracefully handles missing stats.json.

#### Task 16.3: Public API — ``open_dataset`` context manager (2 tests)

**Files**: ADAPT ``c3po/src/c3po/data/__init__.py``

- ``open_dataset(path)`` returns a ``Dataset`` object with properties:
  ``info``, ``stats``, ``episodes()`` iterator, ``__len__()`` (episode count).
- ``Dataset.episodes()`` returns an iterator of ``Episode`` objects.
- ``Episode`` exposes a ``frames()`` iterator and ``__len__()`` (frame count).
- Each frame is a dict with string keys and numpy array values.
- **Tests**: context manager opens and closes cleanly, iteration works,
  frame dict has expected keys, len reports correct counts.

---

### Phase 17: Franka Panda Support (r2d2)

**Goal**: Support the Franka Panda robot arm using libfranka, following the
same pattern established for SO-101.  The design is already documented in
``r2d2/README.md`` §4 "Adding a New Robot" with a complete ``FrankaRobot``
class skeleton.

**Key design decision**: r2d2 communicates with the Franka control box over
Ethernet.  The control box runs its own real-time controller; r2d2 is a
setpoint relay — no PREEMPT_RT kernel required on the NUC.  The arm's
internal safety reflexes remain fully active.

#### Task 17.1: Register Franka config in r2d2 (2 tests)

**Files**: ADAPT ``r2d2/src/r2d2/_config.py``

- Add a ``FrankaRobotConfig`` dataclass and register it as ``"franka"`` in
  ``_ROBOT_REGISTRY``.
- Minimal fields: ``ip`` (control box IP, default ``172.16.0.2``), camera
  configs.
- Import ``franka`` lazily — only when a Franka config is loaded.
- **Tests**: config parses with IP field, missing IP raises clear error.

#### Task 17.2: FrankaRobot driver (4 tests)

**Files**: NEW ``r2d2/src/r2d2/_robots/franka.py``

- Implement ``FrankaRobot`` following the LeRobot ``Robot`` interface:
  ``connect()``, ``get_observation()``, ``send_action()``, ``disconnect()``.
- ``connect(calibrate=True)``: instantiate ``franka.Robot``, set default
  behavior (collision reflexes, joint limits).
- ``get_observation()``: read joint positions + velocities from
  ``robot.read_once()``.  Camera frames are returned by LeRobot's camera
  layer (not Franka-specific).
- ``send_action(action)``: call ``robot.set_joint_positions()`` with the
  flattened position array.
- ``disconnect()``: close the Franka connection, disconnect cameras.
- **Tests**: mock libfranka for unit tests, observation dict has expected
  keys, send_action passes through to mock, disconnect is idempotent.

#### Task 17.3: Station config + launch script (1 test)

**Files**: NEW ``r2d2/config/station.franka.yaml``, NEW
``r2d2/launch_scripts/franka.sh``

- YAML config referencing the Franka control box IP and camera configs.
- Launch script bind-mounting cameras and the config file.
- **Test**: config loads without error.

---

### Phase 18: Stereolabs ZED Camera Support (r2d2)

**Goal**: Support Stereolabs ZED stereo cameras for high-quality RGB + depth
capture.  The ZED is already listed in the supported hardware table.

**Key design decision**: The ZED SDK must be installed in the Docker image.
The existing binary frame protocol already supports RGB + depth streams
natively (``RAW_RGB`` + ``RAW_DEPTH`` encodings) — no protocol changes needed.
The ``_NonBlockingCamera`` wrapper handles the LeRobot/OpenCV camera interface;
a ZED camera would need a similar adapter that reads from the ZED SDK's
background capture thread.

#### Task 18.1: ZedCamera wrapper (3 tests)

**Files**: NEW ``r2d2/src/r2d2/_cameras/zed.py``

- Implement a ``ZedCamera`` class that wraps the ZED SDK:
  - ``__init__``: open the camera by serial number, configure resolution +
    FPS, start the ZED SDK's internal capture thread.
  - ``read()``: return the latest RGB frame as a numpy array (non-blocking).
  - ``read_depth()``: return the latest depth map as a numpy uint16 array.
  - ``close()``: stop capture and release the camera.
- The ZED SDK's ``retrieve_image()`` / ``retrieve_measure()`` calls are
  already non-blocking when using the SDK's internal grabbing thread.
- **Tests**: mock ZED SDK for unit tests, read returns correct shape,
  read_depth returns uint16, close is idempotent.

#### Task 18.2: Register ZED in camera registry (2 tests)

**Files**: ADAPT ``r2d2/src/r2d2/_config.py``

- Add ``"zed"`` to ``_CAMERA_REGISTRY`` with a ``ZedCameraConfig`` dataclass.
- Fields: ``serial`` (serial number string), ``width``, ``height``, ``fps``,
  ``publish_depth`` (bool).
- Import ZED SDK lazily.
- **Tests**: config parses with serial, missing serial raises clear error,
  publish_depth defaults to False.

#### Task 18.3: Station config + launch script (1 test)

**Files**: NEW ``r2d2/config/station.so101.zed.yaml`` or similar.

- Reference config using a ZED as the wrist camera.
- Launch script bind-mounting the ZED USB device.
- **Test**: config loads without error.

---

### Phase 19: c3po Live View (optional)

**Goal**: A lightweight popup window showing live camera feeds and joint
torque plots during teleop data collection.  Helps the operator see what the
robot sees without needing a separate monitor or VNC session.

**Key design decision**: This is an **optional extra**, not part of c3po core.
It lives in a separate ``c3po.viewer`` submodule (or a standalone
``c3po-live`` entry point) with extra dependencies (``opencv-python-headless``
or ``matplotlib``).  c3po's core dependency footprint stays at 3.

#### Task 19.1: Camera feed window (2 tests)

**Files**: NEW ``c3po/src/c3po/viewer/__init__.py``

- ``LiveViewer(robot)``: opens a persistent OpenCV window showing the latest
  frame from each camera, updated on every ``step()`` call.
- Multiple cameras are tiled in a grid layout (e.g., 2 cameras → side by side).
- Press ``q`` or close the window to stop the viewer (does not affect the
  robot connection).
- **Tests**: window opens without error (headless test with mocked OpenCV),
  multiple camera feeds are tiled correctly.

#### Task 19.2: Joint torque / position plot (1 test)

**Files**: ADAPT ``c3po/src/c3po/viewer/__init__.py``

- A rolling matplotlib plot (or a simple terminal ASCII plot) of joint
  torques and positions over the last N seconds.
- Auto-scaling y-axis, color-coded per joint.
- Updates once per episode or on a configurable interval.
- **Test**: plot data accumulates correctly over multiple steps, data
  clears on reset.

---

### Phase 20: BOX Dataset Upload (r2d2)

**Goal**: After recording, r2d2 automatically uploads the finalized dataset
to the lab's BOX account (infinite storage via the advisor's account), then
deletes the local copy to free up space on the NUC.  The upload runs in the
background — the researcher can disconnect and walk away immediately after
pressing ``q``.  No upload logic on c3po.

**Key design decisions**:

- **Upload on r2d2, not c3po.**  The dataset already lives on the NUC;
  uploading directly avoids a download-then-upload round-trip.  A single
  BOX API token (shared lab credential) lives on the NUC — no token
  distribution to individual researchers.
- **Fire-and-forget.**  The upload runs in the same background asyncio task
  that handles ``end_episode()`` + ``finalize()`` (see Phase 10 fix).  The
  researcher can disconnect immediately; the upload continues.
- **Auto-cleanup.**  On successful upload, r2d2 deletes the local dataset
  directory.  The NUC is a control computer, not a storage server — disk
  space is reclaimed automatically.
- **Fallback.**  If upload fails, the local copy is preserved and the
  researcher can still download it via HTTP (Phase 12).
- **Zero new dependencies.**  Uses Python stdlib ``urllib`` for the BOX API.
  BOX's chunked upload is standard HTTP (session create → PUT parts → commit).

#### Task 20.1: BOX upload client (4 tests)

**Files**: NEW ``r2d2/src/r2d2/_box_upload.py``

- ``upload_dataset_to_box(dataset_path, box_token, folder_name=None)``:
  recursively uploads a directory tree to BOX, preserving structure.
- Authentication: ``Authorization: Bearer {token}`` header on every request.
- Small files (< 50 MB): single ``POST /files/content`` with multipart.
- Large files (>= 50 MB): BOX chunked upload session API:
  1. ``POST /files/upload_sessions`` — create session (folder_id, file_size, file_name)
  2. ``PUT /files/upload_sessions/{id}/parts`` — upload each chunk with
     ``Content-Range`` and ``Digest`` (SHA-1) headers in parallel
  3. ``POST /files/upload_sessions/{id}/commit`` — finalize, returns file metadata
- Returns the BOX shared link URL on success.
- Raises ``BoxUploadError`` with a clear message on failure (auth, network,
  quota, etc.).
- **Tests**: mock HTTP responses with ``unittest.mock.patch`` on
  ``urllib.request``, small file upload constructs correct multipart body,
  chunked upload splits file correctly, commit returns expected URL,
  auth failure raises BoxUploadError, network error retries once.

#### Task 20.2: r2d2 — wire upload into StopRecording flow (3 tests)

**Files**: ADAPT ``r2d2/src/r2d2/_server.py``

- Extend the ``_finalize_dataset`` background task (spawned in the
  ``StopRecording`` handler) with an optional upload step:
  ```python
  async def _finalize_dataset() -> None:
      # ... existing end_episode + finalize + status sends ...

      # Auto-upload to BOX if configured.
      if _box_token is not None:
          logger.info("Uploading %r to BOX ...", name)
          try:
              url = await rec_loop.run_in_executor(
                  None,
                  lambda: upload_dataset_to_box(
                      _path, _box_token, folder_name="n-droids"
                  ),
              )
              logger.info("Uploaded %r to BOX: %s", name, url)
              # Delete local copy to free NUC disk space.
              await rec_loop.run_in_executor(None, shutil.rmtree, _path)
              logger.info("Deleted local dataset %r", name)
              await self._send_status(
                  "dataset_uploaded",
                  f"{name} uploaded to BOX",
                  name=name,
                  url=url,
              )
          except Exception:
              logger.exception(
                  "BOX upload failed for %r — dataset preserved locally",
                  name,
              )
  ```
- The ``_box_token`` is captured from the server configuration at handler
  creation time (see Task 20.3).
- The upload runs in a thread-pool executor to avoid blocking the event loop.
- ``shutil.rmtree`` also runs in the executor since it's a potentially slow
  filesystem operation on large directory trees.
- **Tests**: upload skipped when token is None, upload called with correct
  path and folder, local dataset deleted after successful upload, local
  dataset preserved on upload failure, ``dataset_uploaded`` StatusMessage
  sent on success.

#### Task 20.3: Server config — BOX token from environment (2 tests)

**Files**: ADAPT ``r2d2/src/r2d2/_server.py``

- ``create_server()`` reads ``BOX_TOKEN`` from the environment.
- Pass the token (or ``None``) through to ``_ConnectionHandler`` so the
  background task can access it.
- Add a ``--box-token`` CLI flag to ``main()`` as an alternative to the
  env var (useful for Docker secrets).
- **Tests**: token read from env var, token passed through to handler,
  None when not configured.

---

### Test totals

| Phase | c3po | r2d2 |
|---|---|---|
| Phase 1-6 (protocol, transport, robot, recording, integration) | 100 | 60 |
| Phase 7 (SO-101 hardware) | — | 12 |
| Phase 8 (camera pipeline) | 18 | 8 |
| Phase 9 (streaming resolution) | 2 | 11 |
| Phase 10 (StatusMessage + bug fixes) | 5 | 10 |
| Phase 11 (SpecRequest/SpecResponse) | 3 | 10 |
| Phase 12 (dataset forwarding) | 6 | 6 |
| **Running total** | **134 (2 skipped)** | **79 (1 failure, 1 skipped)** |

---

### Hardware proven

| Feature | Status |
|---|---|
| SO-101 leader→follower teleop | ✅ |
| UVC webcam (640×480) | ✅ |
| RealSense RGB (1280×720) | ✅ |
| RealSense depth | ✅ (raw uint16, native rate) |
| 50Hz teleop with cameras | ✅ (cameras decoupled from control loop) |
| Multiple simultaneous cameras | ✅ (2× UVC + 1× RealSense) |
| Dataset recording (parquet + MP4) | ✅ |
| Stable device naming (by-path) | ✅ |
| Configurable control rate | ✅ |
| Streaming resolution cap | ✅ |
| StatusMessage protocol | ✅ |
| Graceful SIGTERM shutdown | ✅ |
| Connect/disconnect logging | ✅ |
| Health check log suppression | ✅ |
| Camera error resilience (graceful fallback + status) | ✅ |
| Recording episode counter / discard / ready messages | ✅ |
| Spec runtime introspection (`robot.spec()`) | ✅ |
| Plain-text spec output (`str(spec)`) | ✅ |
| Dataset HTTP transfer | ✅ |
| Dataset download (`robot.download_dataset()`) | ✅ |
