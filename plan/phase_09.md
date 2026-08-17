# Phase 09: Camera Streaming Resolution ✅
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
