# Phase 16: Franka Panda Support (r2d2) ✅ (16 tests, hardware-verified)

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
