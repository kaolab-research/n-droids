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

## Follow-up: velocity-motion arg fix + ZED roles swapped (2026-08-24)

First hardware run of the joint-velocity mode crashed at the first
action: franky 2.0's ``JointVelocityMotion`` takes a ``franky.Duration``
hold time and ints do not implicitly convert — the driver now passes
``fx.Duration(100)`` (and the target as an ndarray).  Also corrected
the camera roles in all three station configs and the README: the
**ZED-M (14452055) is the wrist camera** and the **ZED 2 (23474280) is
the scene camera**; depth remains on the wrist.  Franka plugin 92
tests, full sweep green.

## Follow-up: rollout misalignment deep dive — dynamics, not interface (2026-08-24)

Full contract audit after the velocity-mode fix: action/state/image
keys, the x0.2 rad/step budget, gripper normalization, and the 15 Hz
rate all match the DROID/openpi standard.  The 'weird' policy actions
trace to realized dynamics: DROID ran FULL dynamics (up to ~2.2 rad/s,
~0.15 rad/step), while our 0.1 dynamics factor capped the arm at
0.22 rad/s (~0.015 rad/step) — 10x slower, so the closed-loop policy
saturated.  station.droid.yaml now runs ``dynamics_factor: 1.0`` (safe
with the velocity backend's internal acceleration limiting).  Camera
roles still need the serial->model verification one-liner on the NUC
(the config comments' mapping was never hardware-verified).

## Follow-up: velocity slew limiting — the real reflex cure (2026-08-24)

Full dynamics (dynamics_factor 1.0) tripped the discontinuity reflexes
nearly every step with jagged motion: 15 Hz velocity preemption jumps
the COMMANDED velocity between extremes, so the commanded acceleration
is discontinuous at every switch — the FCI's checker catches it, and
DROID never had this problem because its torque loop bounded
acceleration physically (torque LPF + rate limiting).  Fix: a
command-level acceleration budget — the commanded velocity is
slew-limited per joint to
``|dq_new − dq_prev| ≤ joint_acceleration_limit × dynamics_factor × dt``
(Panda table, same budget semantics as the velocity caps), and the
velocity hold widened to the libfranka default (1 s) so a late cycle
holds instead of stopping.  This emulates DROID's torque-bounded
acceleration at the command level; the LPF, direction-preserving
scaling, limits, and workspace box are unchanged.  Franka plugin 93
tests.  Also: ZED ``get_device_list()`` returns serial/model 0 INSIDE
the container — run the serial check on the HOST SDK instead; the r2d2
logs also print each camera's serial at open (wrist first, scene
second).

## Follow-up: accel-split dynamics + the real protocol gap (2026-08-24)

Two root causes found in the sources:

1. **Reflexes at full dynamics.**  franky's velocity waypoint motion
   re-seeds Ruckig at every preemption with zero acceleration state, so
   the commanded acceleration jumps at each 15 Hz switch by the old
   ramp's magnitude — scaling with dynamics (empirics: 0.5 clean, 0.7
   marginal, 1.0 constant).  Fix: franky's RelativeDynamicsFactor has
   independent velocity/acceleration/jerk components — DROID velocity
   motions now run at (velocity=1.0, acceleration=0.5, jerk=1.0), with
   the command-stream slew budget using the same 0.5x accel limits, so
   full velocity dynamics stay under the checker threshold.  New
   ``acceleration_factor`` config field (default 0.5).
2. **The 'weird' rollout actions.**  openpi trains the released
   DROID checkpoints with ``action_space=JOINT_POSITION`` — the policy
   outputs ABSOLUTE joint position targets (radians) + gripper, not
   [-1,1] velocities (the DROID TFRecord stores both fields; the loader
   comment confirms 'absolute joint + gripper position actions').  Our
   rollout sent those as velocities x0.2 → constant saturated commands.
   ``policy_rollout.py`` now converts each chunk action:
   v = clip((target - current)/0.2, -1, 1).  Fake policy updated to
   emit position targets.

## Incident: wall collision — root-cause investigation (2026-08-24)

The rollout "jerked super fast and collided with the wall".  Full
command-chain audit, first principles:

**The conversion math is NOT the failure.**  Client v = clip((target −
q)/0.2, ±1) with q fresh from each step's obs → server delta = v × 0.2
= target − q, budgeted ≤ v_limit × dynamics × dt, accel-slew-limited.
No sign error, no double application, no stale-q-within-chunk.

**Three real root causes:**

1. **Workspace box disabled.**  ``station.droid.yaml`` had
   ``workspace_pos_lower/upper`` commented out.  DROID itself ALWAYS
   ran with this gate — it is the layer that stops exactly this failure
   mode.  Re-enabled with the DROID-standard box (arm must start inside
   it; verify/tighten against the real table with get_ee_pos).
2. **Start-pose mismatch.**  Every DROID episode starts at reset_joints
   [0, −π/5, 0, −4π/5, 0, 3π/5, 0]; the checkpoint's absolute targets
   assume it.  From any other pose the conversion pegs at ±1 for the
   whole open-loop chunk → sustained FULL-speed charge (~2.2 rad/s at
   dynamics 1.0).  ``policy_rollout.py`` now refuses to start unless
   every joint is within ``--start-pose-tolerance`` (0.3 rad) of the
   reset pose (override: ``--allow-any-start-pose``), and prints the
   first commanded v as a diagnostic.
3. **Full dynamics during unproven rollout.**  dynamics_factor 1.0
   meant the runaway ran at full joint speed; the accel-split RDF only
   bounds the ramp, not the sustained speed.  Dropped to 0.5 pending
   box + reset-pose validation; 1.0 remains the dataset-standard
   target.

Also added ``--velocity-actions`` to policy_rollout.py: A/B-tests the
checkpoint's action-space interpretation (raw [-1,1] velocities vs
absolute positions) on hardware without code changes — the JOINT_POSITION
conclusion is source-verified but this makes it empirically checkable.

New unit tests (toy-so101/tests/test_policy_rollout.py, 11 tests):
conversion inverse/clip/identity, L∞ start-pose error, gate
pass/refuse/override, CLI wiring, fake-policy boundedness.  r2d2's
rollout smoke tests now place the fake robot at the reset pose so they
pass through the gate like a real deployment.

Suites: r2d2 core 154 ✓ (5 skipped), franka plugin 93 ✓, droid plugin
9 ✓, toy-so101 rollout 11 ✓.

## Frozen spec: DROID's actual control stack (verified from sources) (2026-08-26)

Verified against droid-dataset/droid (both the 2024-03 dataset-adjacent
commit ba46d4af and current main), facebookresearch/fairo (polymetis +
vendored torchcontrol), and libfranka 0.9.2.  This is the behavioural
fidelity target for the rebuilt DROID station.

**Controller — HybridJointImpedanceControl.**  Polymetis's
``start_cartesian_impedance()`` and ``start_joint_impedance()`` launch
the SAME policy (robot_interface.py); DROID calls the former and feeds
``update_desired_joint_positions()`` — consistent, not a mismatch.  The
executed control law (torchcontrol policies/impedance.py +
modules/feedback.py):

    tau = (J^T Kx J + Kq)(q_d - q) + (J^T Kxd J + Kqd)(-dq) + Coriolis + gravity

It is JOINT-space impedance; the Cartesian gains Kx enter only as the
configuration-dependent stiffness augmentation J^T Kx J (significant:
comparable magnitude to Kq at typical lever arms).

**Constants.**  hz 1000; Kq [40,30,50,25,35,25,10]; Kqd [4,6,5,5,3,2,1];
Kx [400,400,400,15,15,15]; Kxd [37,37,37,2,2,2]; torque LPF 100 Hz
(libfranka control(TorqueControl, limit_rate=true, cutoff=100));
torque clamps [86 x4, 11.5 x3] Nm; joint vel limits [2.075 x4, 2.51 x3]
rad/s; workspace box +/-1.0 m (loose); collision thresholds 40 N/40 N;
safety reflexes on Cartesian/joint pos/vel with margins 0.05/0.2/0.5;
auto error recovery loop.

**Gravity is host-side.**  franka_panda_client.cpp adds none; libfranka
torque control is raw (robot.h 0.9.2, issue #98); the RobotModel
(panda URDF + Desk end-effector payload) computes gravity + Coriolis in
the policy.  This DISPROVES the torque-saga shim premise ("control-box
gravity via its internal impedance controller"): FCI impedance mode
never had box gravity — the saga's four host-gravity attempts failed,
host gravity itself was never ruled out.

**15 Hz interface.**  DROID's robot_env converted normalized velocities
to position targets: joint_delta = v x 0.2 (max_joint_delta), |v| <= 1
normalized first (robot_ik_solver.py), gripper [0,1] absolute.  Targets
held by the 1 kHz loop (zero-order hold) until the next 15 Hz update —
exactly the chain our server implements.

**Test tiers with thresholds (the decision instruments).**
- (a) Offline contract vs real TFRecords: for >=95% of steps,
  ||position_action_to_velocity(q_tgt, q_obs) - v_rec||_inf <= 0.05.
- (b) Hardware replay fidelity: median per-step
  ||dq_real - dq_rec||_inf <= 0.04 rad; p95 <= 0.08; cumulative drift
  <= 0.15 rad by step 150; reflex count 0.
- (c) Observation pipeline: exact key match, images 224x224x3 uint8,
  state shapes 7/1, all finite, sustained rate >= 14.5 Hz.

Implementation plan: plan/droid_rebuild.md (branch ``droid-rebuild``);
the Phase 1 test-first contract is plan/droid_rebuild_tests.md.

## Follow-up: Phase 1 implemented (droid-rebuild) (2026-08-26)

Test-first per plan/droid_rebuild_tests.md; hardware runs stay off until
the suites below are green on real fixtures.

- **Collapse:** `lerobot_robot_droid` deleted; one robot type ``franka``
  (DROID protocol unconditional: `droid_compatible` default True,
  gripper default robotiq, dynamics default 0.1); registry drops
  ``"droid"``; `station.droid.yaml` (`type: franka`, explicit
  velocity_filter_tau) + `droid.sh` are the single Franka config/launch;
  the four franka config/launch variants deleted (rebot/so101 untouched);
  Dockerfile drops the droid plugin; README/policy_rollout doc sweep.
- **reset_arm.py wild-motion fix:** homing velocity now clips to
  +-velocity_scale ITSELF (default 0.25 -> <=0.05 rad/step for ANY
  error), not +-1 — the earlier formulation still saturated full-scale
  steps from far poses (the A6 test caught the flaw before hardware).
- **Suites:** r2d2 core 170 passed / 10 skipped (collapse invariants,
  droid contract smoke renamed to test_droid_contract.py, B1 trajectory
  contract skips without fixtures); franka plugin 101 passed / 1 skipped
  (merged defaults, registry collapse, B2 reference-executor harness —
  real driver chain vs the frozen 1 kHz hybrid-impedance reference
  model, J^T Kx J via the Panda DH geometric Jacobian, median<=0.04 /
  p95<=0.08); toy-so101 38 passed (reset profile + closed-loop sim,
  replay/export, B3 observation shape pin).
- **Fixtures:** tests/data/droid/README.md documents the bootstrap
  (export_droid_trajectory.py from the lab TFRecords); Suite B skips
  loudly until real episodes land there.

## Follow-up: homing oscillation diagnosed from logs + box disabled (2026-08-26)

Hardware homing run with per-step pose logging diagnosed the oscillation
mechanism (not a code typo — loop physics):

- **Deceleration ramp, not lag.**  On the first zero-crossing (step 6)
  the command reversed (v=-0.129) but joint 3 kept moving positive for
  ~5 steps with linearly decaying increments (+0.047, +0.038, +0.028,
  +0.020, +0.009) — the velocity generator shedding +0.75 rad/s at the
  stacked ramp rate (generator 0.5x accel + driver slew + 100 ms LPF ≈
  2 rad/s^2 effective).  Overshoot ≈ 0.14 rad = dq^2/2a at a≈2.  The
  pure-P law (gain 1 in the |err|<0.05 zone) reversed the command
  faster than the executor can follow → limit cycle; multi-joint phase
  offsets = the circular EE path; amplitude grew 0.13 → 0.31.
- **Workspace box tripped too.**  EE z ≈ 0.60-0.64 m at the reset-pose
  neighborhood = the DROID-standard box's upper z (0.60) → reject-and-
  hold fired continuously, fighting the client loop.  Box DISABLED in
  station.droid.yaml pending manual measurement of the real workspace
  (the collapsed z-bound test pins the disabled state + rationale).
- **Fix (client):** braking-limited profile v = min(err/0.2,
  sqrt(2a|err|)/3, scale) + command slew (0.05 v/step) — the command
  never demands more deceleration than the ~1.5 rad/s^2 (conservative,
  log-calibrated) the executor can deliver.  Tests extended: the
  realistic station model (LPF + ramp) now REPRODUCES the old law's
  oscillation (regression guard) and the new law converges from sampled
  poses with no overshoot beyond tolerance.  toy 40 tests green.
- r2d2 core 170 passed / 10 skipped.

## Follow-up: client-side homing retired — server-side reset (2026-08-26)

The braking/slew fix tamed the homing oscillation but a bounded limit
cycle persisted (err oscillated 0.03-0.05 rad for ~280 steps) and a
``joint_motion_generator_acceleration_discontinuity`` reflex + violent
arm shot ended the run (e-stop).  The command stream at that moment was
nearly static, so the discontinuity came from INSIDE the velocity chain
(inter-action dt hiccup scaling the slew budget, or the Ruckig re-seed)
— and after reflex + automatic recovery the box resumes with stale
references.

**Structural verdict: client-side velocity-servo homing is retired.**
Three hardware incidents (wall collision, growing oscillation, reflex
shot) all trace to closing an autonomous position loop through the
velocity executor's 15 Hz preemption chain.  First principles: the
control box's position motion generator is the proven mode (its own
gravity, one smooth Ruckig trajectory, zero preemption), and DROID
itself reset with a blocking position move.

- **r2d2:** ``FrankaRobot.reset_arm()`` — ONE blocking
  ``JointMotion(DROID_RESET_JOINTS)`` (gripper opens first, workspace
  check, ControlException → recovery + rejection).  The server's
  ResetEpisode handler runs it in a worker thread BEFORE the episode
  boundary and emits ``arm_reset_complete`` / ``arm_reset_failed``
  statuses; the 15 Hz loop keeps streaming obs during the move.
- **toy-so101:** ``reset_arm.py`` is now a thin wrapper (reset →
  wait_for_status → one zero-velocity step for the settled snapshot →
  verify).  The client servo loop (P → braking → slew) and its sim are
  DELETED (analysis preserved here and in git history); replay_droid
  reuses the same flow.
- **Tests:** driver suite 105 (+4 reset_arm tests: blocking motion to
  the reset pose, gripper open, pre-connect raise, failure recovery);
  r2d2 core 171 (+1 wire-level test: ResetEpisode → reset_arm call +
  arm_reset_complete status); toy 33 (thin-wrapper flow against a stub
  robot: success, timeout, off-target refusal, getattr defaults).
- **Still open (rollout path, not homing):** the velocity executor's
  discontinuity reflex and dt-hiccup sensitivity remain the Phase 2/3
  telemetry target — the reference harness and tier-(b) thresholds
  already exercise that chain offline.

## Follow-up: real-data verdict — Rung A falsified, Rung B required (2026-08-26)

Three lab fixtures (ep_000/001/002 from the official r2d2_faceblur RLDS,
loaded via tfds.builder_from_directory after fixing the exporter for the
nested _VariantDataset steps encoding) produced the first ground-truth
verdicts:

- **Tier (a) PASSES (21 tests).**  The conversion chain is confirmed by
  the data itself: pos[t] - qpos[t] = vel[t] x 0.2 - realized_lag[t]
  (obs is captured during/after the step; the residual IS the arm's own
  tracking error).  Per-joint regression pins the 0.2 rad/unit-velocity
  constant and its sign; recorded velocities are normalized (<=1);
  gripper/delta/finiteness bounds hold.
- **The dataset contains DROID's own executor-fidelity band:** the
  recorded arm deviated from its commanded deltas by median ~0.045,
  p95 ~0.14 rad/step — the reference for tier (b).
- **Rung A FALSIFIED.**  Replaying the recorded commands through the
  real driver chain (harness, no hardware) shows the franky velocity
  executor diverging from the RECORDED trajectory by 0.5-3.3 rad of
  cumulative drift over 150 steps at EVERY dynamics factor (0.05-1.0).
  The recorded plant is a soft 1 kHz impedance tracker (realizes only
  ~25-50% of commanded deltas during teleop transients, settles in
  ~5-15 steps, reverses slowly); a scalar dynamics knob can match
  magnitude but never the phase-laggy response.  This also explains the
  historical wild rollouts: the policy was trained against a sluggish
  plant and our executor over-executes its commands.
- **Encoded as gates:** test_reference_executor keeps the
  model-consistency check (passes at full dynamics) and adds
  `test_tracks_recorded_trajectory` — the tier-(b) dataset-fidelity
  gate, xfail(strict=True) with the measured numbers; XPASS = Rung B
  landed.  Phase 4 (Rung B: the faithful 1 kHz hybrid impedance loop on
  pylibfranka) is now the ACTIVE plan; the harness + fixtures give a
  hardware-free acceptance loop for it.  Until then, interim hardware
  experiments should keep dynamics LOW (~0.1) since the policy expects
  a sluggish plant.

## Follow-up: Phase 4 (Rung B) started — control math + gravity validated on real data (2026-08-26)

**pylibfranka dependency conflict CONFIRMED.**  PyPI pylibfranka (0.21.3)
wheels bundle libfranka >= 0.13.3 (FCI server 7+); the legacy Panda
(FCI 5, system 4.2.2) caps at libfranka 0.9.2 — no compatible release
exists and a source backport means maintaining a fork of an obsolete
API (the saga pivoted for exactly this reason, commit d2bed7b).  Rung B
transport = libfranka 0.9.2 directly (the saga's proven C++ control-loop
pattern); franky stays for nothing in the DROID path (one loop does
DROID actions, reset moves, and safety — polymetis parity).

**New module `lerobot_robot_franka/impedance_loop.py`** — the frozen
controller math in pure Python: hybrid joint PD (JᵀKxJ + Kq gains),
100 Hz torque LPF, torque clamps, and host-side gravity from the
franka_ros URDF masses/COMs + payload (1.0 kg @ [0,0,0.056] flange).
The offline tests found and fixed two real gravity bugs before any
hardware: link-*i* COMs live in frame *i+1* (not *i*), and the
geometric Jacobian must be truncated to the joints each COM depends on
(proximal links were "pulling" 22 Nm on the wrist); plus the plant
physics fix — the simulated body must FEEL the world's gravity pull for
the controller's compensation to cancel it.

**Real-data verdicts (the three fixtures):**
- Gravity sanity: max |tau_g| 21.3 Nm (joint 3) / 11.7 Nm (joint 5 —
  just over DROID's 11.5 clamp, which the recorded arm demonstrably
  held, so the model is within a few percent; hardware calibration
  settles it).  Exact-zero on the vertical axes at the reset pose.
- Offline sag gate PASSES: the plant holds the reset pose with
  host-side gravity (sag < 0.02 rad over 1 s).
- **The dataset's plant gain, measured: the recorded arm realizes only
  0.21-0.28 of each commanded delta at the MEDIAN (p90 0.37-0.44).**
  The impedance loop with damping_scale 2.5 reproduces that
  distribution, and ep_001/ep_002 replay within the tier-(b) thresholds
  (drift 0.01-0.09 rad).  ep_000's reproduction is xfail: its long
  press-against-the-pot segment makes contact transitions overlap the
  free-motion distribution — unjudgeable for a free-space model (kept
  for gravity tests).
- Implication for hardware: the Rung B real-time loop must reproduce
  this ~0.25 plant gain (the policy was trained against it); the
  hardware gravity-acceptance test (hold at reset, sag < 0.02) remains
  the first on-arm gate.

## Follow-up: Rung B transport implemented test-first (2026-08-26)

The 1 kHz transport follows the saga's proven pattern, with the math
staying in the validated Python module (zero porting risk):

- **shim_protocol.py** — the ctypes shm layout (Target/Torque/State,
  seqlock per channel, hold-last on torn reads, writer always lands on
  an even seq) + shim/loop argv builders.  Layout pins: Target 80 B,
  Torque 64 B, State 600 B, total 760 B — kept in sync with the C++.
- **control_loop.py** — the 1 kHz process: read state + target, compute
  the frozen torque via ImpedanceLoop.compute_torque (fresh gains +
  gravity every tick), write torque; zero-torque when the shim is down;
  holds last on torn state.
- **impedance_executor.py** — the driver-side endpoint: process
  lifecycle (shim + loop), send_droid_action (q_d = clip(q + v x 0.2,
  limits) — the exact recorded pipeline identity), blocking reset_arm
  (target the reset pose, poll convergence), state reads.
- **shim/droid_torque_shim.cpp** — transport-only C++ (libfranka 0.9.2):
  publish state at 1 kHz inside the torque callback, read tau_des
  (seqlock, hold-last), return it through control(TorqueControl,
  limit_rate, cutoff); collision behavior, recovery loop, and a --mock
  mode (synthetic plant) so the FULL transport runs on the NUC without
  the arm.  Builds like the saga shim (Dockerfile shim-builder stage).
- **Tests (31 new):** protocol layout/seqlock/torn-read round-trips;
  loop-vs-reference torque equality, zero-torque safety, torn-state
  survival; executor conversion identity vs ALL THREE fixtures
  (q_d = velocity_to_target(qpos[t], vel[t]) recovers the recorded
  target chain, contact steps excluded), limit clipping, reset flow
  against a stub plant, argv plumbing.

NUC checklist (no arm needed for most): build the image; run
`droid_torque_shim --mock --shm-name test` + `python -m
lerobot_robot_franka.control_loop --shm-name test` + the executor smoke
(connect, read state, send actions, reset) — the mock plant converges.
THEN, with the arm (e-stop discipline):
1. gravity acceptance: launch shim (real), loop, write target = reset
   pose, watch state: arm must settle at reset with sag < 0.02 rad and
   no drift for 30 s (kill switch = stop_request);
2. tracked move: target reset -> +0.1 rad on joint 1 and back — smooth,
   no reflex, no oscillation (the calibrated damped loop);
3. full reset_arm via the executor;
4. replay_droid on ep_001 (free-motion-dominated) — tier-(b) thresholds.

## Follow-up: Gate 1 hardware run — stable hold, shutdown-jerk bug fixed (2026-08-27)

First real-arm Gate 1 (`--hold-reset 30`):

- **Hold: stable, no drift, sat 0.081 rad short.**  Decomposed exactly
  like a PD-without-integral plant: joint 6 0.081 rad x Kq6(10) = 0.8 Nm
  (wrist static friction), joints 2/4 ~0.05/0.025 x 30/25 = ~1.6/0.6 Nm
  (model-vs-true gravity).  DROID's own plant had identical physics.
  Gate recalibrated to its actual purpose — catching CATASTROPHIC
  gravity failure (the saga's 1.5 rad collapse): PASS threshold 0.15 rad
  with the numbers logged; the tier-(b) replay remains the real
  fidelity gate.
- **Shutdown jerk = a bug in executor.stop(): it wrote q_des = zeros
  (an impossible pose) alongside stop_request** — the loop slammed full
  PD torque toward q=0 → power_limit_violation reflex.  Fixed: stop()
  only sets stop_request; the loop exits on the request; the shim ends
  control() from INSIDE its callback on the same flag (no recovery
  attempts on stop) — shutdown is now target-free and in-control.
  Tests pin: request_stop leaves q_des untouched, the loop exits on the
  request, and executor.stop never writes a target.

## Follow-up: Gate 2 "failure" diagnosed — reset tolerance vs plant physics (2026-08-27)

The move-joint1 run's real story (the capture hid it — reset_arm
printed nothing during its 20 s poll, so stderr/stdout lines from ~2 s
and ~20 s appeared adjacent): the shim never died early.  The arm
tracked toward the reset pose, settled at its measured static band
(~0.08-0.13 rad — the Gate 1 physics: wrist friction + pitch model
mismatch, PD without integral), and reset_arm's 0.02 rad tolerance was
UNREACHABLE -> 20 s timeout -> shutdown.  The "fatal: stop requested"
line was the clean-stop path mislabeled (libfranka 0.9.2 propagates the
callback exception unwrapped).

Fixes: reset_arm tolerance defaults to 0.15 (the measured static band;
DROID's own reset was a time-based min-jerk move, never a sub-friction
error demand), progress prints every 1 s, fast-fail after 3 s of
shim-not-in-control; the shim labels the stop path "(clean)" and logs
any stale stop_request it zeroes at startup.  The ±0.1 rad tracked
moves then run against a tolerance the plant can actually meet.

## Follow-up: replay + post-e-stop reset incidents — two structural fixes (2026-08-27)

Replay (first 15 Hz target staircase on hardware) misbehaved and the
post-e-stop reset slammed into a cartesian_reflex.  Root causes:

1. **Double torque filtering.**  The Python loop applied a 100 Hz LPF
   AND libfranka applied another (control(..., cutoff=100)) — DROID's
   stack filtered exactly once (libfranka-side; the policy emitted raw
   PD+gravity).  The extra lag pushed the closed loop beyond its
   calibration on target staircases.  Fix: compute_torque(filter=False)
   in the real-time loop — one filter total, as specified.
2. **Far target jumps.**  reset_arm wrote the reset pose as a single
   step; after the e-stop the arm was ~1.5 rad away, so the PD slammed
   with clamped torques -> cartesian_reflex.  Fix: reset SLEWS the
   target at the validated 0.05 rad/15 Hz-step pace (a trajectory like
   DROID's min-jerk reset, never a jump); pinned by a test (first write
   <= 0.05 rad from the current state).
3. **Retry spam in manual-recovery states.**  The shim now detects
   e-stop/reflex errors, logs MANUAL RECOVERY REQUIRED once per state
   change, and polls at 500 ms instead of flooding AER attempts that
   the box rejects anyway.

Suites: plugin 142 passed / 4 xfailed; core 192/5.

## Follow-up: stale-zero target slam — the real cartesian_reflex cause (2026-08-27)

The slewed reset STILL reflexed because the slew was initialized from
the PRE-CONNECT segment state (zeros): the target chain started at
q=0, far from the arm, and the PD slammed the moment control began
(run 1 was the arm still in Reflex from the previous session — the
shim correctly waited; run 2 reflexed on the stale-zero target).

Defense in depth, with the loop as the real-time safety layer:

- control_loop clamps the EFFECTIVE target step to 0.0008 rad/tick
  (~0.8 rad/s) and initializes it from the first LIVE state — no
  writer (executor, future r2d2 driver) can ever jump the target;
- reset_arm waits up to 10 s for the arm to enter control before
  slewing, initializing q_d from the live state;
- runbook rule: after any reflex/e-stop, clear the arm state with the
  enabling device BEFORE re-running (the shim prints MANUAL RECOVERY
  REQUIRED and waits).

Tests: same-tick clamp semantics vs the reference torque, far-jump
clamp (5 rad written -> 2 x 0.0008 effective), live-state gating of
the first reset target.  Plugin 144 passed / 4 xfailed.

## Follow-up: reflex reruns = stale image, not stale analysis (2026-08-27)

The user's logs exonerated their procedure (e-stop released, Desk
locked/unlocked, FCI cycled) AND exposed the real issue: the line
`[reset] max err 2.5133` (|zeros - reset|) printed BEFORE `FCI
connected` is impossible in the fixed code (reset now waits for the
live state) — the container was running the PREVIOUS build, whose
zeros-initialized target chain re-triggered the cartesian/power reflex
on every fresh run regardless of how the reflex was cleared.

Fix: BUILD_TAG ("rung-b-2026-08-27-clamp") printed by executor_smoke
and checkable in-container without the arm; deployment procedure now
includes the tag check before any hardware run.
