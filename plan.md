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

#### Task 13.1: Regenerate torch-optional patches ✅

**Files**: ``r2d2/patches/types-no-torch.patch``, ``r2d2/patches/device-utils-no-torch.patch``

- Regenerated ``types-no-torch.patch`` against v0.6.0's ``types.py``.  Same logic,
  updated line offsets (v0.6.0 added ``from __future__ import annotations``
  shifting everything by 1 line; the ``try/except`` block adds 4 more).
- **New**: ``device-utils-no-torch.patch`` for ``lerobot/utils/device_utils.py``.
  v0.6.0's hardware import chain (``robots.utils`` → ``motors`` →
  ``utils.__init__`` → ``device_utils``) hits a second bare ``import torch``
  that our original patch didn't cover.  The patch adds ``from __future__
  import annotations`` (so ``-> torch.device`` type annotations are lazily
  evaluated) and wraps ``import torch`` in a ``try/except`` guard.
- Verified both patches apply cleanly against the v0.6.0 source tree.

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

### Phase 14: ReBot B601-DM Support ✅

**Goal**: Support the ReBot B601-DM bimanual robot station using LeRobot's
native v0.6.0 drivers.  The ReBot is inherently bimanual with 7 DOF per arm
(6 joints + gripper) communicating over CAN bus (Damiao adapter).  Leader
arms (StarArm102 / reBot Arm 102) use FashionStar UART smart servos.

Because v0.6.0 already provides ``BiRebotB601Follower`` and
``BiRebot102Leader``, our work is configuration and integration — no custom
drivers needed.

#### Task 14.1: Register ReBot config in r2d2 ✅

**Files**: ``r2d2/src/r2d2/_config.py``

- Registered all four ReBot config types:
  ``RebotB601FollowerRobotConfig`` (single arm), ``BiRebotB601FollowerConfig``
  (bimanual), ``RebotArm102LeaderTeleopConfig`` (single leader),
  ``BiRebot102LeaderConfig`` (bimanual leader).
- Added ``_make_config_from_raw`` helper for nested dataclass construction.
- ``_make_robot_config`` handles bimanual by recursively parsing
  ``left_arm_config`` / ``right_arm_config`` dicts into ``RebotB601FollowerConfig``
  instances, while top-level cameras stay unprefixed.
- ``_make_teleop_config`` handles bimanual leaders the same way.

#### Task 14.2: Station configs + launch scripts ✅

**Files**: NEW ``r2d2/config/station.rebot_bimanual_2realsense.yaml``,
NEW ``r2d2/config/station.rebot_bimanual_3realsense.yaml``,
NEW ``r2d2/launch_scripts/rebot_bimanual_2realsense.sh``,
NEW ``r2d2/launch_scripts/rebot_bimanual_3realsense.sh``

- **2‑RealSense**: Two wrist-mounted D435 cameras (one per arm), no scene camera.
- **3‑RealSense**: Two wrist cameras + one front-facing D435 scene camera
  (top-level, unprefixed key).
- Launch scripts bind-mount ``/dev/serial/by-path/`` (CAN + UART adapters)
  and ``/dev/bus/usb`` (RealSense).

#### Task 14.3: Bimanual manifest building ✅

**Files**: ``r2d2/src/r2d2/_server.py``

- Manifest building now groups LeRobot's ``left_*`` / ``right_*`` prefixed
  observation feature keys into separate arm entries (``left_follower``,
  ``right_follower``).  Unprefixed single‑arm keys still map to ``"follower"``.
- Camera entries are extracted from feature tuples (not motor floats).
- Controller names handle bimanual leaders (two entries).

#### Task 14.4: Bimanual observation / action mapping ✅

**Files**: ``r2d2/src/r2d2/_server.py``

- ``_ConnectionHandler`` holds an ``_arm_joint_map`` dict (prefix → joint names)
  instead of a single ``_joint_names`` list.
- Observation building iterates over all arms, calling ``obs_to_protocol``
  per arm and merging results.
- Action application iterates over all arms, calling ``action_from_protocol``
  per arm and merging into a single LeRobot-format dict for
  ``robot.send_action()``.
- Teleop position extraction iterates per arm and populates
  ``{arm_prefix}/joint_position`` observation keys.

#### Task 14.5: Test suite ✅

**Files**: NEW ``r2d2/tests/test_rebot.py`` (18 tests, 4 skipped)

- **Config registry** (4 tests, skipped): verify all four ReBot types are
  registered.  Requires LeRobot import — uses ``pytest.importorskip``.
- **Manifest building** (6 tests): single‑arm unprefixed, protocol‑prefixed,
  bimanual ``left_``/``right_``, 7‑DOF ReBot, camera exclusion, no‑joint edge case.
- **Bimanual mapping** (5 tests): arm‑joint‑map construction, obs‑to‑protocol,
  action‑from‑protocol, teleop position extraction, missing joint default.
- **Edge cases** (3 tests): mixed prefixes, arm with only cameras, 7 joints per arm.

#### Task 14.6: USB path documentation + teleop scripts ✅

**Files**: NEW ``n-droids/usb_setup.md``, NEW ``toy-so101/teleop_rebot.py``,
NEW ``toy-so101/record_rebot.py``, NEW ``toy-so101/replay_rebot.py``

- Step‑by‑step guide for identifying CAN adapter, leader UART adapters, and
  RealSense serial numbers on the NUC.
- ``teleop_rebot.py``: live leader→follower mirroring with auto-discovered
  arm-controller mapping.
- ``record_rebot.py``: bimanual dataset recording with keyboard controls
  (same q/n/r interface as the SO‑101 record script).
- ``replay_rebot.py``: replay a downloaded dataset on the hardware, splitting
  the flat action vector back into per-arm arrays.

---

### Deferred Phases

**Deferred**: HuggingFace Hub and Dropbox upload backends.  These require
auth tokens (HF_TOKEN, DROPBOX_TOKEN) and the existing HTTP forwarding
covers the immediate need.  Will be implemented when tokens are available.

---

### Phase 15: Controller Architecture ✅ (27 tests, hardware-verified)

**Design.**  A new ``Controller`` dataclass (``r2d2/src/r2d2/_controller.py``)
wraps each LeRobot Teleoperator with n-droids-specific logic: capability
gating, protocol key formatting, and hardware command sequences.  The control
loop calls ``ctrl.get_state()`` and ``ctrl.apply_haptics()`` instead of ad-hoc
teleop access — capability checks live inside the Controller, not scattered
across the handler.

**``Controller`` fields:** ``name``, ``teleop``, ``arm_prefix``, ``joint_names``,
``capabilities``, ``home_position``, ``haptic_gain``.

**Supported capabilities:**
- ``"auto_reset"`` — leader snaps to ``home_position`` on connect
  (enables torque, writes positions, disables torque).
  **Hardware-verified on SO‑101.**  Uses LeRobot's ``enable_torque()`` /
  ``send_feedback()`` / ``disable_torque()`` — already present on SOLeader.
- ``"haptic_feedback"`` — stub that reads ``{motor}.current`` / ``.effort`` /
  ``.torque`` from the follower observation and sends scaled position
  feedback.  Gates on non-empty ``feedback_features`` (SOLeader passes,
  RebotArm102Leader skips).  Full torque-based haptics requires hardware
  with current control (ALOHA-style leaders).

**Manifest changes (both r2d2 and c3po):** controller entries now include
``capabilities``, ``joint_names``, and optionally ``home_position``.

**c3po additions:** ``robot.controller_capabilities`` and
``robot.leader_home_position`` properties.

**New config:** ``station.so101.nocam.yaml`` + ``launch_scripts/so101_nocam.sh``
— SO‑101 with no cameras and auto‑reset enabled.

**Files changed / created:**

| File | Change |
|---|---|
| NEW ``r2d2/src/r2d2/_controller.py`` | ``Controller`` dataclass with ``get_state()``, ``reset_to_home()``, ``apply_haptics()`` |
| NEW ``r2d2/tests/test_controller.py`` | 27 tests: construction, get_state, reset_to_home (9), apply_haptics (8) |
| ADAPT ``r2d2/src/r2d2/_config.py`` | ``StationConfig`` gains ``teleop_capabilities`` and ``teleop_home_positions``; ``load_station_config`` parses them from YAML |
| ADAPT ``r2d2/src/r2d2/_manifest.py`` | Controller entries include ``capabilities`` |
| ADAPT ``r2d2/src/r2d2/_server.py`` | Imports ``Controller``; sensor tuple includes controllers; control loop uses ``ctrl.get_state()`` and ``ctrl.apply_haptics()``; manifest built from Controller objects; ``_auto_reset_controllers()`` called after handshake, sends ``leader_reset_complete`` status |
| ADAPT ``r2d2/tests/test_manifest.py`` | +2 tests: capabilities included, defaults empty |
| ADAPT ``c3po/src/c3po/robot.py`` | ``controller_capabilities`` and ``leader_home_position`` properties |
| ADAPT ``c3po/tests/test_robot.py`` | +3 tests: controller_capabilities, leader_home_position |
| NEW ``r2d2/config/station.so101.nocam.yaml`` | SO‑101 config with auto‑reset, no cameras |
| NEW ``r2d2/launch_scripts/so101_nocam.sh`` | Launch script for nocam config |

**Hardware status:**

| Platform | Auto‑reset | Haptics |
|---|---|---|
| SO‑101 leader | ✅ verified | ❌ stub (Feetech servos lack torque control) |
| ReBot 102 leader | ❌ (``send_feedback`` raises ``NotImplementedError``) | ❌ (``feedback_features = {}``) |
| ALOHA / future powered leader | ✅ (same SOLeader API) | ❌ stub (ready when hardware arrives) |

---

### Phase 16: Franka Panda Support (r2d2) ✅ (16 tests, hardware-verified)

**Status**: Implemented, tested, and hardware-verified on a Franka Panda
(server v5) with libfranka 0.9.2.  The arm streams sinusoidal positions via
c3po at 10-50 Hz with bounded tracking error and no error accumulation.

**Goal**: Support the Franka Panda robot arm for DROID-style data collection.
The Franka control box has its own internal real-time controller with active
safety reflexes — r2d2 is purely a setpoint relay at ≤ 50 Hz.

**Key design decision — PREEMPT_RT on the NUC.**  After thorough research,
the recommended library is **`franky`** (TimSchneider42/franky, 355 ★), the
more modern and actively maintained fork of frankx.  Franky requires a
PREEMPT_RT kernel on the machine running it — this is a hard requirement of
libfranka's 1 kHz FCI communication loop and cannot be bypassed with
``RealtimeConfig::kIgnore`` (which only relaxes thread scheduling, not the
kernel-level timing guarantees the Franka control box expects).

**Libfranka version compatibility:** franky ships pre-built wheels for 8
libfranka versions (0.7.1 through 0.21.2).  Match the version to your
robot's firmware — check the Franka Desk web interface for the FCI version.
Franka Research 3 uses libfranka 0.21.2; older Panda robots may use 0.9.2
or earlier.  franky's wheel archive covers all of them.

**NUC kernel setup — Ubuntu Pro realtime-kernel.**  The NUC runs Ubuntu
24.04 (see Phase 25 migration).  Enable the real-time kernel:

```bash
sudo pro enable realtime-kernel
sudo reboot
```

**CUDA + PREEMPT_RT compatibility.**  NVIDIA drivers check for the RT
kernel and refuse to install by default.  franky documents the workaround:
set ``IGNORE_PREEMPT_RT_PRESENCE=1`` during CUDA installation.  The ZED
SDK uses CUDA under the hood — if CUDA works, ZED works.  franky provides
a script (``tools/install_cuda_realtime.bash``) that automates the full
CUDA + RT kernel installation.  This is a tested, community-verified
configuration.

**Docker considerations.**  Docker containers share the host kernel.
With PREEMPT_RT on the NUC, franky inside a Docker container inherits
real-time scheduling.  The container needs ``--cap-add=SYS_NICE`` plus
``--ulimit rtprio=99 --ulimit memlock=102400`` for the ``realtime`` group
permissions.  The host must have a ``realtime`` group with the user added.

**Alternative considered — RPyC bridge (net_franky / franky-remote).**
Both projects split franky across two machines via RPyC: a small RT
machine runs the franky server, the NUC runs the client.  This avoids
PREEMPT_RT on the NUC but adds a fourth machine per station and ~1 ms
of RPC latency.  Rejected in favor of RT on the NUC — simpler,
cheaper, and the CUDA compatibility concern has a documented fix.

**Alternative considered — Franka Desk API.**  The Desk REST API and
companion Python wrappers (geriatronics/franka_desk, danielsanjosepro/
franka_desk_api_client) only handle pre-FCI setup: take control token,
unlock joints, activate FCI.  Actual motion control **must** go through
libfranka/FCI — there is no HTTP endpoint for streaming joint
positions.  The Desk's jogging WebSocket is undocumented and fragile.

**Control mode — joint position with preemption.**  r2d2 sends joint
position targets at the station control rate (50 Hz).  Each
target is sent via ``robot.move(JointMotion(targets), asynchronous=True)``
--- the ``asynchronous`` flag prevents blocking, and the next cycle's
call preempts the previous motion.  franky replans via Ruckig from
the current state to the new target within the 20 ms cycle budget.
At 5 % dynamics (``relative_dynamics_factor = 0.05``), the trajectory
planner blends smoothly between consecutive targets, producing fluid
motion with bounded tracking error (~0.04 rad RMS) that does not
accumulate over time.

**Implementation.**  The Franka driver lives inside the vendored LeRobot tree
(``lerobot/src/lerobot/robots/franka/``), following LeRobot convention exactly.
The gripper is treated as a separate logical arm (``gripper``, 1 joint) in the
manifest rather than folded into the 7-DOF arm entry — cleaner introspection
for the researcher.

**Files to create:**

```
lerobot/src/lerobot/robots/franka/
├── __init__.py
├── config_franka.py          # FrankaRobotConfig (draccus dataclass)
└── franka_robot.py           # FrankaRobot class
```

#### Task 16.1: FrankaRobotConfig + registry (2 tests)

**Files**: NEW ``lerobot/src/lerobot/robots/franka/config_franka.py``,
ADAPT ``r2d2/src/r2d2/_config.py``

- ``FrankaRobotConfig`` dataclass registered as ``"franka"`` in LeRobot's
  ``RobotConfig`` registry (``@RobotConfig.register_subclass("franka")``).
- Fields: ``ip`` (control box IP, default ``172.16.0.2``), ``joint_names``
  (Franka's 7 arm joints), ``cameras``.
- r2d2 ``_config.py``: add ``"franka"`` to ``_ROBOT_REGISTRY``, lazy import.
- **Tests**: config parses with IP field, missing IP raises clear error,
  registry dispatch works.

#### Task 16.2: FrankaRobot driver (5 tests)

**Files**: NEW ``lerobot/src/lerobot/robots/franka/franka_robot.py``

- ``connect()``: instantiate ``franky.Robot(ip)``, call
  ``recover_from_errors()``, set ``relative_dynamics_factor = 0.1`` for
  for safety.  Initialize ``franky.Gripper(ip)`` as a separate gripper
  object; catch and log exceptions if the stock hand was replaced
  (e.g. with a Robotiq 2F-85).
- ``get_observation()``: read ``robot.current_joint_positions`` and
  ``robot.current_joint_velocities`` (non-blocking, lock-free triple
  buffer).  Return dict with ``{name}.pos`` and ``{name}.vel`` keys
  for the arm, and a separate ``panda_finger_joint1.pos`` for the gripper.
- ``send_action(action)``: extract joint position targets from the
  action dict, call ``robot.move(JointMotion(targets), asynchronous=True)``.
  Extract gripper width target, call ``gripper.move(width)``.
  Separate the gripper path so a failed gripper command does not block
  arm motion.
- ``disconnect()``: drop franky object references.  franky's destructor
  triggers a controlled stop.  Idempotent.
- **Tests**: mock franky for unit tests, observation dict has 7 + 1
  (gripper) joints, send_action forwards position targets correctly,
  disconnect is idempotent, error recovery on connect.

#### Task 16.3: Station config + launch script (1 test)

**Files**: NEW ``r2d2/config/station.franka.yaml``,
NEW ``r2d2/launch_scripts/franka.sh``

- YAML config referencing ``ip: 172.16.0.2``, camera configs (likely ZED +
  RealSense for DROID setup).
- Launch script with ``--cap-add=SYS_NICE --ulimit rtprio=99
  --ulimit memlock=102400`` and camera bind-mounts.
- **Test**: config loads without error.

#### Task 16.4: Dockerfile — franky + PREEMPT_RT integration (no new tests)

**Files**: ADAPT ``r2d2/Dockerfile``

- Add ``franky-control`` to ``pip install`` (matches the robot's libfranka
  version — use the version-specific wheel archive if needed).
- Add ``setcap cap_sys_nice+ep /usr/local/bin/python3.12`` so the Python
  process can request real-time scheduling priority.
- Document the host pre-requisites in ``network_setup.md``:
  PREEMPT_RT kernel (``sudo pro enable realtime-kernel``), ``realtime``
  group, CUDA reinstall with ``IGNORE_PREEMPT_RT_PRESENCE=1``.

---

### Phase 17: Robotiq 2F-85 Gripper Support (r2d2) ✅ (28 tests, hardware-verified)

**Status**: Implemented, tested, and hardware-verified on a Robotiq 2F-85
gripper (Modbus device ID 9) connected via USB to the NUC.  The gripper
cycles open/closed via a triangle wave in ``test_franka.py`` alongside the
arm's sinusoidal motion.  Live state updates and bounded tracking error
(~0.03 m mean, characteristic of Modbus RTU latency).

**Goal**: Support the Robotiq 2F-85 gripper (connected via USB to the NUC) as an
alternative to the stock Franka hand.  This is part of the DROID-style setup
where the original Franka gripper has been physically replaced with a Robotiq
gripper.  The gripper is folded into the follower arm's joint array as the 8th
element (``panda_finger_joint1``) — same manifest key, same action/observation
pipeline as the stock hand.

**Key design decision — pyRobotiqGripper v3.x.**  After evaluating both
`pyRobotiqGripper`_ (castetsb, 84 ★, MIT) and `2f85-python-driver`_
(PhilNad, 17 ★, MIT), we selected **pyRobotiqGripper v3.3.13** for three
reasons:

1. **Raw bit-level control (0-255)** normalizes cleanly to DROID's [0, 1] range.
   The alternative library uses mm, requiring calibration to convert.
2. **Non-blocking ``move(position, speed, force, wait=False)``** designed for
   high-frequency control loops.  The v3.x API replaced the older
   ``realTimePositionMove`` with a cleaner ``move()`` that accepts ``wait=False``
   for asynchronous operation.
3. **Rich status API** — ``position(refreshStatus=False)`` for non-blocking
   reads, ``objectDetection()`` for grasp detection, typed fault codes — all
   exposed through a well-documented interface.

**v3.x API notes.**  The library underwent significant changes between v2.x
and v3.x.  Key differences we encountered:

- Constructor: ``RobotiqGripper(com_port=..., device_id=9)`` (was ``serial_number``).
- Position read: ``position(refreshStatus=False)`` → method returning ``int | None``
  (was ``getPosition()`` method, then ``position`` property during transition).
- Move: ``move(position, speed, force, wait=False)`` (was ``realTimePositionMove``).
- Setup: ``connect()`` must be called before ``activate()``.

.. _pyRobotiqGripper: https://github.com/castetsb/pyRobotiqGripper
.. _2f85-python-driver: https://github.com/PhilNad/2f85-python-driver

**Dependencies.**  pyRobotiqGripper v3.3.13 depends on ``pymodbus``, ``numpy``,
and ``pyserial``.  All are pure Python — no system libraries needed beyond
USB serial port access (``/dev/ttyUSB0``).  Added ``pyrobotiqgripper`` to the
Dockerfile ``pip install`` step.

**Normalization.**  The Robotiq gripper reports position as 0-255 bits.
Following DROID convention, this is normalized to [0, 1] where:

- 0.0 = fully open (85 mm)
- 1.0 = fully closed (0 mm)
- ``normalized = 1.0 - bits / 255.0``
- Width in meters: ``width_m = 0.085 * (1.0 - normalized)``

This matches DROID's ``gripper_position`` encoding exactly.

**Integration model.**  ``FrankaRobot.connect()`` checks ``gripper.type`` in the
station config.  When ``"robotiq"``, it creates a ``RobotiqGripperWrapper``
instead of ``franky.Gripper``.  The wrapper exposes the same interface:

- ``gripper.state.width`` → meters (derived from 0-255 bits)
- ``gripper.move(width_m)`` → delegates to ``self._drv.move(position=bits, speed=spd, force=fce, wait=False)``
- ``gripper.object_detected`` → delegates to ``self._drv.objectDetection(refreshStatus=False)``

The gripper appears as ``panda_finger_joint1`` in the manifest's joint list —
it is the 8th element of ``follower/joint_position`` (after the 7 arm joints).
``test_franka.py`` detects it by name and drives it with a separate triangle
wave while the arm joints follow their sinusoidal pattern.

**Draccus compatibility.**  The LeRobot config system (draccus) leaves nested
YAML blocks as raw ``dict`` objects instead of instantiating the annotated
``GripperConfig`` dataclass.  The driver handles both forms:

```python
if isinstance(gripper_cfg, dict):
    com = gripper_cfg.get("com_port")
    did = gripper_cfg.get("device_id", 9)
else:
    com = getattr(gripper_cfg, "com_port", None)
    did = getattr(gripper_cfg, "device_id", 9)
```

**Config format:**

```yaml
robot:
  type: franka
  ip: 172.16.0.2
  gripper:
    type: robotiq
    device_id: 9        # Modbus device ID (default for Robotiq)
    com_port: null      # auto-detect; set to "/dev/ttyUSB0" to force
    speed: 150           # 0-255, higher = faster
    force: 100           # 0-255, higher = grip harder
```

**Hardware-verified behaviour:**

- Gripper connects and activates on ``connect()`` → ``activate()``.
- ``move(wait=False)`` sends non-blocking position targets at 50 Hz.
- ``position(refreshStatus=False)`` returns cached position without a new
  Modbus read — the status cache is updated by the previous ``move()``
  which defaults to ``readStatus=True``.
- Tracking error ~0.03 m mean, ~0.07 m max — bounded by Modbus RTU latency
  (~10-15 ms/command).  No error accumulation over 30-second runs.
- Live state updates in ``test_franka.py`` terminal display.
- ``objectDetection()`` correctly reports 0 (no object) during free motion.

**Implementation.**  The wrapper lives in ``r2d2/src/r2d2/_robotiq/`` as a
standalone subpackage.  Both the LeRobot-tree driver (``robot_lerobot.py``)
and the standalone driver (``robot.py``) import it lazily at connect time.

**Files created:**

```
r2d2/src/r2d2/_robotiq/
├── __init__.py              # Exports RobotiqGripperWrapper
└── _wrapper.py              # RobotiqGripperWrapper class (~150 lines)

r2d2/config/station.franka.robotiq.yaml
r2d2/launch_scripts/franka_robotiq.sh
r2d2/tests/test_robotiq.py   # 28 tests
```

**Files adapted:**

| File | Change |
|---|---|
| ``r2d2/src/r2d2/_franka/config.py`` | Added ``GripperConfig`` dataclass (``type``, ``device_id``, ``com_port``, ``speed``, ``force``); ``FrankaRobotConfig`` gains ``gripper`` field |
| ``r2d2/src/r2d2/_franka/config_lerobot.py`` | Same ``GripperConfig`` + field (self-contained LeRobot copy) |
| ``r2d2/src/r2d2/_franka/robot.py`` | ``connect()`` dispatches to ``RobotiqGripperWrapper`` when ``gripper.type == "robotiq"``; handles dict-form config (draccus) |
| ``r2d2/src/r2d2/_franka/robot_lerobot.py`` | Same gripper selection logic (LeRobot-tree copy) |
| ``r2d2/src/r2d2/_franka/__init__.py`` | Exports ``GripperConfig`` |
| ``r2d2/Dockerfile`` | Added ``pyrobotiqgripper`` to ``pip install`` |
| ``n-droids/franka_setup.md`` | Added Robotiq USB setup section + troubleshooting |
| ``toy-so101/test_franka.py`` | Added gripper detection by joint name, triangle wave driving, live display, error tracking |

---

### Phase 18: Stereolabs ZED Camera Support (r2d2) ✅ (22 tests)

**Goal**: Support Stereolabs ZED stereo cameras for high-quality RGB + depth
capture (essential for the DROID setup).  The ZED SDK's internal grabbing
thread already decouples capture from retrieval, so ``read()`` and
``read_depth()`` are non-blocking — no adapter wrapper needed beyond
the existing ``NonBlockingCamera`` (which handles streaming resolution
downscaling).

**Key design decision:** The implementation follows LeRobot convention —
a ``ZedCamera`` class + ``ZedCameraConfig`` dataclass live inside the
vendored LeRobot tree (``lerobot/src/lerobot/cameras/zed/``).  The existing
binary frame protocol already supports RGB + depth streams natively
(``RAW_RGB`` + ``RAW_DEPTH`` encodings) — no protocol changes needed.

**USB bandwidth caveat:** ZED cameras use USB 3.0 and consume ~200 MB/s each
at 1080p.  Two ZEDs on the same USB controller may saturate it.  r2d2's
existing ``stream_max_height`` config can downscale streaming resolution while
keeping recording at full res (Phase 9 — already implemented).

**Files to create:**

```
lerobot/src/lerobot/cameras/zed/
├── __init__.py
├── configuration_zed.py      # ZedCameraConfig (draccus dataclass)
└── zed_camera.py             # ZedCamera class
```

``ZedCamera`` uses ``pyzed.sl.Camera()`` with ``retrieve_image()`` and
``retrieve_measure()`` — both non-blocking when the SDK's internal grabbing
thread is active.  Fits seamlessly into r2d2's existing camera pipeline
(``NonBlockingCamera`` → ``_camera_send_loop`` → binary frames).

#### Task 18.1: ZedCameraConfig + ZedCamera (3 tests)

**Files**: NEW ``lerobot/src/lerobot/cameras/zed/configuration_zed.py``,
NEW ``lerobot/src/lerobot/cameras/zed/zed_camera.py``

- ``ZedCameraConfig`` registered via ``@CameraConfig.register_subclass("zed")``.
  Fields: ``serial_number`` (int or None), ``resolution`` ("HD720" / "HD1080" /
  "HD2K"), ``fps``, ``publish_depth`` (bool).
- ``ZedCamera.__init__``: open camera by serial, configure resolution + FPS,
  start internal grabbing thread.
- ``read()``: ``cam.grab()`` → ``cam.retrieve_image(sl.VIEW.LEFT)`` → return
  numpy array (RGBA → RGB slice).  Non-blocking.
- ``read_depth()``: ``cam.retrieve_measure(sl.MEASURE.DEPTH)`` → return numpy
  uint16 array in mm.  Returns ``None`` if ``publish_depth=False``.
- ``close()``: ``cam.close()``, idempotent.
- **Tests**: mock ZED SDK, read returns correct shape (H, W, 3), read_depth
  returns uint16, close is idempotent.

#### Task 18.2: Register ZED in r2d2 camera registry (2 tests)

**Files**: ADAPT ``r2d2/src/r2d2/_config.py``

- Add ``"zed"`` to ``_CAMERA_REGISTRY`` (maps to ``ZedCameraConfig``).
- Import ZED SDK lazily — only when a ZED config is loaded.
- **Tests**: config parses with serial_number, missing serial defaults to
  first available camera, ``publish_depth`` defaults to False.

#### Task 18.3: Station config + launch script (1 test)

**Files**: NEW ``r2d2/config/station.franka.zed.yaml``,
NEW ``r2d2/launch_scripts/franka_zed.sh``

- DROID-style config: Franka arm + 2× ZED (wrist + scene) + optional
  RealSense for additional views.
- Launch script bind-mounting ZED USB devices (``/dev/bus/usb``) and
  config file.
- **Test**: config loads without error.

---

### Phase 19: DROID Action Space Alignment (r2d2 + c3po)

**Goal**: Align the Franka driver's action and observation spaces with the
`DROID dataset format`_, enabling inference of pretrained DROID policies
(specifically π₀.₅) without format translation layers.  This is the final
integration step that makes the Franka + Robotiq + ZED hardware stack a
functionally equivalent DROID station.

.. _DROID dataset format: https://droid-dataset.github.io/

**Background.**  DROID policies use **Cartesian end-effector control**:
``abs_pos`` (3) + ``abs_rot_6d`` (6) + ``gripper_position`` (1) = **10D action
space**.  The current Franka driver uses joint position (7D).  To be
DROID-compatible, we need a Cartesian IK layer that converts Cartesian targets
to joint positions on r2d2.

**Key design decision — Cartesian IK on r2d2.**  Using franky's built-in
``Kinematics.inverse()``, r2d2 solves IK for each Cartesian action target, then
sends the resulting joint positions via the existing ``JointMotion`` pipeline.
IK runs inside r2d2 (not c3po) so that:

- Policies send Cartesian actions in DROID format — no format translation
  needed on c3po or in the policy code.
- IK uses the arm's **actual kinematics model** fetched from the Franka
  control box (DH parameters, joint limits).  No hardcoded model that
  could go stale.
- **Null-space posture** can be controlled via franky's ``null_space``
  parameter for predictable elbow behavior.

**franky IK API reference.**  franky exposes kinematics through a
``Kinematics`` helper (imported from the ``_franky`` C++ extension):

```python
from franky import Kinematics

# One-time: create kinematics model from the robot
kinematics = Kinematics(robot)

# Per-cycle: solve IK for a Cartesian target
target_pose = Affine(translation=[x, y, z], rotation=Rotation.from_6d(r))
joints = kinematics.inverse(
    target_pose,
    q_near=current_joints,      # seed for IK solver (current state)
    null_space=home_joints,      # preferred posture (7 floats)
)
```

**Action space definition (matching DROID exactly):**

| Key | Dtype | Range | Description |
|---|---|---|---|
| ``follower/abs_pos`` | float64[3] | meters | End-effector position in base frame |
| ``follower/abs_rot_6d`` | float64[6] | radians | 6D rotation representation (first two columns of rotation matrix) |
| ``follower/gripper_position`` | float64[1] | [0, 1] | Normalized gripper (0=open, 1=closed) |

**Observation space (proprioception):**

| Key | Dtype | Description |
|---|---|---|
| ``robot_state/cartesian_position`` | float64[3] | End-effector position (base frame) |
| ``robot_state/cartesian_velocity`` | float64[6] | End-effector twist (vx, vy, vz, wx, wy, wz) |
| ``robot_state/gripper_position`` | float64[1] | Normalized [0, 1] |
| ``robot_state/joint_positions`` | float64[7] | Joint positions (rad) — for debugging |
| ``robot_state/joint_velocities`` | float64[7] | Joint velocities (rad/s) — for debugging |

Note: the joint-level keys are **supplementary** — included for diagnostics
and debugging but not required by DROID policies.  The Cartesian keys are the
primary interface.

**Gripper normalization — finish Phase 17 work.**  Both the stock Franka hand
and Robotiq gripper must report normalized [0, 1] in ``gripper_position``:

- Stock Franka: ``normalized = 1.0 - grip.width / grip.max_width``
  (``max_width = 0.08`` m for the standard Franka hand).
- Robotiq: ``normalized = 1.0 - bits / 255.0`` (already done in Phase 17).

This ensures the same policy works with either gripper.

**Manifest changes.**  The manifest communicates available action/observation
keys to c3po.  When the Franka driver detects DROID mode (config flag
``droids_compatible: true``), it publishes the Cartesian action keys instead of
joint position keys.  c3po sees the DROID interface and sends/receives
Cartesian actions without any special casing.

**Files to create / adapt:**

```
r2d2/src/r2d2/_franka/
├── _ik.py                   # NEW: CartesianIK wrapper around franky.Kinematics
├── robot.py                 # ADAPT: add send_action_cartesian(), get_observation() returns Cartesian keys
└── config.py                # ADAPT: add droids_compatible flag
```

#### Task 19.1: Cartesian IK layer in FrankaRobot (4 tests)

**Files**: NEW ``r2d2/src/r2d2/_franka/_ik.py``,
ADAPT ``r2d2/src/r2d2/_franka/robot.py``

- ``CartesianIK(robot)``: wraps ``franky.Kinematics`` with a configurable
  null-space posture (default: current joint positions at connection time).
- ``solve(target_pose, current_joints)`` → joint positions (7 floats).
  Catches ``franky.KinematicsException`` (no valid IK solution) and returns
  ``None`` — r2d2 skips the cycle rather than sending a bad target.
- ``FrankaRobot.send_action(action)``: if ``droids_compatible`` mode, extract
  ``abs_pos`` + ``abs_rot_6d``, construct ``Affine``, call ``CartesianIK.solve()``,
  then send joint positions via ``JointMotion``.  If IK fails, log warning and
  skip the cycle (arm holds position).
- Gripper target extracted from ``gripper_position`` key, denormalized to width
  in meters, sent to gripper as before.
- **Tests**: valid Cartesian target produces joint positions, IK failure returns
  None and arm holds position, position-only target (no rotation change) works,
  translation + rotation target works, null-space posture affects elbow angle.

#### Task 19.2: DROID-aligned observation space (2 tests)

**Files**: ADAPT ``r2d2/src/r2d2/_franka/robot.py``

- ``get_observation()`` in DROID mode returns Cartesian keys alongside joint
  keys.  Read ``robot.current_pose`` (end-effector affine) and
  ``robot.current_twist`` (Cartesian velocity) from franky.
- Decompose ``current_pose`` into ``cartesian_position`` (translation vector)
  and ``abs_rot_6d`` (first two columns of rotation matrix — 6 floats).
- Gripper position always normalized to [0, 1].
- Joint keys included as supplementary data (``joint_positions``,
  ``joint_velocities``) for debugging/training auxiliary objectives.
- **Tests**: observation dict contains all DROID keys with correct shapes
  (pos=3, rot_6d=6, grip=1), Cartesian position matches franky's
  ``current_pose``, rotation 6D representation is orthonormal (first two
  columns of SO(3) matrix).

#### Task 19.3: Action space validation + error handling (2 tests)

**Files**: ADAPT ``r2d2/src/r2d2/_franka/robot.py``

- Validate that incoming actions in DROID mode have the expected keys and
  dtypes.  Reject with a clear error if keys are missing or shapes are wrong.
- IK failure handling: if ``CartesianIK.solve()`` returns ``None``, skip the
  cycle, increment a counter, log at WARNING level (rate-limited to 1/s).
  Send a ``action_rejected`` StatusMessage to c3po so the researcher knows
  the arm is holding position.
- Joint limit enforcement: verify IK solution joints are within Franka's
  joint limits (``robot.joint_limits``).  If any joint exceeds its limit by
  >0.01 rad, skip the cycle and warn.
- **Tests**: missing key raises clear error, IK failure increments skip counter
  and sends StatusMessage, joint limit violation is caught, rate-limited
  logging does not spam.

#### Task 19.4: Manifest updates for Cartesian action keys (1 test)

**Files**: ADAPT ``r2d2/src/r2d2/_franka/robot.py``,
ADAPT ``r2d2/src/r2d2/_manifest.py``

- When ``droids_compatible: true``, the manifest advertises Cartesian action
  keys (``follower/abs_pos``, ``follower/abs_rot_6d``,
  ``follower/gripper_position``) and observation keys
  (``robot_state/cartesian_position``, ``robot_state/cartesian_velocity``,
  ``robot_state/gripper_position``).
- c3po's ``Robot.action_keys`` and ``Robot.observation_keys`` reflect
  Cartesian keys — policies can read these to auto-configure their IO.
- **Test**: manifest contains Cartesian keys when droids_compatible=true.

**Station config — DROID mode flag:**

```yaml
robot:
  type: franka
  ip: 172.16.0.2
  droids_compatible: true
  gripper:
    type: robotiq
    device_id: 9
    speed: 150
    force: 100
  cameras:
    wrist_zed:
      type: zed
      serial_number: 41234567
      resolution: HD720
      fps: 30
      publish_depth: true
    scene_zed:
      type: zed
      serial_number: 41234568
      resolution: HD720
      fps: 30
      publish_depth: false
```

---

### Phase 20: Lightweight LeRobot v3.0 Dataset Parser (c3po)

**Goal**: Let researchers read LeRobot v3.0 datasets (parquet + MP4) without
installing the full ``lerobot`` package.  This directly supports n-droids'
core value prop: minimal dependencies on the researcher's machine.

**Design**.  A new ``c3po.data`` submodule that reads the on-disk format
produced by r2d2's ``DatasetRecorder``.  Dependencies: ``pyarrow`` (already a
c3po dependency), ``av`` or ``opencv-python-headless`` for MP4 decoding.

#### Task 20.1: Episode reader — parquet + video (5 tests)

**Files**: NEW ``c3po/src/c3po/data/__init__.py``, ``c3po/src/c3po/data/_reader.py``

- ``EpisodeReader`` class: opens a chunk directory, reads parquet files in
  episode order, decodes MP4 videos lazily.
- Handle depth frames stored as PNG sequences.
- **Tests**: read single-episode dataset, video frame count matches parquet
  frame count, depth PNG sequence, missing video directory handled gracefully.

#### Task 20.2: Dataset metadata — info.json + stats.json (2 tests)

**Files**: ADAPT ``c3po/src/c3po/data/_reader.py``

- Parse ``meta/info.json`` and ``meta/stats.json`` into typed dicts.
- Expose ``fps``, ``robot_type``, ``total_episodes``, ``total_frames``.
- **Tests**: info fields match, stats contain all expected features.

#### Task 20.3: Public API — ``open_dataset`` context manager (2 tests)

**Files**: ADAPT ``c3po/src/c3po/data/__init__.py``

- ``open_dataset(path)`` returns a ``Dataset`` object with ``info``, ``stats``,
  ``episodes()`` iterator, ``__len__()``.
- Each frame is a dict with string keys and numpy array values.
- **Tests**: context manager clean lifecycle, iteration, frame dict keys, len.

---

### Phase 21: c3po Live View (tabled)

**Goal**: A lightweight popup window showing live camera feeds and joint
torque plots during teleop data collection.  Helps the operator see what the
robot sees without needing a separate monitor or VNC session.

**Key design decision**: This is an **optional extra**, not part of c3po core.
It lives in a separate ``c3po.viewer`` submodule (or a standalone
``c3po-live`` entry point) with extra dependencies (``opencv-python-headless``
or ``matplotlib``).  c3po's core dependency footprint stays at 3.

#### Task 21.1: Camera feed window (2 tests)

**Files**: NEW ``c3po/src/c3po/viewer/__init__.py``

- ``LiveViewer(robot)``: opens a persistent OpenCV window showing the latest
  frame from each camera, updated on every ``step()`` call.
- Multiple cameras are tiled in a grid layout (e.g., 2 cameras → side by side).
- Press ``q`` or close the window to stop the viewer (does not affect the
  robot connection).
- **Tests**: window opens without error (headless test with mocked OpenCV),
  multiple camera feeds are tiled correctly.

#### Task 21.2: Joint torque / position plot (1 test)

**Files**: ADAPT ``c3po/src/c3po/viewer/__init__.py``

- A rolling matplotlib plot (or a simple terminal ASCII plot) of joint
  torques and positions over the last N seconds.
- Auto-scaling y-axis, color-coded per joint.
- Updates once per episode or on a configurable interval.
- **Test**: plot data accumulates correctly over multiple steps, data
  clears on reset.

---

### Phase 22: BOX Dataset Upload (r2d2)

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

#### Task 22.1: BOX upload client (4 tests)

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

#### Task 22.2: r2d2 — wire upload into StopRecording flow (3 tests)

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

#### Task 22.3: Server config — BOX token from environment (2 tests)

**Files**: ADAPT ``r2d2/src/r2d2/_server.py``

- ``create_server()`` reads ``BOX_TOKEN`` from the environment.
- Pass the token (or ``None``) through to ``_ConnectionHandler`` so the
  background task can access it.
- Add a ``--box-token`` CLI flag to ``main()`` as an alternative to the
  env var (useful for Docker secrets).
- **Tests**: token read from env var, token passed through to handler,
  None when not configured.

---

### Phase 23: Remote Lab Server as Inference Machine (design tabled)

**Goal**: Support running c3po on a lab server (not physically cabled to the
NUC) for large policy inference that doesn't fit on a laptop.  The protocol is
TCP/WebSocket over IP — it's network-agnostic by design, so no code changes
are needed.  The decision is purely operational.

**Latency analysis.**  On a same-rack lab network, RTT is 1–2 ms — negligible
at 50 Hz (2.5–10% of a 20 ms cycle).  The NUC's control loop runs
independently; network latency only affects when c3po's ``step()`` returns.
For cross-campus or WAN links (>20 ms RTT), direct teleop becomes unusable,
but policy rollouts with buffered actions could still work.

**Three options documented (decision deferred):**

| | Option A: Single-homed | Option B: Dual-homed (rec.) | Option C: Multi-IP |
|---|---|---|---|
| NUC config | One Ethernet port on lab network (static IP e.g. ``192.168.1.50``) | Primary port on lab network + USB Ethernet adapter for direct-connect (``10.42.0.1``) | Same as A, but also assign ``10.42.0.1`` as a secondary IP on the same interface |
| Direct cable access | ❌ (lab network required) | ✅ (both paths available) | ✅ (temporary, assign ``10.42.0.2`` on researcher's machine) |
| Setup effort | Minimal | Moderate (USB adapter + netplan) | Low (``ip addr add``, same as current) |
| Best for | Pure remote use, no walk-up researchers | Mixed-use lab (some remote, some direct) | Quick remote access with direct fallback |

**Future additions (when selected):**

- WebSocket keepalive (ping/pong at 5 s intervals) — prevents silent TCP
  drops on shared networks.  ``websockets`` library supports this natively.
- Auto-reconnection in c3po with exponential backoff (1s → 2s → 4s → max 30s).
  On reconnect, re-send ``DescribeRequest`` and resume recording state.
- Firewall guidance: restrict port 9090 to lab server IP range.  Never expose
  to the internet.

---

### Phase 24: Operational Maturity Roadmap (tabled)

**Goal**: Transform N-Droids from a solo-developer research prototype into a
maintainable, collaborative-grade software project.  Items are prioritized by
impact-to-effort ratio.  Everything below is deferred — the immediate priority
Franka + ZED + Robotiq support for the DROID project.

#### 24.1: CI/CD Pipeline (GitHub Actions) — highest priority

**Why**: 257 tests with zero automation.  Every change is tested manually on
one machine.  A CI pipeline catches regressions before they reach hardware.

**How**: ``.github/workflows/ci.yml`` with three jobs:

1. **Lint** — ``uv run ruff check`` + ``uv run ruff format --check`` on both repos
2. **Test c3po** — ``uv run pytest tests/ -v`` (135 tests, ~30 s)
3. **Test r2d2** — ``uv run pytest tests/ -v`` (121 tests, ~30 s, skip LeRobot
   import tests in CI)
4. **Docker build** — ``docker build -t r2d2:ci .`` catches Dockerfile regressions

Uses ``astral-sh/setup-uv@v5`` for zero-config ``uv`` caching.  Estimated
setup time: 1–2 hours.

#### 24.2: Protocol de-duplication — high priority

**Why**: ``_protocol.py`` (344 lines) is manually duplicated in both repos.
Divergence causes silent incompatibility — a time bomb for a two-process
communication system.

**How**: Extract to a tiny ``n-droids-protocol`` package (zero dependencies,
stdlib only).  Both c3po and r2d2 depend on it via ``pip install``.  The
protocol can be versioned independently (bump 1.0 → 1.1 when adding a new
message type).  For local development, use ``uv``'s path dependency:

```toml
[tool.uv.sources]
n-droids-protocol = { path = "../n-droids-protocol", editable = true }
```

#### 24.3: Linting & Formatting (Ruff) — high priority

**Why**: Consistent style catches real bugs (unused imports, undefined names,
mutable defaults).  Ruff is fast (Rust) and replaces a dozen tools.

**How**: Add ``[tool.ruff]`` to each ``pyproject.toml`` with rules for
pycodestyle, pyflakes, isort, pyupgrade, bugbear, comprehensions, and
simplify.  Run ``uv run ruff check . --fix`` once, then enforce in CI.

#### 24.4: Pre-commit Hooks — medium priority

**Why**: Catches issues before they're committed (trailing whitespace, YAML
syntax errors, accidentally committed secrets).  Prevents the "CI is red →
fix → push again" loop.

**How**: ``.pre-commit-config.yaml`` with ruff, trailing-whitespace,
end-of-file-fixer, check-yaml, check-toml, detect-private-key.

#### 24.5: Type Checking (Mypy) — medium priority

**Why**: The protocol layer is a contract between two processes.  A type error
means garbled messages, not a clean exception.

**How**: Start gradual — strict mode on ``_protocol``, ``_safety``, ``_utils``,
and ``exceptions`` modules.  Loose mode on everything else.  Add
``[tool.mypy]`` to ``pyproject.toml``.

#### 24.6: Docker Image CI + Container Registry — medium priority

**Why**: The Dockerfile clones LeRobot from GitHub and applies patches.  If the
repo moves or patches stop applying cleanly, the image silently fails to build.

**How**: Add a Docker build job to CI (above).  Push built images to GitHub
Container Registry (GHCR) on main branch pushes.

#### 24.7: Dependency Update Automation — low priority

**Why**: Dependencies ship security patches.  Automated PRs let you review
and merge on your schedule.

**How**: Enable Dependabot on GitHub (Settings → Code security → Dependabot),
or add ``.github/dependabot.yml``.  Dependabot supports ``uv.lock`` natively.

#### 24.8: Conventional Commits + Auto-Changelog — low priority

**Why**: When c3po is published to PyPI, users need to know what changed.
Manual changelogs are always forgotten.

**How**: Adopt Conventional Commits (``feat:``, ``fix:``, ``docs:``) for commit
messages.  Use ``commitizen`` to auto-bump versions and generate
``CHANGELOG.md``.

---

### Phase 25: Ubuntu 24.04 LTS Migration

**Goal**: Migrate the NUC and all development workflows from Ubuntu 22.04
LTS to 24.04 LTS (Noble Numbat).  Ubuntu 22.04 enters end-of-standard-support
in April 2027; franky and ZED SDK ship first-class 24.04 packages now.
Proactive migration avoids a rush when 22.04 security updates stop.

**Why this matters for n-droids specifically:**

- **franky** ships pre-built wheels tested against Ubuntu 24.04.  While 22.04
  wheels also exist, 24.04 is the primary target for ongoing development.
- **ZED SDK 5.x** requires CUDA 12.x, which has better support on 24.04's
  newer kernel and GCC toolchain.  22.04's default GCC 11 has known issues
  with certain CUDA 12 features.
- **PREEMPT_RT kernel** via Ubuntu Pro is available for both 22.04 and 24.04,
  but 24.04 ships a newer RT kernel (6.8.x-rt vs 5.15.x-rt) with better
  scheduling latency for the Franka FCI loop.
- **Python 3.12** is the default in 24.04, matching r2d2's ``requires-python``
  and the Docker base image.  22.04 defaults to Python 3.10.

#### Task 25.1: NUC OS upgrade (no tests)

**Files**: ``n-droids/network_setup.md``, ``n-droids/usb_setup.md``

- Upgrade the NUC from 22.04 to 24.04.  Recommended path: clean install
  (``ubuntu-24.04.1-live-server-amd64.iso``) rather than ``do-release-upgrade``.
  A clean install avoids accumulated cruft from kernel modules, Docker
  versions, and NVIDIA driver fragments.
- Re-enable Ubuntu Pro and the real-time kernel:

  ```bash
  sudo pro attach <token>
  sudo pro enable realtime-kernel
  sudo reboot
  ```

- Re-install NVIDIA drivers + CUDA with the franky-provided RT compatibility
  script (``install_cuda_realtime.bash``) or manually with
  ``IGNORE_PREEMPT_RT_PRESENCE=1``.
- Re-install ZED SDK 5.x — verify cameras enumerate correctly.
- Re-install Docker Engine (``docker-ce`` from Docker's official repo, not
  the snap).  Verify ``docker run hello-world``.
- Re-create the ``realtime`` group and limits (``/etc/security/limits.conf``).
- Update ``network_setup.md``: interface naming changed between 22.04 and
  24.04 (``enx*`` predictable names are stable, but netplan syntax differs
  slightly).  Document the 24.04-specific netplan YAML.
- Update ``usb_setup.md``: ``/dev/serial/by-path/`` symlinks are kernel-version
  dependent.  Verify and re-document paths after the upgrade.

#### Task 25.2: Development environment — Python version alignment (no tests)

**Files**: ``r2d2/pyproject.toml``, ``c3po/pyproject.toml``

- r2d2: already ``requires-python = ">=3.12"`` — no change needed.
- c3po: currently ``requires-python = ">=3.10"``.  Bump to ``>=3.12`` to
  match r2d2 and the 24.04 system Python.  c3po uses only stdlib, numpy,
  Pillow, and websocket-client — all support 3.12 with no API changes.
  Update the c3po ``.python-version`` file if present.
- Regenerate both ``uv.lock`` files on Python 3.12:

  ```bash
  cd c3po && uv lock && cd ../r2d2 && uv lock
  ```

- Run both test suites on Python 3.12 to verify no regressions.

#### Task 25.3: Docker base image bump (no tests)

**Files**: ``r2d2/Dockerfile``

- Change ``FROM python:3.12-slim`` → ``FROM python:3.12-slim-bookworm``
  (explicitly pin Debian version — ``slim`` tracks the latest stable,
  currently Bookworm, but explicit is safer for reproducibility).
- Verify that ``libusb-1.0-0``, ``libglib2.0-0``, ``libgl1``, ``libglfw3``
  are available at the expected versions in the new base.
- Verify ``setcap cap_sys_nice+ep`` works in the new image.
- Build and test the Docker image on the upgraded NUC with ``docker build -t
  r2d2:latest . && docker run --rm r2d2:latest --toy``.

#### Task 25.4: CI — add Python 3.12 + 24.04 build matrix (no tests, deferred to Phase 24.1)

- When the CI pipeline is set up (Phase 24.1), include Python 3.12 in the
  test matrix for both c3po and r2d2.  Drop Python 3.10 from the c3po matrix
  once ``requires-python`` is bumped to ``>=3.12``.

---

### Recent Robustness Fixes ✅

**Flaky spec test fix (2026-07-30).**  ``test_spec_returns_expected_keys`` in
``test_server_spec.py`` intermittently failed because ``effective_control_rate``
was ``0.0`` when the spec was queried before the control loop had completed a
cycle (empty ``_cycle_durations`` deque).  Fixed by making
``_send_spec_response`` fall back to ``1.0 / self.period`` (the target rate)
when no cycles have been measured yet.  All 4 spec tests now pass reliably.

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
| Phase 13 (LeRobot v0.6.0 bump) | — | — |
| Phase 14 (ReBot B601-DM) | — | 18 (4 skipped) |
| Phase 15 (Controller architecture) | 3 | 27 |
| Phase 16 (Franka) | --- | 16 ✅ (hardware-verified, Panda srv5) |
| Phase 17 (Robotiq gripper) | — | 28 ✅ (hardware-verified) |
| Phase 18 (ZED) | — | 22 ✅ |
| Phase 19 (DROID alignment) | — | — (planned) |
| Phase 20 (c3po dataset parser) | — (planned) | — |
| **Running total** | **137 (2 skipped)** | **187 (5 skipped, 0 failures)** |

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
| ReBot B601-DM config + launch scripts | ✅ (manifest + mapping proven in tests) |
| ReBot bimanual leader-follower teleop | ✅ (hardware-verified) |
| Controller abstraction (`Controller` dataclass) | ✅ |
| Manifest-driven capabilities (`controller_capabilities`) | ✅ |
| Auto-reset (leader → home on connect) | ✅ (hardware-verified on SO-101) |
| Haptic feedback stub (`.current` → `send_feedback`) | ✅ (stub, gates on capability) |
| No-camera station config | ✅ |
| Franka Panda teleop (JointMotion, 10 Hz sinusoidal) | ✅ (hardware-verified, error ~0.04 rad RMS, no accumulation) |
| Franka Panda config + launch script | ✅ (server v5, libfranka 0.9.2, PREEMPT_RT on NUC) |
| Franka Panda Docker integration (franky-control + setcap) | ✅ |
| Robotiq 2F-85 gripper connect + activate (pyrobotiqgripper v3.3.13) | ✅ (hardware-verified, device 9, /dev/ttyUSB0) |
| Robotiq 2F-85 live state + move at 50 Hz | ✅ (hardware-verified, bounded ~0.03 m tracking error) |
| Robotiq 2F-85 Docker integration (USB serial passthrough) | ✅ |
| Franka tracking error analysis (test_franka.py) | ✅ (per-joint mean/max/RMS, no error accumulation) |

---

## Phase 26: Audit fixes + third-party plugin architecture (2026-08-16)

Post-audit work: fixed the audited bugs and replaced the
"copy driver files into the vendored LeRobot tree" Dockerfile hack with
LeRobot's third-party plugin mechanism.

### Bug fixes

- ZED driver: depth was silently dead end-to-end (the driver never set
  public `use_rgb`/`use_depth` attributes, and the config field was
  `publish_depth` instead of LeRobot's `use_depth`).  Renamed the field
  and fixed the attribute wiring.  Depth dtype fixed: the SDK returns
  float32 metres via `MEASURE.DEPTH`; the driver now converts to uint16
  millimetres (invalid pixels → 0, clipped), matching RealSense and the
  `RAW_DEPTH` wire format.  Tests previously mocked uint16 directly,
  encoding the wrong assumption — now they test the conversion.
- Franka driver: removed the double Robotiq instantiation (a leaked
  Modbus connection), dead `try: pass except:` cleanup blocks, and the
  standalone/deployed drift (blocking `move()` vs `asynchronous=True`;
  `current_state` vs `current_joint_positions/velocities`).  Robotiq
  `close()` is now called on disconnect.  Cameras read via
  `read_latest()`.
- Recording: `Configure` mid-recording now updates the recorder fps;
  `stats.json` aggregates all chunks (was chunk-000 only); info.json
  totals/total_chunks refreshed at finalize.
- Server: failed/absent describe handshakes now close the connection;
  `smoke_test.py` used the wrong obs key (`joint_position` → toy arm
  key) and is fixed; stale `recording_stopped` TODO removed (the path
  works; test re-enabled).
- Watchdog: docstrings now state honestly that it is a monitoring alarm,
  not a stop mechanism.
- Deleted the stale `utils-no-torch.patch` and `__init___lerobot.py`.
- Docs: c3po README (`Recording`/`wait_until_any`, rate param), toy-so101
  README KBD_STEP default, controller-less guards in teleop/record,
  n-droids README PREEMPT_RT caveat for Franka, duplicated Robotiq
  section removed, ZED install guide bogus `wget https://nvidia.com`
  fixed, r2d2 README tree/§4/§5 updated.
- Dockerfile: pinned the franky wheel bundle URL to release v1.1.4
  ("latest" no longer ships the libfranka_0-9-2 zip); added .dockerignore.

### Plugin architecture

The Franka robot, ZED camera, and Robotiq gripper drivers moved out of
`r2d2/src/r2d2/_franka|_zed|_robotiq` into two installable third-party
LeRobot plugin packages:

```
plugins/lerobot_robot_franka/   # FrankaRobot + GripperConfig + Robotiq wrapper
plugins/lerobot_camera_zed/     # ZedCamera + ZedCameraConfig
```

Each is a single source of truth per device (no standalone/registered
duplication).  The driver classes fall back to a plain-object base when
LeRobot isn't importable so unit tests run with mocked SDKs; the config
modules register via `@RobotConfig.register_subclass("franka")` /
`@CameraConfig.register_subclass("zed")`, discovered by LeRobot's
`register_third_party_plugins()`.  The Dockerfile `pip install --no-deps`s
the plugins (LeRobot comes from PYTHONPATH) instead of COPYing files into
the vendored tree; r2d2's `_config.py` calls
`register_third_party_plugins()` and imports the plugin configs.

Test totals after the change: r2d2 121 (+5 skipped) without LeRobot,
127 (+4 skipped) with a patched LeRobot v0.6.0 on PYTHONPATH; plugins 68
(+2 skipped) without LeRobot and 83 with; c3po 135 (+2 skipped).

### Follow-up: ZED bindings fix (2026-08-16)

On the DROID NUC, `franka_zed.sh` failed inside the container with
`ModuleNotFoundError: No module named 'pyzed.sl'`.  Cause: the script
volume-mounted the host's `/usr/lib/python3/dist-packages/pyzed`, which
is built for the distro Python 3.10, into the container's Python 3.12
site-packages — the `sl.cpython-310-*.so` extension doesn't match the
3.12 ABI tag.  Fix: bake a CPython-3.12 pyzed wheel from Stereolabs
(`https://download.stereolabs.com/zedsdk/{VER}/whl/linux_x86_64/pyzed-{VER}-cp312-cp312-linux_x86_64.whl`,
`ZED_SDK_VERSION=5.1` build arg) into the image; the launch script now
mounts only the native libs (`/usr/local/zed/lib` and `/usr/local/cuda`,
added to `LD_LIBRARY_PATH`).  Verified in a rebuilt linux/amd64 image:
`import pyzed.sl` fails only on the missing host `.so` libs, and toy-mode
E2E still passes.

### Follow-up: ZED SDK 5.4.1 on the NUC (2026-08-16)

The NUC reports ZED SDK 5.4.1.  Stereolabs publishes pyzed wheels per
SDK *minor* series (no patch wheels): host SDK 5.4.1 uses the `pyzed-5.4`
wheel under `/zedsdk/5.4/`.  Dockerfile updated: `ARG ZED_SDK_VERSION=5.4.1`
with the RUN step stripping the patch (`${ZED_SDK_VERSION%.*}`) to build the
wheel URL.  Docs (franka_setup.md, plugin README) updated to match.
Verified in a rebuilt linux/amd64 image: `pyzed 5.4` installed with the
cp312 extension; import fails only on the host-mounted `libsl_zed.so`.

### Follow-up: NVIDIA driver libs in the ZED container (2026-08-16)

Next failure on the NUC: `ImportError: libcuda.so.1: cannot open shared
object file` at `import pyzed.sl`.  The bindings now load (cp312 wheel
works); the missing piece is the NVIDIA *driver* library, which is not in
`/usr/local/cuda/lib64` and is normally injected into containers by the
NVIDIA Container Toolkit.  `franka_zed.sh` now passes `--gpus all` (and
resolves the host CUDA dir via `readlink -f /usr/local/cuda` for the
runtime mount).  franka_setup.md gained an nvidia-container-toolkit
install step + verification command and troubleshooting rows for
`libcuda.so.1` / `could not select device driver [[gpu]]`.

### Follow-up: ZED system runtime libs (2026-08-16)

After --gpus all fixed `libcuda.so.1`, the next missing link was
`libpng16.so.16` — a plain system library the python:3.12-slim base
doesn't ship.  Added the canonical ZED SDK runtime set from
Stereolabs' official zed-docker 5.X runtime image to the Dockerfile:
`libpng16-16`, `libgomp1`, `libudev1`.  Verified present in the
rebuilt image via ldconfig.  franka_setup.md troubleshooting now
documents the `ldd /usr/local/zed/lib/libsl_zed.so | grep "not found"`
one-liner for any remaining library gaps.

### Follow-up: libjpeg SONAME shim (2026-08-16)

Next missing link was `libjpeg.so.8` — the ZED SDK is compiled on Ubuntu
(SONAME 8) while the container base is Debian (libjpeg.so.62).  Added
`libjpeg62-turbo` + a `libjpeg.so.8 -> libjpeg.so.62` symlink to the
Dockerfile (verified loads in a rebuilt image).  Added a container-view
`ldd` diagnostic to franka_setup.md so remaining library gaps can be
listed in one shot without rebuilding; noted that libsl_ai.so's
`libnvinfer*.so.10 => not found` is normal (lazy-loaded TensorRT modules,
missing on the host too).

### Follow-up: libjpeg symbol versions + libturbojpeg (2026-08-16)

The container-view ldd showed two remaining ZED load problems: (1) my
libjpeg.so.8 symlink to Debian's libjpeg.so.62 was insufficient — the
loader's symbol-version check failed (`version LIBJPEG_8.0 not found`);
(2) libturbojpeg.so.0 missing.  Debian's libturbojpeg0 Conflicts with
Ubuntu's libjpeg-turbo8, so the Dockerfile now installs Ubuntu's actual
`libjpeg-turbo8` (jammy) and `libturbojpeg0` (2.1.5-3ubuntu2) debs from
archive.ubuntu.com instead of any Debian jpeg packages.  Verified in a
rebuilt image: ldconfig shows both libs; both dlopen successfully.

### Follow-up: CAMERA STREAM FAILED TO START (2026-08-16)

All container library layers are resolved — the SDK now initializes and
reaches `sl::Camera::open()`, which fails with CAMERA STREAM FAILED TO
START (a hardware-access error: exclusive-camera contention, USB 2.0
bandwidth, or cable/firmware).  Added actionable hints to the driver's
ConnectionError for that status, plus host-side and container-side
camera-open bisection diagnostics to franka_setup.md.

### Follow-up: host-side NEURAL/TensorRT + stuck camera (2026-08-16)

Host diagnostic revealed two things: (1) the host SDK install lacks
TensorRT, so the SDK's default NEURAL depth mode fails with
CORRUPTED SDK INSTALLATION (segfault) — the r2d2 driver already uses
PERFORMANCE mode, which avoids this; (2) the crashed host open can leave
the camera in a stuck USB state, a likely cause of the container's
CAMERA STREAM FAILED TO START.  Updated the host diagnostic to use
PERFORMANCE and documented both failure modes in franka_setup.md.

### Follow-up: SYS_NICE bounding set + host camera OK (2026-08-16)

The "docker test not permitted" was `exec /usr/local/bin/python:
operation not permitted` — Linux refuses to exec a file with the
cap_sys_nice file capability unless the capability is in the container's
bounding set, so bare `docker run --entrypoint python` fails while
franka_zed.sh (--cap-add=SYS_NICE) works.  Verified on the amd64 image:
without --cap-add → EPERM, with it → exec OK.  Diagnostics updated.
Host-side camera open with PERFORMANCE depth mode now succeeds
("open: SUCCESS"; PERFORMANCE is deprecated in SDK 5.4.1 in favor of
NEURAL, which needs TensorRT the host lacks — future item, not blocking).

### Follow-up: USB passthrough for ZED enumeration (2026-08-17)

The container diagnostic listed 0 cameras — `--device=/dev/bus/usb:/dev/bus/usb`
(a directory source) doesn't grant the cgroup access USB enumeration
needs, while the bind mount `-v /dev/bus/usb:/dev/bus/usb` (the pattern
the proven ReBot/RealSense launch scripts use) does.  franka_zed.sh now
uses the bind mount + a pre-flight warning if /dev/bus/usb is empty on
the host; docs and troubleshooting updated.
