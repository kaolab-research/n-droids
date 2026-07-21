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

### Phase 9: Camera Streaming Resolution ← PRIORITY
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

### Phase 10: Franka

**Goal**: Franka Panda arm support via libfranka.  Custom `FrankaRobot` class
implementing LeRobot's `Robot` interface.  Same protocol, same c3po, same
recording — only the robot layer changes.

### Phase 11: Kinova

**Goal**: Kinova Gen3 support via Kortex API.  Same pattern as Franka.

### Phase 12: ZED Camera

**Goal**: ZED camera support via ZED SDK.  RGB + depth streaming.  Requires
GPU-equipped NUC for CUDA-accelerated depth computation.

---

### Phase 13: Controller Architecture (powered leaders, boundary)

**Design rationale.**  The current architecture has two categories: `arms`
(receive actions from c3po) and `controllers` (read-only, appear in
observations).  ALOHA-style powered leader arms blur this line — they produce
joint positions AND receive haptic feedback / execute reset motions — but
**the researcher never directly commands a leader arm.**  The leader either
moves passively (pushed by the human) or actively (haptics / reset computed
by r2d2 server-side).  Therefore:

- **No new protocol category is needed.**  Powered leaders remain in the
  existing `controllers` bucket.  Their state streams to c3po in observations;
  any commands they receive are generated within r2d2, not sent over the
  WebSocket.
- **The protocol's `Action` message targets only `arms`** (followers).  The
  researcher commands the follower; the leader follows physics.

**Controller boundary — NUC vs. researcher's machine.**  The dividing line is
**physical coupling to the robot station**:

| Controller | Location | Rationale |
|---|---|---|
| Leader arms (powered or unpowered) | **NUC** | Physically coupled to workcell; needs calibration; part of station config |
| Joysticks, gamepads, SpaceMouse | **Researcher's machine** | Generic HID peripherals; researcher brings their own; reads in policy code with `pygame` / `pynput` / `spacymouse` |
| Keyboard (q/n/r) | **Researcher's machine** | Already handled by c3po's `KeyboardListener` as a small convenience; no additional scope |

**c3po does not become a general controller library.**  The `KeyboardListener`
stays as the only built-in controller convenience.  For joysticks, gamepads,
and SpaceMouse, the researcher imports whatever library they prefer directly
in their policy script — c3po has no opinion and no dependency on HID libraries.

#### Task 13.1: Manifest — add `capabilities` to controllers (3 tests)

**Files**: ADAPT `r2d2/src/r2d2/_manifest.py`, ADAPT `c3po/src/c3po/_manifest.py`

- Add an optional `capabilities: list[str]` field to each controller entry
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
  - `"haptic_feedback"` — controller can receive force/torque feedback from r2d2
  - `"auto_reset"` — controller can move to a home position on initialization
  - Absence of `capabilities` (or an empty list) means a passive sensor-only
    controller (e.g., unpowered SO-101 leader).
- r2d2's `build_manifest()`: include `capabilities` from the station config's
  teleop section when present, default to `[]`.
- c3po's `parse_manifest()`: expose `capabilities` on the parsed controller
  entries so `Robot` can provide a `controller_capabilities` property.
- **Tests**: manifest roundtrip with capabilities, missing capabilities
  defaults to empty list, unknown capability value does not break parsing.

#### Task 13.2: Station config — add teleop capabilities (2 tests)

**Files**: ADAPT `r2d2/src/r2d2/_config.py`

- Add an optional `capabilities` list to the `teleop` section in station YAML:
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
- `StationConfig` dataclass: add `teleop_capabilities: list[str]` field,
  default `[]`.
- `load_station_config()`: parse `capabilities` from the teleop section.
- **Tests**: config with capabilities parses correctly, missing capabilities
  defaults to empty, unknown capability warns but does not error.

#### Task 13.3: r2d2 — haptic feedback loop (4 tests)

**Files**: ADAPT `r2d2/src/r2d2/_server.py`

- In hardware-mode control loop, **after** reading `get_observation()` (which
  includes motor currents for Feetech / libfranka / Kortex arms), compute
  haptic feedback torques and send them to the teleop if it supports it.
- Add a `_send_haptic_feedback(teleop, le_obs, joint_names)` helper:
  - Extract motor currents/efforts from `le_obs`.
  - Map to joint torques using a simple proportional gain (configurable,
    default `0.05`).  Exact mapping is hardware-specific — start with a
    generic interface that each teleop backend can override.
  - Call `teleop.send_feedback(torques)` if the teleop exposes that method.
- The haptic loop runs at the control rate (every cycle).  It must be fast
  (sub-millisecond) — no I/O, just arithmetic + a serial write if the motor
  bus supports it.
- Guard with `"haptic_feedback" in teleop_capabilities` — passive leaders
  skip this entirely.
- **Tests**: haptic loop skipped when capability absent, feedback computed
  from mock observations, feedback not sent when teleop lacks `send_feedback`,
  proportional gain is configurable.

#### Task 13.4: r2d2 — auto-reset on connect (5 tests)

**Files**: ADAPT `r2d2/src/r2d2/_server.py`

- After the `describe` handshake completes in `_handler`, if the teleop
  supports `"auto_reset"`, execute an initialization sequence:
  1. Send the leader to a configured home position (joint-space waypoints).
  2. Wait for the leader to reach each waypoint (position error < threshold).
  3. Once at home, release any active torque and hand control to the human.
- The home position is read from the station config (new `home_position`
  field in the teleop section) or from a calibration file.  If neither
  exists, skip auto-reset and log a warning.
- The reset sequence runs **after** the `describe_response` is sent but
  **before** the control loop starts streaming observations.  This way c3po's
  `reset()` call receives observations from a leader already at its home
  position.
- Add a `leader_home_position` property to `Robot` so the researcher can
  introspect where the leader will reset to.
- **Tests**: auto-reset skips when capability absent, home position read
  from config, reset sequence runs to completion, timeout if leader fails
  to reach home, observations stream only after reset completes.

#### Task 13.5: c3po — expose controller capabilities (2 tests)

**Files**: ADAPT `c3po/src/c3po/robot.py`, ADAPT `c3po/src/c3po/_manifest.py`

- Add a `controller_capabilities` property to `Robot`:
  ```python
  @property
  def controller_capabilities(self) -> dict[str, list[str]]:
      """Mapping from controller name to its capabilities list."""
      return {c["name"]: c.get("capabilities", []) for c in self._manifest["controllers"]}
  ```
- Add a `leader_home_position` property that returns the home position from
  the manifest (if present), or `None`.
- These are informational — the researcher's code can check them but the
  protocol does not change.
- **Tests**: property returns correct capabilities, empty dict for stations
  with no controllers, home position is None when not configured.

#### Task 13.6: Station config — ALOHA-style powered leader example (1 test)

**Files**: NEW `r2d2/config/station.aloha.yaml`

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
| Phase 8 | 21 (+ 4 existing buffer tests adapted) |
| Phase 9 | 17 |
| Phase 13 | 17 |
| **Running total** | **221 (2 skipped)** |

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
