# Roadmap: seamless π0.5-DROID rollout on the lab Panda

Status: the Rung-B execution engine is HARDWARE-CERTIFIED (tier-(b)
replays of ep_000/ep_001 under pure PD + speed-matched look-ahead;
ep_002's recorded workspace dips below this cell's table and is now
refused by the geometry preflight).  The certified configuration:
control_mode=impedance, gravity_mode=none (the FCI + Desk end-effector
load hold gravity), damping 1.0, target pace 1.5, z_floor 0.10.

## M1 — Package & certify (DONE 2026-08-29)
- Certified defaults in FrankaRobotConfig (control_mode, impedance
  damping/pace/gravity-mode, payload, z_floor).
- Episode-geometry preflight: refuse episodes whose recorded flange
  envelope dips below the cell floor, BEFORE motion (ep_002 lesson).
- Tests: test_episode_geometry.py.

## M2 — Driver integration (DONE 2026-08-29)
- FrankaRobot control_mode="impedance": connect/disconnect own the
  shim+loop lifecycle; DROID velocity actions write through the
  executor; observations from executor state; reset = executor slew.
  The franky backend stays behind the config.
- Tests: test_driver_executor_mode.py (fake executor contract,
  certified argv).

## M3 — Gripper (DONE 2026-08-29, wrapper; hardware activation next)
- RobotiqGripperWrapper (pyrobotiqgripper v3) with the DROID width
  conventions; pinned by test_gripper.py against a fake backend.
- OPEN: first hardware activation of the USB Robotiq on the NUC
  (/dev/robotiq in the launch script; device_id 9).

## M4 — Live rollout client (c3po)
- openpi π0.5-DROID checkpoint → JOINT_POSITION absolute targets →
  v = clip((target − q)/0.2, ±1) velocity actions → r2d2 at 15 Hz.
- Update toy-so101/policy_rollout.py to the final contract
  (start-pose gate at the DROID reset, JOINT_POSITION conversion).
- Verify the impedance driver path end-to-end on hardware (first live
  policy actions — the same executor, but the velocity→target chain
  instead of the recorded chain).

## M5 — Cameras
- wrist ZED → wrist_image_left, scene ZED → exterior_image_1_left,
  224×224 resize_with_pad (the DROID image contract).
- ZED serials already in station.droid.yaml (droid_image_keys).

## M6 — End-to-end rollout acceptance
- Policy → c3po → r2d2 → arm with images; acceptance: task-like
  smooth motion, no reflexes, and the realized trajectory within the
  DROID action semantics (the tier-(b) machinery reused for live
  verification).
