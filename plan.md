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

### Phase 11: Status protocol & runtime introspection

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

### Phase 12: Dataset availability & forwarding

**Goal**: Get datasets off the NUC and into the researcher's workflow with
zero friction.

#### Task 12.1: DatasetReady notification (2 tests)

**Files**: ADAPT `r2d2/src/r2d2/_server.py`, ADAPT `c3po/src/c3po/robot.py`

- After `stop_recording` → `finalize()`, r2d2 sends `StatusMessage`
  with `event="dataset_ready"` and payload `{name, path, num_episodes, total_frames, size_bytes}`.
- c3po logs this prominently and exposes `last_dataset_info` property.
- **Tests**: notification sent after recording stop, c3po property populated.

#### Task 12.2: HTTP file server for pull-based transfer (3 tests)

**Files**: ADAPT `r2d2/src/r2d2/_server.py`

- r2d2 runs a lightweight HTTP file server on port 9091 serving `/datasets`.
- Read-only, directory listing enabled, no auth (trusted network).
- c3po's `Robot` exposes `dataset_url` property (`"http://10.42.0.1:9091/datasets/session_001/"`).
- Researcher can `wget -r` or `rsync` from the URL.
- **Tests**: HTTP server serves directory listing, parquet file is downloadable,
  server stops cleanly on shutdown.

#### Task 12.3: HuggingFace Hub upload backend (3 tests, manual integration)

**Files**: NEW `r2d2/src/r2d2/_upload.py`

- Background asyncio task that uploads the dataset directory to HF Hub
  using `huggingface_hub` (already a dependency via LeRobot).
- Auth via `HF_TOKEN` environment variable.
- Configurable in station YAML:
  ```yaml
  upload:
    hf_hub:
      repo_id: "my-lab/so101-datasets"
      private: true
  ```
- Status messages report upload progress.
- **Tests**: upload task created, HF token read from env, failure logged gracefully.

#### Task 12.4: Dropbox upload backend (3 tests, manual integration)

**Files**: ADAPT `r2d2/src/r2d2/_upload.py`

- Same pattern as HF Hub.  Auth via `DROPBOX_TOKEN` environment variable.
- Configurable in station YAML under `upload.dropbox`.
- **Tests**: same pattern as HF tests.

---

### Deferred Phases

These are valuable but postponed in favor of robustness, logging, and dataset
workflow improvements.

- **Franka** (was Phase 10): Panda arm via libfranka.
- **Kinova** (was Phase 11): Gen3 via Kortex API.
- **ZED Camera** (was Phase 12): ZED SDK support.
- **Controller Architecture** (was Phase 13): Powered leaders, haptic feedback, auto-reset.

---

### Test totals

| Phase | Tests |
|---|---|
| Phase 1 | 21 |
| Phase 2 | 57 |
| Phase 3 | 19 |
| Phase 4 | 18 (2 skipped) |
| Phase 5 | 17 |
| Phase 6 | 5 |
| Phase 7 | 12 |
| Phase 8 | 21 |
| Robustness pass | — |
| Phase 9 | 16 |
| Phase 10 | 16 |
| Phase 11 | 9 |
| Phase 12 | 11 |
| **Running total** | **222 (2 skipped)** |

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
| Dataset HTTP transfer | — |
