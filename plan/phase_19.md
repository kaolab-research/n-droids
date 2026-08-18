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
