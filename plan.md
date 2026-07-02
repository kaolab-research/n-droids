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

### Phase 8: Multi-Camera Support ← NEXT

**Goal**: Multiple UVC cameras streaming simultaneously, RealSense RGB support,
RealSense depth support, all alongside SO-101 teleop and recording.

**Architecture**: No server code changes needed. The server already iterates over
all cameras in the config. Camera frames are sent as independent binary JPEG
frames — multiple cameras just mean more frames per cycle. The DatasetRecorder
already supports multiple camera keys in `camera_frames`. The only work is
registering `RealSenseCameraConfig` in the config loader.

#### Task 8.1: Register RealSenseCamera in config loader (1 test)

**Files**: ADAPT `r2d2/src/r2d2/_config.py`

Add `RealSenseCameraConfig` to `_CAMERA_REGISTRY`.  No logic changes — the
`_make_camera_config` factory already dispatches on `type`.

#### Task 8.2: Multiple UVC cameras (manual)

**Files**: ADAPT `r2d2/config/station.so101.yaml`

Add a second `opencv` camera entry with a different device index.  Smoke test:
both cameras appear in observations, both produce valid frames in recorded
dataset.

#### Task 8.3: RealSense RGB camera (manual)

**Files**: ADAPT `r2d2/config/station.so101.yaml`

Add a `realsense` camera entry.  Smoke test: RGB frames stream correctly,
appear in recorded dataset.  Verify JPEG bandwidth with 720p frames.

#### Task 8.4: RealSense depth (manual)

**Files**: ADAPT `r2d2/config/station.so101.yaml`, ADAPT `r2d2/_server.py` if needed

Add `publish_depth: true` to the RealSense config.  The server already has a
`depth` encoding constant (`Encoding.JPEG_DEPTH = 1`).  Verify depth frames
appear in observations as `uint16` arrays and in the dataset as depth video.

#### Task 8.5: Multiple RealSense cameras with depth + SO-101 (manual)

Full integration smoke test: 2+ RealSense cameras (RGB + depth) + SO-101
teleop + recording.  Verify dataset completeness and bandwidth under load.

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
| **Running total** | **149 (2 skipped)** |
