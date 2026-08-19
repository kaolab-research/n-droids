# Phase 19: π0.5-DROID Policy Interface Alignment (r2d2 + c3po)

**Goal**: Make the DROID station a drop-in inference target for
pretrained π0 / π0.5 DROID policies — same action space, state space,
image layout, and control rate the policies were trained on, so openpi's
DROID stack can run against r2d2 with no format translation.

**Background — the actual DROID interface (verified against the DROID
and openpi sources, 2026-08-17; gripper convention re-verified against
the fairo/polymetis Robotiq driver the same day — see below).**  The
previous draft of this phase
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
  ``gripper_position = 1 - width / max_width`` where ``width`` is the
  gripper *opening* in metres (``0`` = fully closed, ``max_width`` =
  fully open) — so **0 = fully open, 1 = fully closed**.  The direction
  is pinned down by DROID's own code: ``FrankaRobot.reset()`` commands
  ``update_gripper(0)``, which maps to ``goto(width = max_width * (1 - 0))``
  = fully open, and fairo/polymetis' Robotiq client (the driver DROID
  uses) returns ``get_pos()`` = opening in metres; openpi passes
  ``gripper_position`` through unchanged in both directions.
  **Our current Robotiq ``normalized_position = bits / 255`` (0 = open,
  1 = closed) already matches DROID — do NOT flip it.**  An earlier
  draft of this phase claimed "1 = fully open" and called our
  normalization inverted; that was wrong, and the flip it proposed
  would have introduced a real inversion (re-verified 2026-08-17
  against ``droid/franka/robot.py``, ``droid/robot_env.py``,
  fairo/polymetis' ``robotiq_gripper_client.py``, and openpi's
  ``droid_policy.py`` / converter).
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

**Files to adapt (plugin layout — Phase 26; c3po and the config loader
join the list after the 2026-08-17 audit):**

```
plugins/lerobot_robot_franka/src/lerobot_robot_franka/
├── franka.py           # ADAPT: droid_compatible mode (action/obs/validation, dynamics_factor)
├── gripper.py          # ADAPT: explicit droid_gripper_position + conversion helpers (no flip!)
└── config_franka.py    # ADAPT: droid_compatible + dynamics_factor fields
r2d2/src/r2d2/
├── _config.py          # ADAPT: parse control_rate from YAML; drop dead max_rate
├── _server.py          # ADAPT: DROID manifest/obs keys, gripper manifest entry, 15 Hz clamp
└── _recording.py       # ADAPT: named feature groups (task 19.5; resolution honesty fixed 2026-08-17)
c3po/src/c3po/
└── _manifest.py        # ADAPT: gripper action/observation keys from the manifest (task 19.3)
```

#### Task 19.1: DROID gripper position in the state namespace (2 tests)

**Files**: ADAPT ``plugins/lerobot_robot_franka/src/lerobot_robot_franka/gripper.py``
(helpers; stock-hand formula applies in ``.../franka.py``)

- **No flip.**  The current Robotiq ``normalized_position = bits / 255``
  (0 = fully open, 1 = fully closed) already matches the verified DROID
  convention — flipping it (as an earlier draft proposed) would break
  DROID alignment.  ``state.width`` stays in metres (franky-compatible).
- Robotiq: add an explicit ``droid_gripper_position`` field to the state
  namespace (same value as ``normalized_position``) so the DROID name is
  unambiguous; update the module docstring, which currently documents
  the DROID convention correctly but is easy to misread.
- Stock Franka hand (franky.Gripper): ``1 - width / max_width`` with
  ``max_width = 0.08`` m (width = opening → 0 = open, 1 = closed).
- Conversion helpers used by 19.2 for both backends:
  ``width_from_droid_position(g, max_width) = (1 - g) * max_width`` and
  ``droid_position_from_width(width, max_width) = 1 - width / max_width``.
- Action side: gripper targets arrive as absolute [0, 1]; convert to
  width with ``width_from_droid_position`` before ``move()``.
- **Tests**: 0 → open (width max), 1 → closed (width 0); round-trip
  width ↔ gripper_position for both backends; Robotiq
  ``droid_gripper_position`` equals ``bits / 255``.

#### Task 19.2: joint-velocity action mode in FrankaRobot (4 tests)

**Files**: ADAPT ``.../franka.py``, ``.../config_franka.py``

- ``FrankaRobotConfig`` gains ``droid_compatible: bool = False`` and
  ``dynamics_factor: float = 0.05`` (replacing the hardcoded
  ``relative_dynamics_factor = 0.05`` in ``connect()``).
- When enabled, ``send_action`` expects ``{follower}/joint_velocity``
  (7) + ``{follower}/gripper_position`` (1):
  1. Validate finite, shapes correct; else raise ValueError with keys.
  2. Normalize: if max |v| > 1, scale the vector (DROID semantics).
  3. ``delta = v * 0.2``; ``q_target = q_current + delta``; clip to
     Franka joint limits (reject-and-hold if beyond, with
     ``action_rejected`` status).
  4. Send via the existing ``JointMotion(asynchronous=True)`` path.
  5. Gripper: absolute [0,1] → width via task 19.1 → ``gripper.move``.
- **Dynamics factor (audit finding):** ±0.2 rad per 66 ms implies
  ~3 rad/s instantaneous joint velocity, far above the 5%-of-max
  velocity cap — so DROID-mode rollouts track the policy's *direction*
  but systematically attenuate its *magnitude*, shifting the behaviour
  distribution relative to DROID training data.  Making
  ``dynamics_factor`` configurable is part of this task; *choosing* the
  value is 19.6 (don't silently raise it here — validate on hardware).
- Log the first action once (already added in Phase 18 follow-ups).
- **Tests** (fake franky): scaling/normalization math, joint-limit
  clipping rejects the cycle, missing keys raise ValueError, gripper
  conversion, NaN/inf rejected, ``dynamics_factor`` applied in
  ``connect()``.

#### Task 19.3: Observation + manifest keys for DROID mode (2 tests)

**Files**: ADAPT ``.../franka.py``, ``r2d2/src/r2d2/_server.py``,
``c3po/src/c3po/_manifest.py``

- Observation in DROID mode exposes (arm-prefixed, manifest-driven):
  ``follower/joint_position`` (7), ``follower/gripper_position`` (1,
  DROID convention 0 = open, 1 = closed — same value the Robotiq
  wrapper already computes), plus the existing camera keys.  Joint
  velocities stay available for diagnostics.  Note the gripper is
  currently smuggled into ``joint_position`` as an 8th value in metres
  (``panda_finger_joint1``); DROID mode splits it into its own key.
- Manifest action keys become ``follower/joint_velocity`` +
  ``follower/gripper_position`` (replacing ``follower/joint_position``)
  when ``droid_compatible: true``.
- **c3po manifest support (audit finding):** c3po derives *all* keys
  from the manifest arms list (``command_mode`` → action key;
  hardcoded ``joint_position``/``joint_velocity`` observation keys), so
  the manifest needs an explicit gripper declaration for the client to
  advertise and validate the gripper key.  Add an optional per-arm
  ``"gripper": {"key": "gripper_position"}`` entry to the r2d2 manifest
  in DROID mode; c3po's ``parse_manifest`` appends
  ``{arm}/gripper_position`` to both ``action_keys`` and the
  observation keys, and ``build_observation_keys`` includes it (so
  ``reset()`` waits for it and ``step()`` validates it).
- **Tests**: manifest keys correct in both modes; obs gripper key is
  DROID-normalized; c3po parses the gripper entry into action and
  observation keys.

#### Task 19.4: 15 Hz station config + c3po pacing (1 test)

**Files**: NEW ``r2d2/config/station.franka.droid.yaml``; ADAPT
``r2d2/src/r2d2/_config.py``, ``r2d2/src/r2d2/_server.py``

- DROID station config: ``control_rate: 15.0``, ``droid_compatible:
  true``, camera-name → DROID-key mapping (``wrist_zed →
  wrist_image_left``, ``scene_zed → exterior_image_1_left``).
- **Honor the YAML rate (audit finding):** ``load_station_config``
  currently ignores ``control_rate`` (``StationConfig`` has no such
  field; the dead ``max_rate`` placeholder is also unused — delete it),
  and ``create_server`` hardcodes ``default_rate = 50.0``, so the
  manifest always reports 50 Hz.  Add a ``control_rate`` field to
  ``StationConfig``, use it as the server's default rate and manifest
  value, and — when ``droid_compatible: true`` — clamp *both* the
  default and any ``Configure`` request to 15 Hz, so a
  default-constructed ``Robot()`` (rate=50) cannot silently run the
  DROID station at 50 Hz.  c3po itself needs no change:
  ``Robot(rate=15.0)`` or the manifest's reported rate paces the loop.
- **Test**: config loads; manifest reports control_rate 15 and the
  DROID action keys; a ``Configure(rate=50)`` request is clamped to 15.

#### Task 19.5: Recording alignment for π0.5 training (2 tests)

**Files**: ADAPT ``r2d2/src/r2d2/_recording.py``

- In DROID mode the recorder writes LeRobot-v3 features matching
  openpi's converter instead of one flat ``observation.state``:
  ``joint_position`` (7) + ``gripper_position`` (1) state features,
  ``actions`` (8D = joint_velocity + gripper_position), and image keys
  renamed via the config mapping (``wrist_image_left``,
  ``exterior_image_1_left``), fps 15.  Record the *raw* action values
  the client sent (pre-normalization / pre-delta) — that is what DROID
  stores in its HDF5 and what π0.5 was trained on.
- Implement as a small feature-group mechanism in ``DatasetRecorder``
  (named state keys, optional ``actions`` key) rather than special
  casing DROID.
- **Recording-resolution honesty (audit finding — already fixed
  2026-08-17):** ``info.json`` previously declared camera features at
  the *capture* resolution and 3 channels for depth, while the MP4/PNG
  files actually contained stream-resized frames and 1-channel uint16
  depth.  ``_write_info`` now declares the recorded (stream) resolution
  and ``[h, w, 1]`` depth.  Two decisions remain for this task:
  1. **Record at native capture resolution** (a second, unresized read
     in the camera send loop, JPEG-encoded in the executor) instead of
     the stream resolution — recommended for training quality; the
     streaming cap then only affects the wire, not the dataset.
  2. **Depth storage format:** depth is currently written as a uint16
     PNG sequence, which is not loadable as a ``video`` feature by
     LeRobot readers.  Either write loadable depth video or drop depth
     from the π0.5 schema (openpi's converter ignores depth entirely).
- **Tests**: info.json features match the converter's schema; parquet
  columns are the named groups; episode round-trip decodes the same
  arrays.

#### Task 19.6: Hardware validation (manual)

- `toy-so101/test_franka.py` at ``FREQ=15`` with DROID-mode actions:
  bounded tracking error, no watchdog spam (client cadence ≈ control
  rate; the 200 ms watchdog boundary only bit at 50 Hz with a 5 Hz
  client), spec table healthy.
- **Dynamics validation (audit finding):** measure tracking error at
  15 Hz with the default ``dynamics_factor = 0.05``.  ±0.2 rad/step
  implies ~3 rad/s instantaneous velocity, well beyond the 5% cap, so
  the arm will lag DROID-velocity actions.  Tune ``dynamics_factor``
  (e.g. 0.1–0.2) until the trajectory shape matches DROID's own
  controller driven with the same velocity scaling — this is a
  training-distribution match, not just a stability check.  Record the
  chosen value in `station.franka.droid.yaml` and the completion notes.
- Optional: end-to-end π0.5 checkpoint rollout via openpi once the
  interface tasks pass; compare behavior against DROID's own controller
  at the same velocity scaling.

**Station config — DROID mode:**

```yaml
station_model: franka_droid
control_rate: 15.0          # DROID policy rate — honored by _config.py (task 19.4)

robot:
  type: franka
  ip: 172.16.0.2
  droid_compatible: true
  dynamics_factor: 0.05     # tune on hardware in task 19.6 (see above)
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

Gripper values throughout DROID mode are 0 = fully open, 1 = fully
closed (see the corrected convention in the background section).

---

#### Phase 19 pre-work notes (2026-08-17 — audit follow-ups, done)

Folded the 2026-08-17 audit into the task list above before any of the
interface tasks were implemented:

- **Corrected the gripper convention.**  The earlier draft (and the
  audit's initial reading of it) claimed DROID normalizes the gripper
  as "1 = fully open" and that r2d2's ``bits / 255`` was inverted.
  Both claims were wrong: DROID's ``gripper_position = 1 - width /
  max_width`` with ``width`` = opening in metres yields **0 = open,
  1 = closed**, and our current normalization already matches.  19.1 is
  rewritten accordingly (explicit ``droid_gripper_position`` +
  helpers, no flip); no gripper.py behaviour change was needed.
- **Recording metadata honesty (done, r2d2):** ``info.json`` now
  declares the actual recorded (stream) resolution and 1-channel depth
  instead of the capture resolution and 3 channels.  Tests added.  The
  open follow-ups (record at native capture resolution; depth video
  format) live in 19.5.
- **ZED wedge surfacing (done, lerobot_camera_zed):** the grab loop
  now counts consecutive failures and ``read()``/``read_depth()`` raise
  after 10, so r2d2's camera loop surfaces a ``camera_error`` instead
  of a wedged camera silently serving stale snapshots.  Tests added.
- **Packaging/hygiene (done):** stale ``r2d2/src/r2d2/_franka|_robotiq|_zed``
  pyc leftovers deleted; ``opencv-python-headless`` added to r2d2's
  declared dependencies (it was Dockerfile-only); ``_manifest.py``
  docstring de-ROSified; r2d2/n-droids READMEs corrected (raw-frame
  transport description, Franka config example).
- Folded into the tasks: configurable ``dynamics_factor`` (19.2/19.6),
  YAML ``control_rate`` plumbing + 15 Hz clamp (19.4), c3po manifest
  gripper keys (19.3).

---

#### Phase 19 implementation notes (2026-08-17 — 19.1–19.5 done, test-first)

Implemented in the order: test design → tests (red) → implementation
(green).  19.6 (hardware validation) remains for the station.

**19.1 — gripper position in the state namespace.**  No flip (see the
convention correction above).  ``gripper.py`` gained module-level
``width_from_droid_position`` / ``droid_position_from_width`` helpers
and the wrapper state exposes ``droid_gripper_position`` (same value as
``normalized_position``).

**19.2 — joint-velocity action mode.**  ``FrankaRobotConfig`` gained
``droid_compatible`` + ``dynamics_factor`` (default 0.05, applied in
``connect()`` instead of the hardcoded factor).  In DROID mode
``send_action`` consumes ``joint_velocity`` (7) + ``gripper_position``
(1): finite/shape validation → max|v| ≤ 1 normalization → × 0.2 rad
deltas → joint-limit clip with **reject-and-hold**
(``ActionRejectedError``, exported; no arm or gripper motion issued).
Gripper targets are clipped to [0,1] (DROID's own behaviour) and
converted via the 19.1 helpers.  ``observation_features`` excludes the
gripper from the arm in DROID mode (7 joints, not 8).

**19.3 — observation/manifest keys.**  ``get_observation`` emits
``gripper_position`` (DROID-normalized; width stays under
``panda_finger_joint1.pos`` for diagnostics).  The hardware manifest is
now built by a pure ``build_station_manifest()`` in
``r2d2/_manifest.py``; DROID arms advertise ``command_mode:
joint_velocity`` + ``gripper: {"key": "gripper_position"}``.  The
mapping layer gained DROID modes for ``obs_to_protocol`` /
``action_from_protocol`` (missing keys raise ``ValueError``).  c3po's
``parse_manifest``/``build_observation_keys`` append the gripper key to
``action_keys`` and observation keys; ``reset()``/``step()`` validation
cover it with no other c3po changes.

**19.4 — 15 Hz station config.**  ``StationConfig`` gained
``control_rate`` / ``droid_compatible`` / ``droid_image_keys`` (the
dead ``max_rate`` field is gone); the YAML ``control_rate`` is honored
and DROID mode clamps both the default rate and any ``Configure``
request to 15 Hz; DROID mode asserts a single arm.
``config/station.franka.droid.yaml`` + ``launch_scripts/franka_droid.sh``
shipped.  A default-constructed ``Robot()`` (rate 50) can no longer run
a DROID station at 50 Hz.

**19.5 — recording alignment.**  ``DatasetRecorder`` gained an
optional ``FeatureGroups`` schema (named state columns + a single
concatenated ``actions`` column + image-key rename, float32, dims
validated per frame).  DROID recordings now write
``joint_position`` (7) + ``gripper_position`` (1) + ``actions`` (8)
columns whose info.json features mirror the openpi converter's names /
dtypes / shapes; camera videos store under ``wrist_image_left`` /
``exterior_image_1_left`` (depth via stem).  Stats aggregate all named
columns; the legacy flat layout is untouched.  Recording still uses the
*stream* resolution — recording at native capture resolution (a second,
unresized camera-loop read) remains a follow-up; depth stays a uint16
PNG sequence (openpi's converter ignores depth).

**Server.**  DROID actions rejected by validation or joint limits push
a rate-limited ``action_rejected`` StatusMessage; a missing gripper key
degrades to joints-only observations (warned once) so ``reset()``
surfaces the missing key on the client.

**Tests.**  All written before the implementation: plugin gripper
convention + helpers (test_robotiq.py), DROID send_action /
observation / dynamics (test_franka.py), config fields
(test_config_franka.py), mapping DROID modes (test_mapping.py),
hardware manifest (test_manifest.py), recording feature groups +
image rename + stats (test_recording.py), c3po manifest gripper keys
(test_manifest.py), and a full-stack DROID E2E over a real WebSocket
with a fake Franka (tests/test_droid_server.py: manifest, 15 Hz clamp,
``action_rejected`` status, c3po reset/step flow, named-group
recording).  ``toy-so101/test_franka.py`` auto-detects DROID mode
(velocity actions + [0,1] gripper, reference trajectory integrated with
the ±0.2 rad conversion).

**19.6 — remaining (hardware).**  Run ``test_franka.py`` at
``FREQ=15`` against ``station.franka.droid.yaml``: tracking-error
analysis, tune ``dynamics_factor`` (start at 0.05; expect magnitude
attenuation of DROID velocities — see 19.2), record the chosen value
here and in the config; optionally an openpi π0.5 rollout.

---

#### Phase 19.6 notes (2026-08-18 — thresholds + π0.5 rollout client)

**Error thresholds reworked for DROID mode (keep ``dynamics_factor``
at 0.05).**  The original thresholds (mean 0.02 / max 0.10 / RMS
0.03 rad) were position-mode numbers compared against a reference the
arm can physically reach.  DROID velocity actions demand up to
±0.2 rad per 15 Hz step — ~3 rad/s instantaneous — while franky's
default joint velocity limits (2.175 / 2.61 rad/s, ``src/robot.cpp``)
scaled by 0.05 allow only 0.109–0.131 rad/s (~27× lower).  The old
metric therefore flagged *intended* attenuation as tracking failure;
loosening the thresholds would have hidden real anomalies instead.

``test_franka.py`` DROID mode now: (1) tracks against a
**velocity-capped reference** (each ±0.2-rad step clipped to
``DYNAMICS_FACTOR × franky limits × dt``), with thresholds applied to
that residual (mean 0.03 / max 0.15 / RMS 0.05 rad — motion-generator
fidelity numbers, to validate on hardware); (2) reports the
policy-vs-cap gap separately as informational output.  ``DYNAMICS_FACTOR``
env var must match the station config value.  Keeping 0.05 is
endorsed: it is franky's own documented conservative default, the
policy is closed-loop and compensates (slow-motion rollouts), and the
training-distribution shift is captured by the reported gap.

**π0.5 rollout client (``toy-so101/policy_rollout.py``).**  Deep-dived
openpi's serving stack (primary sources, 2026-08-18):
``scripts/serve_policy.py`` is **environment-agnostic** — it serves the
checkpoint over a WebSocket (port 8000, msgpack) given the model's raw
input dict; the DROID-specific part of openpi lives entirely in the
*client* (``examples/droid/main.py`` imports ``droid.robot_env``), and
the client protocol is packaged as the lightweight pip package
``openpi-client`` (numpy<2, msgpack, websockets — compatible with
c3po's deps).  Decision: **run openpi's server unmodified**
(``python scripts/serve_policy.py --env droid`` → auto-downloads the
``pi05_droid`` checkpoint) and write our own rollout client that
substitutes c3po for DROID's ``RobotEnv``.

``policy_rollout.py`` mirrors openpi's example loop: chunk (10, 8)
reuse with an 8-step open-loop horizon, gripper binarization at 0.5,
action clip to [-1, 1], Ctrl+C deferral during server calls, 224×224
padded image payloads, 15 Hz pacing via c3po's server-paced ``step()``.
Observations are mapped to the exact ``DroidInputs`` keys
(``observation/exterior_image_1_left``, ``observation/wrist_image_left``,
``observation/joint_position``, ``observation/gripper_position``,
``prompt``); actions map to ``follower/joint_velocity`` +
``follower/gripper_position``.  Optional ``--record`` captures the
rollout through the 19.5 DROID feature-group recorder.  ``--fake-policy``
smoke-tests the c3po↔r2d2 pipeline without openpi (covered by an r2d2
integration test).

**Remaining on hardware:** run ``test_franka.py`` with the new metric
(confirm green at 0.05), then a real π0.5 rollout
(``policy_rollout.py --prompt "..."`` on the GPU machine with the
policy server running) — observe gripper binarization behavior, timing
(server reports infer ms), and whether the closed-loop policy
compensates for the 5% attenuation.

#### First rollout fix note (2026-08-18 — chunk horizon is config-driven)

The first real rollout crashed on a hardcoded ``(10, 8)`` chunk-shape
assert (copied from openpi's example client, which is stale): the
``pi05_droid`` config is ``Pi0Config(action_horizon=15)``, so the model
returns **(15, 8)** chunks.  The client died before sending any action
(the arm correctly stayed still; r2d2 stayed healthy).  Also learned:
the first server inference compiles XLA/cuDNN and can take ~30 s —
``policy_rollout.py`` now runs a labeled warmup inference before the
episode, validates chunks as ``(H, 8)`` with ``H`` capped against the
requested open-loop horizon, and raises an informative error for
non-8-wide chunks.  The fake policy emits 15-step chunks to mirror the
real model; unit tests cover the validation (r2d2 151 passed/5 skipped).

#### DROID control-pipeline deep dive (2026-08-19 — grasp attempts hover short)

π0.5 approached objects but hovered short and the gripper alternated
part-close/open.  Deep-dived the original DROID pipeline from source
(``droid/franka/robot.py``, ``launch_robot.sh``, ``robot_ik_solver.py``,
openpi's model/image code) and identified where we differ:

1. **Controller**: DROID runs a **1 kHz joint impedance controller**
   (polymetis ``start_cartesian_impedance``) whose desired joint
   positions are updated at 15 Hz from ``delta + q_current`` — full
   dynamics, no velocity/acceleration scaling factor, and the
   impedance pull preserves the commanded joint-space direction.  Ours
   is a 15 Hz preempted Ruckig ``JointMotion`` with
   ``relative_dynamics_factor`` scaling velocity/acceleration/jerk to
   5–10% — 10–27× slower, and the motion generator clips **each joint
   independently**, distorting the commanded direction (each joint
   saturates at its own cap).  The distortion makes fine
   approach/correction converge slowly — the arm hovers short of the
   object while the policy keeps commanding.
2. **Gripper**: same absolute [0,1] semantics and the same 0.5
   binarization as openpi's reference client; DROID drives its gripper
   gently (0.05 m/s, 0.1 N) vs our Robotiq speed 150/force 100.  The
   part-close/open alternation is the *policy retrying* a grasp the arm
   never reached — a symptom, not a gripper bug.
3. **Images match**: openpi training and inference both use
   ``resize_with_pad`` to 224 — our client pipeline matches.
4. Chunk staleness/latency are shared with openpi's own example
   (8-step open-loop horizon, ~60 ms infer) — not a difference.

**Fix implemented (test-first): direction-preserving uniform scaling.**
``_send_droid_action`` now scales the whole velocity delta by one
factor so no joint exceeds its dynamics-capped per-step velocity budget
(measured inter-action dt, clamped to the 15 Hz contract), matching
DROID's whole-vector normalization semantics — a slowed but
direction-faithful command.  The reject-and-hold joint-limit check is
unchanged.  ``test_franka.py``'s capped-reference model updated to
match (franka plugin 87 tests).  Recommendation for grasping runs:
raise ``dynamics_factor`` toward **0.2** (≈0.44 rad/s — still modest;
DROID runs full dynamics) and retest the hover; ``policy_rollout.py``
gained ``--gripper-threshold`` (default 0.5) to experiment with the
binarization point if part-close/open flutter persists.

#### DROID smoothness/safety parity (2026-08-19 — jerky motion at 0.2)

At ``dynamics_factor=0.2`` the task completes but motion is jerky.
Why is DROID smooth and safe with *no* dynamics factor at all?  From
polymetis's ``franka_hardware`` config (the controller DROID launches):
a **1 kHz realtime joint-PD torque loop** (``JointSpacePD`` with modest
gains ``Kq=[40,30,50,25,35,25,10]``, ``Kqd=[4,6,5,5,3,2,1]``) whose
desired joints update at 15 Hz, a **100 Hz low-pass on the torque
commands** (``lpf_cutoff_frequency: 100``), a **workspace bounding box**,
and a per-tick SafetyController with margins + velocity/torque limits.
Smoothness = continuous torque dynamics filtering the 15 Hz steps;
safety = compliance + limits, not velocity caps.

Replication feasibility: franky has no joint-space impedance motion and
no runtime target updates (its ``CartesianImpedanceMotion`` is
fixed-duration, cartesian, torque-level).  A faithful port would write
a 1 kHz joint-PD loop on franky's ``control()`` API with the same gains
+ 100 Hz torque LPF — realtime-sensitive, deferred.  **Implemented
instead** (test-first, franka plugin 92 tests): (1) **command low-pass**
— ``velocity_filter_tau`` (default 1/15 s) exponential filter on the
normalized velocity stream, the 15 Hz analogue of DROID's 100 Hz torque
LPF; (2) **workspace bounding box** — ``workspace_pos_lower/upper``
config, rejecting actions while the end-effector is outside the box
(polymetis parity; unset by default).  Rebuild the image; expect fluid
motion at 0.2.  If limits are still hit hard, ``dynamics_factor``,
``velocity_filter_tau``, and the workspace box are the tuning surface.

#### Design decision (2026-08-19 — the Ruckig layer is the wrong layer)

Parameter sweeps over (dynamics_factor, velocity_filter_tau) plateau:
grasping still hovers short and high factors overshoot.  Root cause at
the design level: **franky is a motion-generator library** — Ruckig
trajectories with velocity/accel/jerk caps, and its Python API exposes
**no low-level 1 kHz control loop** (verified: franky v1.1.4's README
states "instead of relying on low-level control commands, franky
expects high-level position or velocity targets"; no ``control()``
binding exists).  DROID's motion is a 1 kHz joint-PD **torque loop**
with 15 Hz target updates — a different control paradigm that cannot be
reached by tuning Ruckig parameters.  Polymetis itself is archived
(facebookresearch/polymetis), so adopting it is not an option.

**Decision: add an impedance control backend** for DROID mode using
**pylibfranka** — the official, maintained libfranka Python bindings
(Franka Robotics) — whose ``Robot.start_torque_control()`` provides the
1 kHz torque loop **with automatic gravity compensation**.  The backend
implements polymetis's exact controller: ``τ = Kq·(q_des − q) − Kqd·q̇``
(JointSpacePD, gains from config defaulting to polymetis's
``Kq=[40,30,50,25,35,25,10]`` / ``Kqd=[4,6,5,5,3,2,1]``), a 100 Hz
torque low-pass, 15 Hz target updates from the server thread, and our
existing safety layer (workspace box, joint-limit reject, collision
behavior, e-stop recovery).  franky remains the backend for position
mode/teleop.  This is scoped as **Phase 19.7** — implement once the
container builds pylibfranka wheels for libfranka 0.9.2/Python 3.12.

#### Phase 19.7 implementation notes (2026-08-19 — DROID robot type, done)

The user reclassified the station: **DROID is a first-class robot
type** (Franka + Robotiq + 2× ZED speaking the DROID protocol), keeping
the franky-based Franka support untouched.  Feasibility corrections
found during planning: pylibfranka wheels bundle modern libfranka and
track its version — per the official compatibility matrix the binding
must match the FCI *server* version (7→0.13.3, 8→0.14.1, 9→0.15.0,
10→0.18.0+), so the Panda needs a Desk/System update first
(``franka_setup.md`` §6 documents the procedure and the matrix).
Skipped the C++-helper fallback accordingly.

Shipped (test-first):

- **New shared plugin ``lerobot_gripper_robotiq``**: the Robotiq 2F-85
  wrapper, DROID-convention helpers, and ``GripperConfig`` extracted
  from the franka plugin — single source of truth used by both robot
  plugins (franka: 67 tests, gripper: 26 tests).
- **New plugin ``lerobot_robot_droid``** (26 tests): ``DroidRobot``
  with ``DroidRobotConfig`` (registered ``"droid"``) — pylibfranka
  ``start_torque_control()`` in a dedicated thread computing
  ``τ = Kq·(q_des−q) − Kqd·q̇`` (pure, tested ``compute_pd_torque``)
  with a 100 Hz torque LPF; 15 Hz target updates from ``send_action``
  (normalize → ±0.2 rad → joint-limit reject-and-hold → workspace box →
  ``q_des``); gravity compensation automatic; e-stop resilience
  (rate-limited ``automatic_error_recovery`` + loop restart);
  DROID observation surface (``gripper_position`` 0=open/1=closed) and
  features; ``droid_compatible = True`` drives r2d2's DROID mode.
  **No dynamics factor, no velocity filter, no Ruckig** — the impedance
  loop provides smoothness and direction fidelity natively.
- **r2d2**: ``"droid"`` registry entry; ``droid_mode`` derived from the
  robot's ``droid_compatible`` attribute; ``config/station.droid.yaml``
  (polymetis gains, workspace-box example) + ``launch_scripts/droid.sh``.
- **Dockerfile**: ``ARG PYLIBFRANKA_VERSION`` (default 0.18.0; set per
  the FCI matrix) + the two new plugins installed.

**Remaining (hardware)**: Desk/System update → record the FCI server
version → rebuild the image with the matching ``PYLIBFRANKA_VERSION`` →
``droid.sh`` → rerun ``test_franka.py`` and the π0.5 rollout.  Expect
DROID-faithful smooth, compliant motion with no parameter sweeps.

#### Second rollout follow-up (2026-08-18 — ZED channels were BGR)

The rollout ran but the policy confused red and blue.  Root cause: the
ZED SDK's ``retrieve_image`` returns 4-channel **BGRA**; the driver
dropped the alpha and published the remaining **BGR** as "RGB" over the
wire — so the policy (trained on RGB DROID data) saw R and B swapped.
The recording path hid the bug: ``_server`` converts the frames
``RGB→BGR`` before JPEG encoding, which double-swapped the already-BGR
frames back to correct colors — recorded MP4s looked fine while the
policy path was wrong.  Fixed test-first in ``lerobot_camera_zed``
(``_bgra_to_rgb`` in both the grab thread and the sync fallback;
channel-distinct fake pixels, 2 new tests, plugin suite now 40).
``policy_rollout.py`` also logs the server's per-query inference time.
**Rebuild the NUC image** before the next rollout.  Remaining pause
sources are expected: a policy-server round trip at each 8-step chunk
boundary (mitigate with ``--open-loop-horizon 15``; pipelining via
openpi-client's action-chunk broker is a future option) plus the 5%
dynamics attenuation.

#### E-stop handling (2026-08-18 incident)

Pressing the e-stop during a rollout aborted the in-flight
``robot.move()`` with franky ``ControlException`` ("User Stop
pressed!"); the driver let it propagate and the server (which only
catches ``ValueError``) killed the connection handler — the rollout
died instead of pausing.  Fixed: ``_apply_move`` / ``_apply_gripper``
translate ``ControlException`` (and gripper-backend failures) into
``ActionRejectedError``, attempt automatic error recovery at a
rate-limited cadence (AER fails while the stop is held, succeeds after
release), and the server pushes a rate-limited ``action_rejected``
status — the connection survives and the rollout resumes once the
operator releases the stop (re-enable FCI via Desk if needed).  The
server's per-cycle rejection log is now also rate-limited.  Non-franky
exceptions still propagate (bugs must stay loud).  5 new plugin tests
(franka 86, zed 42).

The same incident wedged the scene ZED at the USB level (grab failures
then ``CAMERA MOTION SENSORS NOT DETECTED`` / "can't claim interface"
on restart — the device needs a physical replug or host-side USB reset;
check whether the scene camera shares a power domain with anything the
e-stop switches).  Code hardening: failed ``ZedCamera.connect()`` now
closes the SDK handle, and ``disconnect()`` tolerates a wedged
``close()`` so container shutdown can't hang.  A wedged camera during a
session already surfaces ``camera_error`` via the grab-failure
tracking.

#### Recording + dataset forwarding (2026-08-18)

``policy_rollout.py --record`` now also **downloads the finished
dataset to the inference machine** (``--record-dest``, default cwd;
``--no-record-download`` opts out).  Mechanics worth knowing: r2d2
finalizes asynchronously after ``stop_recording`` and stops streaming
observations while doing so, so the client waits for the
``dataset_ready`` status by draining via ``step(None)`` with an
``on_status`` callback (the observation timeout at the end is expected
and handled).  The ``dataset_ready`` URL host became configurable on
the server (``create_server(http_host=...)``, default ``10.42.0.1``) so
the loopback E2E test can exercise the full record → finalize →
download path over a real HTTP server (r2d2 152 passed/5 skipped).

**NUC-as-control-only follow-up (2026-08-19):** the NUC is control,
not storage — after a *successful* download the rollout client now
deletes the dataset from the NUC.  New protocol message
``delete_dataset`` (both protocol copies) + ``Robot.delete_dataset()``;
r2d2 refuses empty names and datasets currently being recorded
(``dataset_delete_refused`` status), otherwise rmtree's in the executor
and confirms with ``dataset_deleted``.  On download failure the dataset
stays on the NUC.  Also fixed: c3po's ``download_dataset`` now uses the
host the client actually reached r2d2 on (advertised URL keeps only its
port) — previously an advertised ``10.42.0.1`` URL was followed even
when the client connected via another NIC — and ``--record-dest`` gets
``~`` expansion.  ``--keep-on-nuc`` opts out of cleanup.  The dataset
lands at ``<record-dest>/<record-name>/``.  Suites after the change:
r2d2 154 passed/5 skipped, c3po 141 passed/2 skipped.

**Download hang fix (2026-08-19):** the rollout client hung forever
after ``dataset_ready`` — the wait drained with ``step(None)``, but
``step()`` only returns on the next *Observation*, and after
``stop_recording`` r2d2 stops observations while **camera frames keep
streaming at 30 fps** — so ``step()`` looped on binary frames forever.
Tests missed it because the fake stations had no cameras.  Fix: new
c3po API ``Robot.wait_for_status(event, timeout)`` that ingests while
frames stream and returns on the status; ``policy_rollout.py`` uses it
and prints the download target + per-file progress (c3po logger).
Hardening the fakes so this class of bug can't hide again: the c3po
mock server now mirrors real r2d2 post-stop behavior (observations
stop, camera frames continue, ``recording_started``/``stopped``/
``dataset_ready`` statuses), and the r2d2 DROID E2E fake robot streams
camera frames.  Suites: r2d2 154/5, c3po 143/2.

---

#### Phase 19.2 fix note (2026-08-18 — franky exposes no joint limits)

First station run crashed on the first DROID action with
``AttributeError: 'Robot' object has no attribute 'joint_limits'`` —
the mocked franky in the unit tests had a ``joint_limits`` attribute
that the real franky v1.1.4 binding does not (verified in
``franky/robot.py``, ``include/franky/robot_state.hpp`` and the
pybind11 bindings).  The connection handler died, which the client saw
as an immediate disconnect (the arm never moved — the crash precedes
the ``move()`` call).

Fix (test-first): the fake lost its ``joint_limits`` attribute so the
regression cannot be masked again; ``FrankaRobotConfig`` gained
``joint_limits`` (default ``None`` → built-in Panda table in the
driver, FR3 users override), validated eagerly at construction; the
reject-and-hold check reads the driver's table.  libfranka still
enforces limits during motion generation as a backstop.  Plugin suite
now 81 tests (4 new).  **The NUC image must be rebuilt** to pick this
up (``docker build -t r2d2:latest .`` + rerun ``franka_droid.sh``).

#### Phase 19.8 notes (2026-08-19 — FCI ceiling closes; pivot to franky 2.0, done)

The Desk update hit the hardware ceiling: the arm is a legacy Emika
Panda at system 4.2.2 = **FCI server 5** (official matrix: server 5 ↔
system >= 4.2.1 ↔ libfranka 0.9.x; libfranka 0.10.0 requires FR3 system
>= 5.2.0).  pylibfranka is a dead end on this arm: PyPI publishes only
0.20.2–0.21.3 (FCI 10) — no 0.9.x binding exists anywhere, and the
Dockerfile's ``pylibfranka==0.18.0`` pin was invalid regardless (0.18.0
was never published).

New route (user-approved): **franky 2.0.0** (released 2026-08-13).
It ships prebuilt wheels for libfranka **0.9.2** (cp312 manylinux —
fits the r2d2 image, FCI 5) and exposes the realtime torque loop in
pure Python: ``JointImpedanceTrackingMotion`` computes
τ = K·(q_d−q) − D·q̇ (+ optional coriolis/friction/joint-limit torques
and a per-cycle ``max_delta_tau`` clamp) on top of libfranka's internal
gravity compensation, with ``move(limit_rate=..., cutoff_frequency=...)``
passing polymetis's exact settings (rate limiting on, 100 Hz LPF).
Verified against the v2.0.0 sources: every franky 1.1.4 API the franka
plugin uses (Robot/Gripper/JointMotion/move/recover_from_errors/
state.O_T_EE) survives in 2.0, so the franka plugin migrates without
code changes.  The franky 2.0 impedance guide's FAQ even uses
"server version: 5" as its example.

Implementation plan (test-first): DroidRobot swaps the pylibfranka
thread for a franky 2.0 control thread (motion reference updated at
15 Hz from ``send_action``, state published from ``robot.state``,
e-stop detection via ``robot.is_in_control`` + rate-limited
``recover_from_errors()``); the config gains ``limit_rate``,
``max_delta_tau``, ``compensate_coriolis``; the Dockerfile installs the
``franky_control 2.0.0+libfranka.0.9.2`` cp312 wheel and drops
pylibfranka; franka_setup.md §6 is rewritten around the FCI-5 ceiling.

**Result (same day):** implemented test-first.  DroidRobot's control
thread now drives ``JointImpedanceTrackingMotion`` (reference streamed
at 15 Hz, state published from ``robot.state``, e-stop via
``robot.is_in_control`` + rate-limited recovery + motion restart); the
franka plugin needed zero code changes (its whole franky API surface
survives in 2.0 — verified against the v2.0.0 binding sources).  Droid
plugin suite: 28 tests.  Remaining: full sweep + rebuild the NUC image
+ hardware validation (the torque loop is still unproven on the arm).
