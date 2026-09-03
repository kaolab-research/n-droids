# DROID Rebuild — Phase 1 Test Design (test-first contract)

Phase 1 = robot-type collapse (merge `lerobot_robot_droid` into
`lerobot_robot_franka`, single robot type, delete the franka config /
launch variants, keep `station.droid.yaml` + `droid.sh`) plus the
`reset_arm.py` velocity-profile fix.  **Tests are designed here first;
implementation follows this contract.**  All thresholds trace to the
frozen spec (phase_26.md) and droid_rebuild.md.

## Naming decisions (pinned by tests)

- Robot type (registry / `type:` in config): **`franka`** — one class in
  `lerobot_robot_franka`, DROID protocol unconditional.  The `"droid"`
  type string is deleted; resolving it is an error.
- Station naming: config `station.droid.yaml`, launch `droid.sh`,
  container `r2d2-droid` (user-facing "droid" identity survives).
- `station.droid.yaml` changes `type: droid` → `type: franka`.

---

## Suite A — simulated tests (no hardware, no DROID data)

Suite homes follow the repo's environment split: the r2d2 core venv runs
without LeRobot/plugins (config tests skip there), the franka plugin
suite runs in its own venv (has LeRobot 0.6.1), and toy-so101 tests run
in the toy venv.

### A1. r2d2 — collapse invariants (`tests/test_station_collapse.py`, new)

File-system-level pins so the collapse cannot silently regress:

1. `config/station.droid.yaml` exists, parses, and has `type: franka`
   plus the DROID-mode fields: `dynamics_factor`, `acceleration_factor`,
   `velocity_filter_tau`, workspace box (lower < upper), `gripper.type:
   robotiq`, both ZED cameras with the verified serials.
2. `config/` contains NO `station.franka*.yaml` files.
3. `launch_scripts/droid.sh` exists, references `station.droid.yaml`
   and container `r2d2-droid`; `launch_scripts/` contains no
   `franka*.sh`.
4. The Dockerfile installs `lerobot_robot_franka` (+ camera plugin) and
   no longer references `lerobot_robot_droid`.
5. Doc sweep: no `station.franka.droid.yaml` string in r2d2 README /
   toy-so101 scripts.

### A2. franka plugin — registry & robot identity
(`plugins/lerobot_robot_franka/tests/test_registry_collapse.py`, new;
merged config defaults in `test_config_franka.py`)

6. Registry resolves `"franka"` to the merged class; the class is
   `droid_compatible` (DROID protocol is the only mode).
7. `make_robot_from_config` with `type: droid` raises a loud config
   error (the string is gone, not silently aliased).
8. Old droid-plugin tests fold in: identity (`name`, config_class),
   config wiring, dist-name/discovery prefix (`lerobot_robot_*`).

### A3. r2d2 — DROID contract over the wire (`tests/test_droid_contract.py`)

The current droid-server smoke tests, consolidated and extended — a
real `_ConnectionHandler` behind a real WebSocket with the fake robot
at the DROID reset pose:

9. Manifest advertises exactly the DROID surface: action keys
   `follower/joint_velocity`, `follower/gripper_position`; obs keys
   `follower/joint_position`, `follower/gripper_position`; control rate
   15 Hz; camera keys `wrist_image_left` / `exterior_image_1_left`.
10. Fake-policy rollout drives N=12 actions end-to-end (the existing
    smoke test, kept).
11. Recorded rollout finalizes and downloads (kept).
12. `reset_arm`'s homing commands, replayed through the real server
    chain against the fake robot, converge in simulation (see A6).

### A4. franka plugin — executor chain (retained suite, 93 tests)

The velocity executor math stays under test after the merge; the
designed groups are: velocity normalization (|v|≤1), low-pass filter
coefficients, delta = v×0.2, direction-preserving uniform scaling to
`v_limit × dynamics × dt`, acceleration slew budget, joint-limit
reject-and-hold, workspace-box rejection (current + future predictive
check), gripper width conversion, e-stop recovery.  **Any Phase 1
change that deletes or rewrites the driver keeps these green or
rewrites them deliberately** — the merge itself must not touch them.

### A5. toy-so101 — rollout client (retained, 11 tests) + replay tooling (retained, 21 tests)

Unchanged; the frozen conversion `position_action_to_velocity` and the
start-pose gate are already pinned.

### A6. toy-so101 — reset_arm velocity profile (redesigned, `tests/test_reset_arm.py`)

The wild-motion fix, test-first:

- `homing_velocity` becomes `clip(scale × (q_home − q)/0.2, ±1)` with
  default `scale = 0.25` → **≤ 0.05 rad/step max** (a 4× slowdown; the
  server's LPF halves it again on the first step).
- Tests: (a) per-step |v| ≤ scale always, including far poses (no
  saturation anywhere); (b) direction preserved (signs toward home);
  (c) zero at convergence; (d) closed-loop convergence — simulate the
  station's LPF + slew + a first-order arm lag in pure Python, start
  from sampled poses ≤ 2 rad off home, assert convergence < tolerance
  within max_steps and monotone decreasing max-error; (e) CLI wiring
  (`--velocity-scale`, tolerance, max-steps); (f) the default scale is
  the conservative value (pin 0.25 so it can't drift upward).

---

## Suite B — tests on actual DROID trajectories (no hardware)

### B0. Data fixtures

`r2d2/tests/data/droid/`: 2–3 trimmed episodes as npz (the
`export_droid_trajectory.py` schema), each 150–250 steps (≈35 KB apiece).
Bootstrap (one-time, from the lab's real TFRecords, in the openpi env):

    python export_droid_trajectory.py --input '<tfrecords>' \
        --output r2d2/tests/data/droid --max-episodes 3

All Suite B tests **skip with a clear message when the fixtures are
absent** (repo stays lean; CI on the lab machines has the data).

### B1. Tier-(a) offline contract (`tests/test_droid_trajectories.py`)

Against every fixture episode — the test that would have caught the
action-space confusion in minutes:

- **Conversion identity:** for ≥95% of steps,
  `‖position_action_to_velocity(action_position[t], obs_qpos[t]) − action_velocity[t]‖∞ ≤ 0.05`.
  (Both fields are stored in the TFRecord; the frozen 0.2 constant is
  verified against ground truth.)
- **Bounds:** commanded/recorded gripper ∈ [0,1]; `max|v| ≤ 1` on all
  steps; per-step deltas `|q[t+1] − q[t]| ≤ 0.2 + 0.02` (dataset-scale
  contract; flags pathological or mis-parsed data).

### B2. Reference-executor fidelity harness
(`plugins/lerobot_robot_franka/tests/test_reference_executor.py` — lives
in the plugin suite because it drives the REAL `_send_droid_action`
chain through the plugin's fake-franky plumbing)

The frozen spec becomes **executable test code**: a pure-numpy
discretization of DROID's actual controller (hybrid joint impedance at
1 kHz, 100 Hz torque LPF, 15 Hz target updates — the phase_26.md
equation) plays the role of ground-truth arm dynamics.  Replay each
fixture's velocity commands through (a) the reference model and (b) our
real server-side command chain (LPF → ×0.2 → uniform scaling → accel
slew) driving a simple double-integrator arm model.  Compare realized
trajectories:

- median per-step `‖Δq_ours − Δq_ref‖∞ ≤ 0.04 rad`, p95 ≤ 0.08
  (the tier-(b) thresholds, model-to-model).
- Our emulation must also respect the workspace/joint-limit rejection
  rules on episodes that approach them.

This catches scaling, slew, LPF, and interface bugs without hardware —
if the emulation cannot track the reference model in simulation, it
cannot on the arm.

### B3. Observation-pipeline shape check (tier c, offline part)

`tests/test_policy_rollout.py` (toy-so101 — `_build_observation` lives
there) feeds recorded low-dim state + synthetic 224×224×3 images and
pins exactly the frozen keys
(`observation/joint_position`, `observation/gripper_position`,
`observation/wrist_image_left`, `observation/exterior_image_1_left`,
`prompt`) with the pinned shapes/dtypes — the same contract the real
policy server consumes.

---

## Success criteria for Phase 1

1. All Suite A tests green (r2d2 core + franka plugin + toy-so101) —
   collapse invariants pinned, executor chain intact.
2. Suite B green wherever fixtures exist; skips are explicit and
   documented, never silent.
3. `reset_arm.py` re-verified in simulation (A6(d)) before any
   hardware run; hardware sessions resume only per the runbook order
   (reset → synthetic replay → real episode → rollout).

## Explicit non-goals for Phase 1

- No hardware runs; no Phase 2 telemetry; no Rung B code.
- No changes to rebot/so101 configs, scripts, or tests.
- The executor math is preserved as-is (the reference harness only
  *measures* it; changing it is Phase 3/4 business).
