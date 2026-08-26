# DROID Station Rebuild Plan (branch: `droid-rebuild`)

Goal: one robot station that runs pretrained π0.5-DROID checkpoints
seamlessly, rebuilt around the frozen DROID controller spec
(`phase_26.md` "Frozen spec"), with **measured executor fidelity** as
the acceptance criterion instead of code provenance.

Principles:
- franky stays as the operational layer; the frozen spec is the source
  of truth for behavior.
- One arm → one robot type, one config, one launch path.
- Decisions are gated on measurements (the three test tiers), never on
  speculation.  No further hardware guesswork: every run produces data.

---

## Phase 0 — Tooling and instrumentation (done this branch)

Branch `droid-rebuild` created in r2d2/toy-so101/n-droids; frozen spec
in phase_26.md; this plan.  Hardware tooling in toy-so101:

- `reset_arm.py` — home the arm to the DROID reset pose via the
  velocity interface (≤0.2 rad/step, LPF-friendly taper, tolerance
  check, gripper opens during homing).
- `export_droid_trajectory.py` — TFRecord → npz episode exporter (run in
  the openpi env, which has tensorflow).
- `replay_droid.py` — home the arm, replay a DROID episode (npz / raw
  trajectory.h5 / synthetic), stream `replay_<ep>.csv` with recorded,
  target, realized, and commanded values per step.
- Unit tests for the pure logic (`tests/test_reset_arm.py`,
  `tests/test_replay_droid.py`).

Exit: toy suites green; scripts dry-run against the fake policy path.

## Phase 0.5 — NUC operational runbook

Machine roles (unchanged from today's setup):

- **NUC** (10.42.0.1): Docker host.  Attached: Franka control box
  (172.16.0.2), Robotiq gripper (USB), both ZED cameras (USB).  Host has
  the ZED SDK + CUDA; only the r2d2 container runs here.
- **Inference machine** (10.42.0.2, direct Ethernet to the NUC): two
  environments — the openpi env (policy server, has tensorflow) and the
  toy-so101 env (c3po clients).  All client scripts run here; nothing
  robot-facing runs on this machine.

One-time host setup (done; re-run only after reimaging) —
`franka_setup.md`: RT kernel (`sudo pro enable realtime-kernel`),
realtime group + rtprio/memlock limits, host ZED SDK, CUDA, NVIDIA
Container Toolkit, Desk (joints unlocked + FCI mode).
`network_setup.md`: static 10.42.0.1 (NUC) / 10.42.0.2 (inference);
`ip addr add` is ephemeral — after a reboot without netplan/NetworkManager
persistence, re-apply or the client sees "No route to host".

Syncing code to the NUC (never `git pull` on rewritten branches):

    cd ~/r2d2
    git fetch origin && git reset --hard origin/droid-rebuild

Building the image (on the NUC, in the r2d2 checkout):

    docker build -t r2d2:latest .
    # --build-arg ZED_SDK_VERSION=<host SDK minor series> only when the host
    # SDK changes; FRANKY_VERSION/FRANKY_LIBFRANKA default to 2.0.0/0.9.2
    # (the legacy-Panda pairing).

Launching / restarting:

    ./launch_scripts/droid.sh         # re-creates container r2d2-droid,
                                      # host network, --restart=unless-stopped
    docker logs -f r2d2-droid         # camera serials print at open:
                                      # wrist ZED-M first, scene ZED 2 second
    docker rm -f r2d2-droid           # stop (droid.sh re-launches it)

Smoke, from the inference machine (toy-so101 env):

    ping 10.42.0.1
    cd ~/toy-so101 && uv sync
    uv run python reset_arm.py                              # homes the arm + proves the DROID-mode manifest
    uv run python replay_droid.py --synthetic --max-steps 60   # pipeline smoke; writes replay_*.csv

Real-data validation (tier b):

    # in the OPENPI env (has tensorflow) — export an episode:
    python export_droid_trajectory.py --input '<tfrecord glob>' --output ~/episodes
    # back in the toy env:
    uv run python replay_droid.py --path ~/episodes/ep_000.npz --max-steps 150

Policy rollout (the end goal):

    # openpi env:  python scripts/serve_policy.py --env droid
    # toy env:     uv run python policy_rollout.py --prompt "..." [--record ...]
    #               (start-pose gate + workspace box are the safety invariants)

Hardware session order: reset → synthetic replay → short real episode
(≥150 steps) → rollout.  Keep every `replay_*.csv` — they are the
tier-(b) evidence for the Rung A/B decision.

## Phase 1 — Robot-type collapse (r2d2)

Test-first contract: `plan/droid_rebuild_tests.md` (Suite A: collapse
invariants, registry, wire-level DROID contract, executor chain,
reset_arm velocity profile; Suite B: real-DROID-trajectory contract and
reference-executor fidelity tests).  Tests land before/with the code;
hardware runs resume only after the suites go green.

**Status: implemented** (2026-08-26) — one robot type ``franka``,
`station.droid.yaml` + `droid.sh` the single Franka pair, franka
variants deleted, reset_arm velocity-profile fix, Suites A/B landed.
Remaining: drop real DROID fixtures into `tests/data/droid/` (per its
README) to activate the Suite B tests; hardware gates are Phase 3.

One robot, one config, DROID protocol unconditional.

1. Merge `plugins/lerobot_robot_droid` into `plugins/lerobot_robot_franka`:
   - delete the droid plugin package; `DroidRobot` logic folds into
     `FrankaRobot` (DROID interface is the only interface: `droid_compatible`
     always true).
2. `_ROBOT_REGISTRY`: single Franka-family entry; drop the separate
   `"droid"` type.
3. Configs — ONE Franka config survives, named **`station.droid.yaml`**
   (n-droids keeps its per-station config family for the *other*
   stations; the rebot/so101 configs are untouched):
   - delete the Franka variants only: `station.franka.yaml`,
     `station.franka.droid.yaml`, `station.franka.robotiq.yaml`,
     `station.franka.zed.yaml`;
   - keep the workspace box ON (tuned to the real table), dynamics 0.5
     → validated later against tier (b).
4. Launch — ONE Franka launch script survives, named
   **`launch_scripts/droid.sh`** (container `r2d2-droid`; its
   `docker rm -f ... r2d2-franka` cleanup line drops once old
   deployments are gone):
   - delete the Franka variants only: `franka.sh`, `franka_droid.sh`,
     `franka_robotiq.sh`, `franka_zed.sh` (rebot/so101/toy scripts
     untouched);
   - Dockerfile drops the droid-plugin install step (merged in 1).
5. Update r2d2 tests: merge droid-server smoke tests into the franka
   suite; fake robot keeps the reset-pose initial state; drop the droid
   plugin venv.
6. Doc sweep: references to the deleted config names
   (`station.franka.droid.yaml` in policy_rollout, READMEs, phase logs)
   → `station.droid.yaml`.

Exit: single `uv`-built image; one config file; all suites green
(franka + r2d2 core) from one documented command.

## Phase 2 — Executor fidelity telemetry (r2d2)

Make every run produce tier-(b) data:

1. Station status/diagnostics gain per-step fields: commanded v,
   realized Δq (measured per joint), realized/commanded ratio, reflex
   count, action-cycle overrun.
2. `replay_droid.py` consumes these (or computes realized Δq client
   side from obs — implement server-side as source of truth).
3. Unit tests for the telemetry aggregation.

Exit: `replay_droid.py --synthetic` run produces the full CSV +
summary stats from the telemetry.

## Phase 3 — Hardware validation (decision gates)

Run in order, each gated by data:

1. `reset_arm.py` from several poses → home.  Accept: converges,
   no reflexes, box never violated.
2. `export_droid_trajectory.py` + `replay_droid.py` on a short real
   episode (≥150 steps).  Pass tier (b) thresholds (median ≤0.04,
   p95 ≤0.08, drift ≤0.15 by step 150, 0 reflexes).
3. Tier (a) offline contract tests against the exported npz data.
4. π0.5 rollout with the corrected stack (start-pose gate, box,
   `--velocity-actions` A/B) under dynamics 0.5 → then 1.0 if clean.

Exit criteria:
- **Rung A (franky executor) certified** if 1–4 pass.  Rebuild complete;
  skip Phases 4–5.
- If tier (b) thresholds fail or reflexes persist → **Phase 4**.

## Phase 4 — Rung B: faithful 1 kHz controller (conditional)

Only if Phase 3 fails.  Implement the frozen spec exactly, on
pylibfranka 0.9.2 (transport proven in the torque saga):

1. `droid_torque_loop`: 1 kHz `control()` loop with
   tau = (JᵀKxJ + Kq)(q_d − q) − (JᵀKxdJ + Kqd) dq + Coriolis + gravity,
   100 Hz torque LPF, rate limiting, the frozen clamps/limits/safety
   reflexes.  Gravity via pinocchio + panda URDF + payload
   (0.9 kg, Robotiq CoM) — reuse the torque-saga payload spec.
2. **Gravity acceptance test first**: hold at the reset pose in torque
   mode; sag must stay < 0.02 rad and drift-free for 30 s.  This is the
   gate that failed four times in the saga — it is now the first test,
   not the last surprise.
3. 15 Hz target updates from the same r2d2 action path; keep the
   workspace box + start-pose gate.
4. Re-run Phase 3 gates against Rung B.

Exit: tier (b) passes on Rung B; A/B both certified (keep the franky
executor as fallback behind the same robot surface).

## Phase 5 — Consolidation and docs (final)

1. Pick the certified executor as the default; the other stays
   available behind a config flag.
2. Single README: station setup, reset/replay/rollout workflow, tier
   thresholds, safety invariants (box, reset pose, dynamics).
3. phase_26 closes the saga with the certification numbers.

## Risks / known-unknowns

- **Gravity (Rung B):** host-side gravity is unproven on this arm — the
  Phase 4 acceptance test exists precisely to settle it cheaply.
- **franky impedance APIs** are motion-attached, not a resident loop;
  Rung A therefore emulates behavior rather than mechanism — which is
  exactly why tier (b) thresholds are the arbiter.
- **Workspace geometry:** the ±1.0 m DROID box is too loose for our
  table/wall; the tightened box in station.droid.yaml is our safety reality.
- **TFRecord feature naming** drift between openpi versions — the
  exporter reads defensively (alias lists) and fails loudly.
- **Rate limit:** station must sustain ≥14.5 Hz; telemetry (Phase 2)
  surfaces overruns instead of silently distorting realized deltas.
