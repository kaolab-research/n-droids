# Phase 18: Stereolabs ZED Camera Support (r2d2) ✅ (22 tests)

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

#### Phase 18 completion notes (2026-08-17 — hardware-verified on the DROID NUC)

The container integration — unverified when the phase was marked ✅ —
is now fully working end to end.  What actually shipped (superseding the
pre-plan details above):

- The driver lives in the ``lerobot_camera_zed`` third-party plugin
  package (Phase 26) — nothing is copied into the vendored LeRobot tree.
- **The "non-blocking" assumption above was wrong.**  ZED's ``grab()``
  blocks for the next frame (~33 ms at 30 fps); with both the control
  loop and the camera loop calling it, the asyncio event loop stalled
  for seconds, freezing actions and camera streams.  ``ZedCamera`` now
  runs a dedicated per-camera grab thread (grab → retrieve RGB →
  retrieve depth) and serves non-blocking snapshots from ``read()`` /
  ``read_latest()`` / ``read_depth()`` — the same model as LeRobot's
  RealSenseCamera.
- Depth is uint16 millimetres (the SDK returns float32 metres; converted
  with NaN/inf → 0 and clipping), matching the ``RAW_DEPTH`` wire format.
- Config field renamed ``publish_depth`` → ``use_depth`` (LeRobot
  convention); station config pins serials (wrist 23474280 / ZED 2,
  scene 14452055 / ZED-M).
- Container prerequisites discovered the hard way and documented in
  ``franka_setup.md``: pyzed cp312 wheel baked into the image
  (ZED_SDK_VERSION build arg, minor-series wheels), Ubuntu jpeg/turbojpeg
  packages for symbol-version parity, NVIDIA Container Toolkit
  (``--gpus all``), ``--privileged`` for ZED USB enumeration, host
  ``/usr/local/zed/settings`` mount + ``LC_ALL=C`` for calibration,
  libpng/libgomp/libudev system libs.
- Verified on the NUC: 2× ZED open in the container, steady **30 fps RGB
  per camera + 30 fps depth**, ~48–50 Hz control loop, joint/EE motion
  unaffected (see Phase 18 hardware rows below).

---
