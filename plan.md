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

### Phase 8: Camera Transmission Pipeline ← IN PROGRESS

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

### Phase 9: Franka

**Goal**: Franka Panda arm support via libfranka.  Custom `FrankaRobot` class
implementing LeRobot's `Robot` interface.  Same protocol, same c3po, same
recording — only the robot layer changes.

### Phase 10: Kinova

**Goal**: Kinova Gen3 support via Kortex API.  Same pattern as Franka.

### Phase 11: ZED Camera

**Goal**: ZED camera support via ZED SDK.  RGB + depth streaming.  Requires
GPU-equipped NUC for CUDA-accelerated depth computation.

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
| **Running total** | **170 (2 skipped)** |

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
