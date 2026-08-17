# Phase 19: π0.5-DROID Policy Interface Alignment (r2d2 + c3po)

**Goal**: Make the DROID station a drop-in inference target for
pretrained π0 / π0.5 DROID policies — same action space, state space,
image layout, and control rate the policies were trained on, so openpi's
DROID stack can run against r2d2 with no format translation.

**Background — the actual DROID interface (verified against the DROID
and openpi sources, 2026-08-17).**  The previous draft of this phase
targeted a hand-rolled "10D Cartesian (abs_pos + abs_rot_6d + gripper)"
space.  That matches neither the `DROID dataset format`_ nor π0.5's
runtime interface, so it is replaced by the verified contract:

- **Control rate: 15 Hz** (DROID's ``control_hz = 15``).
- **Action: 8D** = ``joint_velocity`` (7, each in [-1, 1]) +
  ``gripper_position`` (1, *absolute* target in [0, 1]).  This is
  exactly what openpi's DROID converter packs into the LeRobot
  ``actions`` feature — "we use joint velocity actions here since
  pi05-droid was pre-trained on joint velocity actions"
  (``examples/droid/convert_droid_data_to_lerobot.py``) — and what
  ``DroidOutputs`` emits ("Only return the first 8 dims").
- **State (proprio): 8D** = ``joint_position`` (7, rad) +
  ``gripper_position`` (1, [0, 1]) — openpi's ``DroidInputs``
  concatenates ``observation/joint_position`` +
  ``observation/gripper_position``.
- **Images**: ``wrist_image_left`` (wrist camera) +
  ``exterior_image_1_left`` (scene camera); π0 additionally expects a
  masked ``right_wrist`` image (zeros are fine).
- **Gripper convention**: DROID computes
  ``gripper_position = 1 - width / max_width`` → **1 = fully open,
  0 = fully closed**.  (Our current Robotiq ``normalized_position =
  bits / 255`` is INVERTED relative to DROID and must be fixed.)
- **Velocity → delta conversion** (DROID ``robot_ik_solver.py``):
  normalize the velocity vector so max |v| ≤ 1, then per-joint
  ``delta = v * 0.2 rad`` (``max_joint_delta``), added to the current
  joint positions (``max_gripper_delta`` = 0.25 per step is only used
  for velocity gripper actions, which we don't need).  Underneath,
  DROID runs a 1 kHz joint impedance controller; r2d2's 50 Hz
  ``JointMotion`` preemption is the equivalent primitive.

**Key design decision — joint space, no IK.**  Because π0.5-DROID is a
*joint-velocity* interface, **no Cartesian IK layer is needed**.  r2d2
converts the velocity action to target joints and uses the existing
``JointMotion`` pipeline.  This is simpler and more robust than the
previously planned ``Kinematics.inverse()`` layer.  (If a
Cartesian-action policy is ever needed, prefer franky's built-in
``CartesianMotion`` over manual IK; explicitly out of scope here.)

**Files to adapt (plugin layout — Phase 26):**

```
plugins/lerobot_robot_franka/src/lerobot_robot_franka/
├── franka.py           # ADAPT: droid_compatible mode (action/obs/validation)
├── gripper.py          # ADAPT: DROID gripper normalization (1=open)
└── config_franka.py    # ADAPT: droid_compatible flag
r2d2/src/r2d2/
├── _server.py          # ADAPT: manifest keys for DROID mode (no changes needed? verify)
└── _recording.py       # ADAPT: named feature groups (task 19.5)
```

#### Task 19.1: DROID gripper normalization (2 tests)

**Files**: ADAPT ``plugins/lerobot_robot_franka/src/lerobot_robot_franka/gripper.py``

- Robotiq: ``gripper_position = 1.0 - bits / 255.0`` (DROID convention,
  replacing the inverted ``bits / 255.0``).  ``state.width`` stays in
  metres (franky-compatible); add a ``droid_gripper_position`` field to
  the state namespace.
- Stock Franka hand (franky.Gripper): ``1 - width / max_width`` with
  ``max_width = 0.08`` m.
- Action side: gripper targets arrive as absolute [0, 1]; convert to
  width: ``width = (1 - g) * max_width`` before ``move()``.
- **Tests**: 0 → closed (width 0), 1 → open (width max); round-trip
  width ↔ gripper_position for both backends.

#### Task 19.2: joint-velocity action mode in FrankaRobot (4 tests)

**Files**: ADAPT ``.../franka.py``, ``.../config_franka.py``

- ``FrankaRobotConfig`` gains ``droid_compatible: bool = False``.
- When enabled, ``send_action`` expects ``{follower}/joint_velocity``
  (7) + ``{follower}/gripper_position`` (1):
  1. Validate finite, shapes correct; else raise ValueError with keys.
  2. Normalize: if max |v| > 1, scale the vector (DROID semantics).
  3. ``delta = v * 0.2``; ``q_target = q_current + delta``; clip to
     Franka joint limits (reject-and-hold if beyond, with
     ``action_rejected`` status).
  4. Send via the existing ``JointMotion(asynchronous=True)`` path.
  5. Gripper: absolute [0,1] → width via task 19.1 → ``gripper.move``.
- Log the first action once (already added in Phase 18 follow-ups).
- **Tests** (fake franky): scaling/normalization math, joint-limit
  clipping rejects the cycle, missing keys raise ValueError, gripper
  conversion, NaN/inf rejected.

#### Task 19.3: Observation + manifest keys for DROID mode (2 tests)

**Files**: ADAPT ``.../franka.py``, ``r2d2/src/r2d2/_server.py``

- Observation in DROID mode exposes (arm-prefixed, manifest-driven):
  ``follower/joint_position`` (7), ``follower/gripper_position`` (1,
  DROID-normalized), plus the existing camera keys.  Joint velocities
  stay available for diagnostics.
- Manifest action keys become ``follower/joint_velocity`` +
  ``follower/gripper_position`` (replacing ``follower/joint_position``)
  when ``droid_compatible: true``; c3po validates them as usual.
- **Tests**: manifest keys correct in both modes; obs gripper key is
  DROID-normalized.

#### Task 19.4: 15 Hz station config + c3po pacing (1 test)

**Files**: NEW ``r2d2/config/station.franka.droid.yaml``; ADAPT none

- DROID station config: ``control_rate: 15.0``, ``droid_compatible:
  true``, camera-name → DROID-key mapping (``wrist_zed →
  wrist_image_left``, ``scene_zed → exterior_image_1_left``).
- c3po side needs no change: ``Robot(rate=15.0)`` or the manifest's
  control_rate paces the loop; r2d2's Configure already caps at the
  hardware max.
- **Test**: config loads; manifest reports control_rate 15 and the
  DROID action keys.

#### Task 19.5: Recording alignment for π0.5 training (2 tests)

**Files**: ADAPT ``r2d2/src/r2d2/_recording.py``

- In DROID mode the recorder writes LeRobot-v3 features matching
  openpi's converter instead of one flat ``observation.state``:
  ``joint_position`` (7) + ``gripper_position`` (1) state features,
  ``actions`` (8D = joint_velocity + gripper_position), and image keys
  renamed via the config mapping (``wrist_image_left``,
  ``exterior_image_1_left``), fps 15.
- Implement as a small feature-group mechanism in ``DatasetRecorder``
  (named state keys, optional ``actions`` key) rather than special
  casing DROID.
- **Tests**: info.json features match the converter's schema; parquet
  columns are the named groups; episode round-trip decodes the same
  arrays.

#### Task 19.6: Hardware validation (manual)

- `toy-so101/test_franka.py` at ``FREQ=15`` with DROID-mode actions:
  bounded tracking error, no watchdog spam (5 Hz ≉ 15 Hz), spec table
  healthy.
- Optional: end-to-end π0.5 checkpoint rollout via openpi once the
  interface tasks pass; compare behavior against DROID's own controller
  at the same velocity scaling.

**Station config — DROID mode:**

```yaml
station_model: franka_droid
control_rate: 15.0          # DROID policy rate

robot:
  type: franka
  ip: 172.16.0.2
  droid_compatible: true
  gripper:
    type: robotiq
    device_id: 9
    com_port: /dev/robotiq
    speed: 150
    force: 100
  cameras:
    wrist_zed: { type: zed, serial_number: 23474280, resolution: HD720, fps: 30, use_depth: true }
    scene_zed: { type: zed, serial_number: 14452055, resolution: HD720, fps: 30, use_depth: false }

# DROID image-key mapping used by the recorder (task 19.5):
droid_image_keys:
  wrist_zed: wrist_image_left
  scene_zed: exterior_image_1_left
```
