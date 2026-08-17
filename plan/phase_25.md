# Phase 25: Ubuntu 24.04 LTS Migration

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
| Third-party plugin architecture (lerobot_robot_franka / lerobot_camera_zed) | ✅ (register_third_party_plugins, no vendored-tree copies) |
| ZED in container: pyzed cp312 wheel + host .so mounts + --gpus all + --privileged | ✅ (2× ZED open in container) |
| ZED calibration in container (host settings mount + LC_ALL=C + curl) | ✅ |
| ZED background grab threads (non-blocking snapshots) | ✅ |
| ZED RGB streaming at native rate | ✅ (30 fps per camera, steady) |
| ZED depth streaming (uint16 mm) | ✅ (30 fps, RAW_DEPTH) |
| ZED + Franka + Robotiq simultaneously, ~48–50 Hz control loop | ✅ (hardware-verified) |
| Robotiq direct-port connection (com_port, no auto-detect probing) | ✅ |
| DROID station end-to-end (r2d2 in Docker ↔ c3po over Ethernet) | ✅ |

---
