# Phase 14: ReBot B601-DM Support ✅

**Goal**: Support the ReBot B601-DM bimanual robot station using LeRobot's
native v0.6.0 drivers.  The ReBot is inherently bimanual with 7 DOF per arm
(6 joints + gripper) communicating over CAN bus (Damiao adapter).  Leader
arms (StarArm102 / reBot Arm 102) use FashionStar UART smart servos.

Because v0.6.0 already provides ``BiRebotB601Follower`` and
``BiRebot102Leader``, our work is configuration and integration — no custom
drivers needed.

#### Task 14.1: Register ReBot config in r2d2 ✅

**Files**: ``r2d2/src/r2d2/_config.py``

- Registered all four ReBot config types:
  ``RebotB601FollowerRobotConfig`` (single arm), ``BiRebotB601FollowerConfig``
  (bimanual), ``RebotArm102LeaderTeleopConfig`` (single leader),
  ``BiRebot102LeaderConfig`` (bimanual leader).
- Added ``_make_config_from_raw`` helper for nested dataclass construction.
- ``_make_robot_config`` handles bimanual by recursively parsing
  ``left_arm_config`` / ``right_arm_config`` dicts into ``RebotB601FollowerConfig``
  instances, while top-level cameras stay unprefixed.
- ``_make_teleop_config`` handles bimanual leaders the same way.

#### Task 14.2: Station configs + launch scripts ✅

**Files**: NEW ``r2d2/config/station.rebot_bimanual_2realsense.yaml``,
NEW ``r2d2/config/station.rebot_bimanual_3realsense.yaml``,
NEW ``r2d2/launch_scripts/rebot_bimanual_2realsense.sh``,
NEW ``r2d2/launch_scripts/rebot_bimanual_3realsense.sh``

- **2‑RealSense**: Two wrist-mounted D435 cameras (one per arm), no scene camera.
- **3‑RealSense**: Two wrist cameras + one front-facing D435 scene camera
  (top-level, unprefixed key).
- Launch scripts bind-mount ``/dev/serial/by-path/`` (CAN + UART adapters)
  and ``/dev/bus/usb`` (RealSense).

#### Task 14.3: Bimanual manifest building ✅

**Files**: ``r2d2/src/r2d2/_server.py``

- Manifest building now groups LeRobot's ``left_*`` / ``right_*`` prefixed
  observation feature keys into separate arm entries (``left_follower``,
  ``right_follower``).  Unprefixed single‑arm keys still map to ``"follower"``.
- Camera entries are extracted from feature tuples (not motor floats).
- Controller names handle bimanual leaders (two entries).

#### Task 14.4: Bimanual observation / action mapping ✅

**Files**: ``r2d2/src/r2d2/_server.py``

- ``_ConnectionHandler`` holds an ``_arm_joint_map`` dict (prefix → joint names)
  instead of a single ``_joint_names`` list.
- Observation building iterates over all arms, calling ``obs_to_protocol``
  per arm and merging results.
- Action application iterates over all arms, calling ``action_from_protocol``
  per arm and merging into a single LeRobot-format dict for
  ``robot.send_action()``.
- Teleop position extraction iterates per arm and populates
  ``{arm_prefix}/joint_position`` observation keys.

#### Task 14.5: Test suite ✅

**Files**: NEW ``r2d2/tests/test_rebot.py`` (18 tests, 4 skipped)

- **Config registry** (4 tests, skipped): verify all four ReBot types are
  registered.  Requires LeRobot import — uses ``pytest.importorskip``.
- **Manifest building** (6 tests): single‑arm unprefixed, protocol‑prefixed,
  bimanual ``left_``/``right_``, 7‑DOF ReBot, camera exclusion, no‑joint edge case.
- **Bimanual mapping** (5 tests): arm‑joint‑map construction, obs‑to‑protocol,
  action‑from‑protocol, teleop position extraction, missing joint default.
- **Edge cases** (3 tests): mixed prefixes, arm with only cameras, 7 joints per arm.

#### Task 14.6: USB path documentation + teleop scripts ✅

**Files**: NEW ``n-droids/usb_setup.md``, NEW ``toy-so101/teleop_rebot.py``,
NEW ``toy-so101/record_rebot.py``, NEW ``toy-so101/replay_rebot.py``

- Step‑by‑step guide for identifying CAN adapter, leader UART adapters, and
  RealSense serial numbers on the NUC.
- ``teleop_rebot.py``: live leader→follower mirroring with auto-discovered
  arm-controller mapping.
- ``record_rebot.py``: bimanual dataset recording with keyboard controls
  (same q/n/r interface as the SO‑101 record script).
- ``replay_rebot.py``: replay a downloaded dataset on the hardware, splitting
  the flat action vector back into per-arm arrays.

---

### Deferred Phases

**Deferred**: HuggingFace Hub and Dropbox upload backends.  These require
auth tokens (HF_TOKEN, DROPBOX_TOKEN) and the existing HTTP forwarding
covers the immediate need.  Will be implemented when tokens are available.

---
