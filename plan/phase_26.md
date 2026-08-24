# Phase 26: Audit fixes + third-party plugin architecture (2026-08-16)

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

## Follow-up: ZED bindings fix (2026-08-16)

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

## Follow-up: ZED SDK 5.4.1 on the NUC (2026-08-16)

The NUC reports ZED SDK 5.4.1.  Stereolabs publishes pyzed wheels per
SDK *minor* series (no patch wheels): host SDK 5.4.1 uses the `pyzed-5.4`
wheel under `/zedsdk/5.4/`.  Dockerfile updated: `ARG ZED_SDK_VERSION=5.4.1`
with the RUN step stripping the patch (`${ZED_SDK_VERSION%.*}`) to build the
wheel URL.  Docs (franka_setup.md, plugin README) updated to match.
Verified in a rebuilt linux/amd64 image: `pyzed 5.4` installed with the
cp312 extension; import fails only on the host-mounted `libsl_zed.so`.

## Follow-up: NVIDIA driver libs in the ZED container (2026-08-16)

Next failure on the NUC: `ImportError: libcuda.so.1: cannot open shared
object file` at `import pyzed.sl`.  The bindings now load (cp312 wheel
works); the missing piece is the NVIDIA *driver* library, which is not in
`/usr/local/cuda/lib64` and is normally injected into containers by the
NVIDIA Container Toolkit.  `franka_zed.sh` now passes `--gpus all` (and
resolves the host CUDA dir via `readlink -f /usr/local/cuda` for the
runtime mount).  franka_setup.md gained an nvidia-container-toolkit
install step + verification command and troubleshooting rows for
`libcuda.so.1` / `could not select device driver [[gpu]]`.

## Follow-up: ZED system runtime libs (2026-08-16)

After --gpus all fixed `libcuda.so.1`, the next missing link was
`libpng16.so.16` — a plain system library the python:3.12-slim base
doesn't ship.  Added the canonical ZED SDK runtime set from
Stereolabs' official zed-docker 5.X runtime image to the Dockerfile:
`libpng16-16`, `libgomp1`, `libudev1`.  Verified present in the
rebuilt image via ldconfig.  franka_setup.md troubleshooting now
documents the `ldd /usr/local/zed/lib/libsl_zed.so | grep "not found"`
one-liner for any remaining library gaps.

## Follow-up: libjpeg SONAME shim (2026-08-16)

Next missing link was `libjpeg.so.8` — the ZED SDK is compiled on Ubuntu
(SONAME 8) while the container base is Debian (libjpeg.so.62).  Added
`libjpeg62-turbo` + a `libjpeg.so.8 -> libjpeg.so.62` symlink to the
Dockerfile (verified loads in a rebuilt image).  Added a container-view
`ldd` diagnostic to franka_setup.md so remaining library gaps can be
listed in one shot without rebuilding; noted that libsl_ai.so's
`libnvinfer*.so.10 => not found` is normal (lazy-loaded TensorRT modules,
missing on the host too).

## Follow-up: libjpeg symbol versions + libturbojpeg (2026-08-16)

The container-view ldd showed two remaining ZED load problems: (1) my
libjpeg.so.8 symlink to Debian's libjpeg.so.62 was insufficient — the
loader's symbol-version check failed (`version LIBJPEG_8.0 not found`);
(2) libturbojpeg.so.0 missing.  Debian's libturbojpeg0 Conflicts with
Ubuntu's libjpeg-turbo8, so the Dockerfile now installs Ubuntu's actual
`libjpeg-turbo8` (jammy) and `libturbojpeg0` (2.1.5-3ubuntu2) debs from
archive.ubuntu.com instead of any Debian jpeg packages.  Verified in a
rebuilt image: ldconfig shows both libs; both dlopen successfully.

## Follow-up: CAMERA STREAM FAILED TO START (2026-08-16)

All container library layers are resolved — the SDK now initializes and
reaches `sl::Camera::open()`, which fails with CAMERA STREAM FAILED TO
START (a hardware-access error: exclusive-camera contention, USB 2.0
bandwidth, or cable/firmware).  Added actionable hints to the driver's
ConnectionError for that status, plus host-side and container-side
camera-open bisection diagnostics to franka_setup.md.

## Follow-up: host-side NEURAL/TensorRT + stuck camera (2026-08-16)

Host diagnostic revealed two things: (1) the host SDK install lacks
TensorRT, so the SDK's default NEURAL depth mode fails with
CORRUPTED SDK INSTALLATION (segfault) — the r2d2 driver already uses
PERFORMANCE mode, which avoids this; (2) the crashed host open can leave
the camera in a stuck USB state, a likely cause of the container's
CAMERA STREAM FAILED TO START.  Updated the host diagnostic to use
PERFORMANCE and documented both failure modes in franka_setup.md.

## Follow-up: SYS_NICE bounding set + host camera OK (2026-08-16)

The "docker test not permitted" was `exec /usr/local/bin/python:
operation not permitted` — Linux refuses to exec a file with the
cap_sys_nice file capability unless the capability is in the container's
bounding set, so bare `docker run --entrypoint python` fails while
franka_zed.sh (--cap-add=SYS_NICE) works.  Verified on the amd64 image:
without --cap-add → EPERM, with it → exec OK.  Diagnostics updated.
Host-side camera open with PERFORMANCE depth mode now succeeds
("open: SUCCESS"; PERFORMANCE is deprecated in SDK 5.4.1 in favor of
NEURAL, which needs TensorRT the host lacks — future item, not blocking).

## Follow-up: USB passthrough for ZED enumeration (2026-08-17)

The container diagnostic listed 0 cameras — `--device=/dev/bus/usb:/dev/bus/usb`
(a directory source) doesn't grant the cgroup access USB enumeration
needs, while the bind mount `-v /dev/bus/usb:/dev/bus/usb` (the pattern
the proven ReBot/RealSense launch scripts use) does.  franka_zed.sh now
uses the bind mount + a pre-flight warning if /dev/bus/usb is empty on
the host; docs and troubleshooting updated.

## Follow-up: --privileged for ZED USB access (2026-08-17)

Bind mounts of /dev/bus/usb (both --device-dir and -v) still left the
SDK enumerating 0 cameras.  Stereolabs' official Docker docs run ZED
containers with `--privileged` ("grants the container permission to
access the camera connected via USB").  franka_zed.sh now passes
--privileged; diagnostics/troubleshooting updated accordingly.

## Follow-up: ZED calibration download in container (2026-08-17)

Container now sees both cameras (--privileged fixed USB) and opens them;
the remaining failure was calibration: the SDK shells out to `curl` to
download the factory calibration for the camera's serial (not in the
image), and the EEPROM fallback produced an "Invalid calibration file"
(plus the SDK's LC_ALL locale warning).  Fixes: added curl +
ca-certificates to the image; franka_zed.sh now mounts the host's
/usr/local/zed/settings (persistent, reuses host-downloaded calibration)
and sets LC_ALL=C.  Diagnostics/troubleshooting updated.

## Follow-up: station up; arm-motion debugging aid (2026-08-17)

The DROID station now comes up fully in the container (Franka + Robotiq +
2x ZED + server + c3po over Ethernet; ZED frames saved by the client).
Remaining: the arm did not move during test_franka.py.  Fixed the
misleading "Normal for SO-101" overrun log line (now generic) and added
a one-time INFO log of the first Franka action targets for diagnosis.
The 25 Hz loop rate is expected with two ZEDs (grab() blocks ~33 ms
each) — not the motion blocker.  Bisection plan for the user: test with
station.franka.robotiq.yaml (no cameras), larger amplitude, check the
client's Target/Actual table, and watch Franka Desk during the run.

## Follow-up: ZED camera frames not reaching c3po (2026-08-17)

franka_robotiq works (arm moves), franka_zed fails: c3po reset() times
out with all 3 camera keys missing while the server logs show cameras
opened and the control loop streaming joint state — so binary camera
frames never arrive.  The camera send loop swallowed its exceptions
silently; instrumented it: send failures now log with tracebacks, first
frame per camera logs with shape/size, and a 5s heartbeat logs loop
iterations + per-camera sent counts.  Rebuilt image for the next NUC run.

## Follow-up: ZED driver background grab thread (2026-08-17)

Root cause of the frozen arm + bursty observations with cameras: both
the control loop and the camera send loop called the ZED SDK's blocking
grab()/retrieve_measure() on the same cameras, stalling the single
asyncio event loop for seconds at a time (server log showed 28s of
silence; no heartbeats, no "first action" line).  Redesigned ZedCamera
to run a dedicated per-camera grab thread (grab → retrieve RGB → retrieve
depth) and serve non-blocking snapshots from read()/read_latest()/
read_depth()/read_latest_depth() — the same model as LeRobot's
RealSenseCamera.  Updated plugin tests (wait-for-frame helpers, thread
liveness assertions) — 71 plugin + 121 r2d2 tests pass; image rebuilt.

## Follow-up: station fully operational (2026-08-17)

The background-grab-thread redesign fixed the frozen arm: full run
successful (Franka moving, both ZEDs streaming, Robotiq active).  Log
analysis: ZED streams at a steady 30 fps per camera (heartbeat counts
150 frames/5s per camera).  Watchdog lines were the 5 Hz client cadence
equalling the 200 ms (10-cycle) timeout — benign notification noise.
Tracking errors (~0.16 rad RMS at ±0.25 rad amplitude) are the 5%
dynamics velocity cap, not compounding error.  Fixed: test_franka.py
called spec() after the Robot context closed ([spec unavailable]) — now
captured inside the with-block; camera-loop ConnectionClosed warnings
during client disconnect now logged at debug level.

## Follow-up: ZED serial numbers pinned (2026-08-17)

station.franka.zed.yaml now pins camera roles by serial: wrist_zed =
23474280 (ZED 2, the camera that has been opening with depth), scene_zed
= 14452055 (ZED-M).  If the physical mounting is the other way around,
swap the two serial numbers in the config.  Also fixed the outdated ZED
example in the r2d2 README (serial/publish_depth → serial_number/
use_depth/resolution).

## Follow-up: clean camera-loop exit on disconnect (2026-08-17)

The remaining "RGB/depth frame send failed" warnings at session end are
a benign shutdown race: c3po initiates a clean WebSocket close (code
1000), and the independent 30 fps camera loop races 1-3 more sends
before the control loop notices and cancels it.  The camera loop now
returns immediately on ConnectionClosed (instead of warn+break+retry),
and any other send failure still logs a warning.  r2d2 suite passes;
image rebuilt — the NUC image must be rebuilt to pick this up.

## Doc + plan sweep (2026-08-17)

- Phase 18 completion notes added (container integration + hardware
  verification; corrects the phase's wrong "non-blocking ZED" assumption).
- Phase 19 rewritten against the verified π0.5-DROID contract (verified
  from the DROID and openpi sources): 15 Hz, 8D action = joint_velocity
  (7, [-1,1] → ±0.2 rad/step) + gripper_position (1, absolute [0,1]),
  8D state = joint_position + gripper_position, gripper 1=open, wrist +
  exterior images, joint-space only (no IK) — replaces the incorrect
  10D Cartesian draft.
- Hardware-proven table extended with the session's ZED/plugin/container
  results.
- Docs sweep: n-droids README (vendored-tree paragraph, Franka row now
  hardware-verified), franka_setup.md (Ubuntu 22.04, 24.04 noted as
  Phase 25), r2d2 README (runtime deps list, removed the unverified
  "under 400 MB" claim), franka plugin README (com_port note).

## Follow-up: audit II + DROID gripper-convention correction (2026-08-17)

Second audit round.  The important catch is a *plan* bug, not a code
bug: the "gripper is inverted" claim was wrong.

- **DROID gripper convention corrected.**  The previous Phase 19
  rewrite stated "1 = fully open" and called r2d2's Robotiq
  ``normalized_position = bits / 255`` inverted.  Re-verified against
  the code that actually writes and reads DROID data: DROID computes
  ``gripper_position = 1 - width / max_width`` where ``width`` is the
  gripper *opening* in metres (fairo/polymetis' Robotiq client —
  the driver DROID's ``launch_gripper.sh`` starts — returns the opening
  from ``get_pos()``), and DROID's ``reset()`` commands
  ``update_gripper(0)`` → ``goto(width = max * (1 - 0))`` = fully open.
  So **0 = open, 1 = closed**, openpi passes it through unchanged, and
  our current normalization already matches — the proposed flip would
  have introduced a real inversion.  Phase 19.1 rewritten: no flip,
  just an explicit ``droid_gripper_position`` + conversion helpers.
  No gripper.py behaviour change was made.
- **Recording metadata honesty (r2d2).**  ``info.json`` declared camera
  features at the capture resolution with 3 channels while the files on
  disk were stream-resized frames and 1-channel uint16 depth.  Now
  declares the recorded resolution and ``[h, w, 1]`` depth; tests added.
  Native-res recording + depth video format left to Phase 19.5.
- **ZED wedge surfacing (plugin).**  The grab loop's catch-all kept the
  thread alive during persistent SDK failure, so reads served stale
  snapshots forever and the server's ``camera_error`` path never fired.
  The driver now counts consecutive grab failures and
  ``read()``/``read_depth()`` raise after 10, which the server's
  NonBlockingCamera wrapper turns into blank frames + rate-limited
  ``camera_error`` status; recovers automatically when grabs succeed.
  Tests added (zed plugin now 38 tests).
- **Packaging/hygiene.**  Deleted the stale pyc-only
  ``r2d2/src/r2d2/_franka|_robotiq|_zed`` leftovers from the plugin move;
  added ``opencv-python-headless`` to r2d2's declared dependencies (it
  is imported at module load by ``_cameras``/``_server``/``_recording``
  but was Dockerfile-only); fixed the ``_manifest.py`` "fluent.yaml"
  docstring; removed the duplicated "Deferred Phases" heading in
  plan.md.
- **Docs.**  n-droids/r2d2 READMEs corrected: hardware mode sends raw
  (not JPEG) camera frames at the capped streaming resolution; the
  r2d2 "Franka Droid" config example now matches
  ``config/station.franka.zed.yaml`` and points at the Phase 19
  ``station.franka.droid.yaml`` variant.  plan.md gained a deferred
  item: server-side stop on watchdog timeout (r2d2 aborts Franka motion
  instead of only alarming) before long autonomous π0.5 rollouts.
- Suites after the fixes: r2d2 123 passed/5 skipped (2 new recording
  tests), c3po 135 passed/2 skipped (unchanged), zed plugin 38 passed,
  franka plugin 50 passed.

## Follow-up: Phase 19 implemented test-first (2026-08-17)

Tasks 19.1–19.5 implemented after designing the test suite first
(tests written red, then the implementation made them green).  Full
details and the remaining 19.6 hardware steps live in `phase_19.md`
"Phase 19 implementation notes".  Highlights:

- **Gripper**: `droid_gripper_position` in the Robotiq state namespace
  + `width_from_droid_position`/`droid_position_from_width` helpers —
  no normalization flip (DROID is 0 = open, 1 = closed; see the
  convention correction above).
- **Franka driver**: `droid_compatible` + `dynamics_factor` config
  fields; DROID `send_action` (validation → max|v|≤1 normalization →
  ±0.2 rad deltas → joint-limit clip with reject-and-hold via
  `ActionRejectedError`); `gripper_position` observation; the gripper
  leaves the arm's 8-joint position vector in DROID mode.
- **Server**: hardware manifest extracted to
  `build_station_manifest()` (DROID arms advertise
  `command_mode: joint_velocity` + a `gripper` entry); mapping layer
  gained DROID modes; YAML `control_rate` honored with a 15 Hz clamp
  in DROID mode; `action_rejected` status on rejected actions;
  `station.franka.droid.yaml` + `launch_scripts/franka_droid.sh`.
- **Recording**: `DatasetRecorder` feature groups (named state columns
  + `actions` concat + image-key rename, float32) matching openpi's
  converter schema; legacy flat recording unchanged.
- **c3po**: gripper key appended to `action_keys` and observation
  keys from the manifest — no other client changes.
- **toy-so101/test_franka.py**: auto-detects DROID mode (velocity
  actions, [0,1] gripper, reference integrated with the ±0.2 rad
  conversion).
- **Bug found while wiring the with-LeRobot test path**: `_config.py`
  referenced an undefined `logger` in the plugin-discovery failure
  branch — would have masked the real error in the container.  Fixed.
- Test counts after the implementation: r2d2 148 passed/5 skipped
  (159/4 with a patched LeRobot v0.6.0 on PYTHONPATH — including the
  previously-skipped config tests); c3po 139 passed/2 skipped;
  lerobot_robot_franka 77 passed; lerobot_camera_zed 38 passed.
- Remaining: 19.6 hardware validation (15 Hz tracking,
  `dynamics_factor` tuning, optional openpi π0.5 rollout), native-res
  recording, depth video format.

## Follow-up: franky exposes no joint limits (2026-08-18)

First DROID-mode station run crashed on the first action:
``AttributeError: 'Robot' object has no attribute 'joint_limits'`` —
the mocked franky had that attribute but the real v1.1.4 binding does
not (verified against franky's source).  Lesson: when faking an SDK,
fakes must match the real API surface for everything the code under
test touches — the fake's extra attribute masked the mismatch.

Fixed test-first: the fake lost the attribute; joint limits now live in
the driver (built-in Panda table, override via
``FrankaRobotConfig.joint_limits``, validated at construction) with
libfranka's own limit handling as backstop.  Plugin suite 81 tests.
The NUC image must be rebuilt to pick this up.

## Follow-up: DROID-mode thresholds + π0.5 rollout client (2026-08-18)

- **Thresholds were measuring the wrong thing in DROID mode.**  The
  position-mode thresholds (0.02/0.03/0.10 rad) compared the arm
  against a reference that demands ~3 rad/s while the 5% dynamics
  factor caps franky at 0.109–0.131 rad/s (default joint velocity
  limits 2.175/2.61 rad/s from franky ``src/robot.cpp`` × 0.05) — a
  ~27× gap, so every run tripped the thresholds by design.
  ``test_franka.py`` now tracks a velocity-capped reference (per-step
  delta clipped to ``DYNAMICS_FACTOR × limits × dt``) with fidelity
  thresholds on that residual, and reports the policy-vs-cap
  attenuation separately.  Keeping ``dynamics_factor=0.05`` is
  endorsed (franky's documented conservative default; π0.5 is
  closed-loop and compensates).
- **openpi serving deep-dive.**  ``scripts/serve_policy.py`` is
  environment-agnostic (WebSocket + msgpack on :8000; the DROID
  coupling is entirely in openpi's *client* example).  Decision: run
  it stock with ``--env droid``; wrote ``toy-so101/policy_rollout.py``
  — a c3po-based rollout client modeled on ``examples/droid/main.py``
  (chunk reuse with 8-step horizon, gripper binarization, image
  resize-with-pad to 224, Ctrl+C deferral, optional DROID-group
  recording) using the lightweight ``openpi-client`` package, plus a
  ``--fake-policy`` mode smoke-tested in r2d2's test suite.

## Follow-up: rollout chunk horizon + policy warmup (2026-08-18)

First real π0.5 rollout failed on a hardcoded ``(10, 8)`` action-chunk
assert copied from openpi's example client — the example is stale: the
current ``pi05_droid`` config is ``Pi0Config(action_horizon=15)``, so
the model returns ``(15, 8)`` chunks.  The client crashed before
sending any action, which is why the arm stayed still.  Fixes in
``policy_rollout.py``: accept ``(H, 8)`` (validate width == 8, cap the
open-loop horizon at H), a labeled one-shot warmup inference (first
server call compiles XLA/cuDNN, ~30 s on the RTX 5090), and the fake
policy now emits 15-step chunks to mirror the real model.  Unit tests
added; lesson: mirror the *current* checkpoint config in test doubles,
not a stale example file.

## Follow-up: ZED BGR channel bug (2026-08-18)

The ZED SDK returns 4-channel **BGRA** frames; the driver dropped alpha
and published BGR labeled as RGB — π0.5 (trained on RGB) confused red
and blue.  Subtlety: the recording path's ``RGB→BGR`` JPEG conversion
double-swapped the frames back, so recorded MP4s looked correct while
the live policy path was wrong.  Fixed with ``_bgra_to_rgb`` in the
grab thread and sync fallback; channel-distinct fake pixels added so
the fake can't hide order swaps (zed plugin 40 tests).  Image rebuild
required.

## Follow-up: e-stop during rollouts (2026-08-18)

E-stop mid-rollout aborted the in-flight move with franky
``ControlException``, which killed the connection handler (server only
catches ``ValueError``).  Now: the driver translates ``ControlException``
and gripper-backend failures into ``ActionRejectedError`` with
rate-limited automatic error recovery (AER fails while the stop is
held, succeeds after release), the server pushes a rate-limited
``action_rejected`` status and stays connected, and the rollout resumes
once the stop is released.  Also hardened: ``ZedCamera.connect()``
closes the SDK handle on open failure and ``disconnect()`` tolerates a
wedged ``close()``.  Note: the scene ZED ended up stuck at the USB
level (needs replug / host-side USB reset); the e-stop itself should
not affect USB cameras — check power wiring if it recurs.  `usbreset`
inspection on the NUC shows both ZEDs on USB **bus 004** (same
controller; the rest of the devices sit on bus 003): the wedge was
per-device, not bus-wide.  Remedy without replugging:
`sudo usbreset 2b03:f682` (ZED-M) / `2b03:f780` (ZED 2) — documented in
franka_setup.md §5.

## Follow-up: rollout dataset forwarding (2026-08-18)

``policy_rollout.py --record`` now waits for r2d2's async finalization
(``dataset_ready`` status drained via ``step(None)`` + ``on_status`` —
the post-stop observation timeout is expected and handled) and
downloads the LeRobot v3 dataset to ``--record-dest`` on the inference
machine; ``--no-record-download`` opts out.  The ``dataset_ready`` URL
host is now a ``create_server(http_host=...)`` parameter (default
``10.42.0.1``) so the loopback E2E test runs the full
record → finalize → download path against a real HTTP server.

## Follow-up: NUC dataset cleanup + download host fix (2026-08-19)

NUC is control-only storage: added a ``delete_dataset`` protocol
message (both copies) and ``Robot.delete_dataset()``; r2d2 refuses
empty names and in-progress recordings and confirms deletion with a
``dataset_deleted`` status.  ``policy_rollout.py --record`` now
downloads to ``--record-dest`` (with ``~`` expansion) and deletes the
dataset from the NUC after a successful download (``--keep-on-nuc``
opts out; failures keep the data on the NUC).  Fixed a real download
bug: c3po followed the advertised URL's host (the station's static IP)
even when the client reached r2d2 via another address — it now uses the
client's host and the advertised port.  E2E coverage: record → download
→ NUC directory gone; refusal while recording; unknown-name ack.

## Follow-up: download hang — step() never returns without observations (2026-08-19)

The rollout client hung after ``dataset_ready``: the wait drained with
``step(None)``, but ``step()`` only returns on the next Observation —
and after ``stop_recording`` r2d2 stops observations while camera
frames keep streaming at 30 fps, so the drain looped on binary frames
forever.  The fake stations in tests had no cameras, masking it.
Fixed with a new c3po API ``Robot.wait_for_status(event, timeout)``
(ingests while frames stream; returns on the status; raises only on
real disconnection) and made both fakes realistic — the c3po mock
server stops observations after stop_recording but keeps camera frames
and pushes the recording statuses, and the r2d2 DROID E2E fake robot
streams camera frames.  Suites: r2d2 154/5, c3po 143/2.

## Follow-up: DROID control deep dive — direction-preserving scaling (2026-08-19)

π0.5 hovered short of grasp targets; the gripper alternated
part-close/open.  Source-level comparison with the original DROID
pipeline: DROID drives a 1 kHz joint impedance controller with full
dynamics (no scaling factor), so its whole-vector velocity semantics
preserve direction; our preempted Ruckig motion with a
``relative_dynamics_factor`` clips each joint independently — slower
and direction-distorting, which explains the hover.  The gripper
flutter is the policy retrying grasps the arm never reached (same 0.5
binarization as openpi's reference).  Fix: the driver now scales the
velocity delta **uniformly** to the dynamics-capped per-step budget
(direction preserved), with the analysis script's capped-reference
model updated to match.  ``policy_rollout.py`` gained a
``--gripper-threshold`` knob.  Next hardware step: try
``dynamics_factor ≈ 0.2`` for grasping rollouts (DROID runs full
dynamics; 0.2 ≈ 0.44 rad/s is still modest).

## Follow-up: DROID smoothness parity — command LPF + workspace box (2026-08-19)

Task completes at ``dynamics_factor=0.2`` but motion is jerky.
polymetis's ``franka_hardware`` config (DROID's controller) explains
why the original is smooth and safe without any dynamics factor:
1 kHz realtime joint-PD torque loop (``Kq=[40,30,50,25,35,25,10]``,
``Kqd=[4,6,5,5,3,2,1]``) with 15 Hz target updates, a 100 Hz torque
low-pass, a workspace bounding box, and a per-tick SafetyController.
franky can't replicate the torque loop directly (no joint impedance
motion, no runtime target updates) — deferred as a future 1 kHz
``control()``-API project.  Implemented the command-level equivalents:
an exponential velocity low-pass (``velocity_filter_tau``, default
1/15 s) and a workspace bounding box (``workspace_pos_lower/upper``)
that rejects out-of-box motion.  Franka plugin 92 tests.

## Follow-up: torque work branched; main upgrades to franky 2.0 (2026-08-20)

The whole torque-loop saga (DROID robot type → pylibfranka → franky 2.0
impedance → SimpleTorqueMotion → control-box shim) is preserved on the
``torque-saga`` branch (r2d2 0844088 / n-droids 3c3889f; ``origin/main``
still points there).  Main was restored to the working π0.5 rollout
state (r2d2 422cd61 / docs 5f070e9) and then received the franky **2.0**
upgrade on its own: the Dockerfile installs the
``franky_control 2.0.0+libfranka.0.9.2`` cp312 wheel via
``FRANKY_VERSION``/``FRANKY_LIBFRANKA`` args, the franka plugin adapted
its one breaking API change (``Affine.translation`` is a read-only
property in 2.0) and install hints; the rest of the franky surface
(Robot/Gripper/JointMotion/move/recover_from_errors/state) is verified
identical in 2.0.  Franka plugin 92 tests, r2d2 154/5 + 165/4.

## Follow-up: DROID robot type restored on main (position backend) (2026-08-21)

After the torque-saga branch split, the "DROID as its own unique
robot" deliverable was re-applied to main in its final, working form:
``DroidRobot`` subclasses the franka plugin's ``FrankaRobot`` (control
box's position motion generator — the only gravity mode proven on the
FCI-5 arm), registered as the ``"droid"`` robot type with its own
config (gripper defaults to robotiq, dynamics_factor 0.1), plus
``config/station.droid.yaml`` and ``launch_scripts/droid.sh``
(container ``r2d2-droid``).  No torque-loop code on main — that all
lives on ``torque-saga``.  Suites: droid plugin 9, franka 92, r2d2
154/5 + 167/4.

## Follow-up: DROID mode uses joint-velocity control (2026-08-24)

Hardware run on the restored positional backend showed the expected
"sort of jerky" motion plus ``joint_motion_generator_velocity_/
acceleration_discontinuity`` reflexes.  First-principles fix: the DROID
action IS a joint velocity, and the position-target emulation (velocity
→ ×0.2 rad → Ruckig → preempt at 15 Hz) is what creates profile
discontinuities at every switch (franky seeds new plans from the
previous commanded position/velocity, but the acceleration at the seed
is whatever the new plan needs — the FCI's motion-generator checker
catches the mismatch).  DROID mode now commands franky's
``JointVelocityMotion`` (hold 100 ms, per-motion dynamics factor): the
control box's velocity generator integrates the command with internal
acceleration limits, so 15 Hz velocity preemption is continuous by
construction — no replans, no discontinuity reflexes.  Direction-
preserving scaling, the velocity low-pass, reject-and-hold, workspace
box, and e-stop handling carry over unchanged (delta → velocity via
the measured inter-action time).  Franka plugin 92 tests, full sweep
green.  Hardware verification is the next step; dynamics_factor can be
raised for more speed while staying smooth.
