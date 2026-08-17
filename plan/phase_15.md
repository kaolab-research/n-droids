# Phase 15: Controller Architecture ✅ (27 tests, hardware-verified)

**Design.**  A new ``Controller`` dataclass (``r2d2/src/r2d2/_controller.py``)
wraps each LeRobot Teleoperator with n-droids-specific logic: capability
gating, protocol key formatting, and hardware command sequences.  The control
loop calls ``ctrl.get_state()`` and ``ctrl.apply_haptics()`` instead of ad-hoc
teleop access — capability checks live inside the Controller, not scattered
across the handler.

**``Controller`` fields:** ``name``, ``teleop``, ``arm_prefix``, ``joint_names``,
``capabilities``, ``home_position``, ``haptic_gain``.

**Supported capabilities:**
- ``"auto_reset"`` — leader snaps to ``home_position`` on connect
  (enables torque, writes positions, disables torque).
  **Hardware-verified on SO‑101.**  Uses LeRobot's ``enable_torque()`` /
  ``send_feedback()`` / ``disable_torque()`` — already present on SOLeader.
- ``"haptic_feedback"`` — stub that reads ``{motor}.current`` / ``.effort`` /
  ``.torque`` from the follower observation and sends scaled position
  feedback.  Gates on non-empty ``feedback_features`` (SOLeader passes,
  RebotArm102Leader skips).  Full torque-based haptics requires hardware
  with current control (ALOHA-style leaders).

**Manifest changes (both r2d2 and c3po):** controller entries now include
``capabilities``, ``joint_names``, and optionally ``home_position``.

**c3po additions:** ``robot.controller_capabilities`` and
``robot.leader_home_position`` properties.

**New config:** ``station.so101.nocam.yaml`` + ``launch_scripts/so101_nocam.sh``
— SO‑101 with no cameras and auto‑reset enabled.

**Files changed / created:**

| File | Change |
|---|---|
| NEW ``r2d2/src/r2d2/_controller.py`` | ``Controller`` dataclass with ``get_state()``, ``reset_to_home()``, ``apply_haptics()`` |
| NEW ``r2d2/tests/test_controller.py`` | 27 tests: construction, get_state, reset_to_home (9), apply_haptics (8) |
| ADAPT ``r2d2/src/r2d2/_config.py`` | ``StationConfig`` gains ``teleop_capabilities`` and ``teleop_home_positions``; ``load_station_config`` parses them from YAML |
| ADAPT ``r2d2/src/r2d2/_manifest.py`` | Controller entries include ``capabilities`` |
| ADAPT ``r2d2/src/r2d2/_server.py`` | Imports ``Controller``; sensor tuple includes controllers; control loop uses ``ctrl.get_state()`` and ``ctrl.apply_haptics()``; manifest built from Controller objects; ``_auto_reset_controllers()`` called after handshake, sends ``leader_reset_complete`` status |
| ADAPT ``r2d2/tests/test_manifest.py`` | +2 tests: capabilities included, defaults empty |
| ADAPT ``c3po/src/c3po/robot.py`` | ``controller_capabilities`` and ``leader_home_position`` properties |
| ADAPT ``c3po/tests/test_robot.py`` | +3 tests: controller_capabilities, leader_home_position |
| NEW ``r2d2/config/station.so101.nocam.yaml`` | SO‑101 config with auto‑reset, no cameras |
| NEW ``r2d2/launch_scripts/so101_nocam.sh`` | Launch script for nocam config |

**Hardware status:**

| Platform | Auto‑reset | Haptics |
|---|---|---|
| SO‑101 leader | ✅ verified | ❌ stub (Feetech servos lack torque control) |
| ReBot 102 leader | ❌ (``send_feedback`` raises ``NotImplementedError``) | ❌ (``feedback_features = {}``) |
| ALOHA / future powered leader | ✅ (same SOLeader API) | ❌ stub (ready when hardware arrives) |

---
