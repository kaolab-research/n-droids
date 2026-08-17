# Phase 17: Robotiq 2F-85 Gripper Support (r2d2) ✅ (28 tests, hardware-verified)

**Status**: Implemented, tested, and hardware-verified on a Robotiq 2F-85
gripper (Modbus device ID 9) connected via USB to the NUC.  The gripper
cycles open/closed via a triangle wave in ``test_franka.py`` alongside the
arm's sinusoidal motion.  Live state updates and bounded tracking error
(~0.03 m mean, characteristic of Modbus RTU latency).

**Goal**: Support the Robotiq 2F-85 gripper (connected via USB to the NUC) as an
alternative to the stock Franka hand.  This is part of the DROID-style setup
where the original Franka gripper has been physically replaced with a Robotiq
gripper.  The gripper is folded into the follower arm's joint array as the 8th
element (``panda_finger_joint1``) — same manifest key, same action/observation
pipeline as the stock hand.

**Key design decision — pyRobotiqGripper v3.x.**  After evaluating both
`pyRobotiqGripper`_ (castetsb, 84 ★, MIT) and `2f85-python-driver`_
(PhilNad, 17 ★, MIT), we selected **pyRobotiqGripper v3.3.13** for three
reasons:

1. **Raw bit-level control (0-255)** normalizes cleanly to DROID's [0, 1] range.
   The alternative library uses mm, requiring calibration to convert.
2. **Non-blocking ``move(position, speed, force, wait=False)``** designed for
   high-frequency control loops.  The v3.x API replaced the older
   ``realTimePositionMove`` with a cleaner ``move()`` that accepts ``wait=False``
   for asynchronous operation.
3. **Rich status API** — ``position(refreshStatus=False)`` for non-blocking
   reads, ``objectDetection()`` for grasp detection, typed fault codes — all
   exposed through a well-documented interface.

**v3.x API notes.**  The library underwent significant changes between v2.x
and v3.x.  Key differences we encountered:

- Constructor: ``RobotiqGripper(com_port=..., device_id=9)`` (was ``serial_number``).
- Position read: ``position(refreshStatus=False)`` → method returning ``int | None``
  (was ``getPosition()`` method, then ``position`` property during transition).
- Move: ``move(position, speed, force, wait=False)`` (was ``realTimePositionMove``).
- Setup: ``connect()`` must be called before ``activate()``.

.. _pyRobotiqGripper: https://github.com/castetsb/pyRobotiqGripper
.. _2f85-python-driver: https://github.com/PhilNad/2f85-python-driver

**Dependencies.**  pyRobotiqGripper v3.3.13 depends on ``pymodbus``, ``numpy``,
and ``pyserial``.  All are pure Python — no system libraries needed beyond
USB serial port access (``/dev/ttyUSB0``).  Added ``pyrobotiqgripper`` to the
Dockerfile ``pip install`` step.

**Normalization.**  The Robotiq gripper reports position as 0-255 bits.
Following DROID convention, this is normalized to [0, 1] where:

- 0.0 = fully open (85 mm)
- 1.0 = fully closed (0 mm)
- ``normalized = 1.0 - bits / 255.0``
- Width in meters: ``width_m = 0.085 * (1.0 - normalized)``

This matches DROID's ``gripper_position`` encoding exactly.

**Integration model.**  ``FrankaRobot.connect()`` checks ``gripper.type`` in the
station config.  When ``"robotiq"``, it creates a ``RobotiqGripperWrapper``
instead of ``franky.Gripper``.  The wrapper exposes the same interface:

- ``gripper.state.width`` → meters (derived from 0-255 bits)
- ``gripper.move(width_m)`` → delegates to ``self._drv.move(position=bits, speed=spd, force=fce, wait=False)``
- ``gripper.object_detected`` → delegates to ``self._drv.objectDetection(refreshStatus=False)``

The gripper appears as ``panda_finger_joint1`` in the manifest's joint list —
it is the 8th element of ``follower/joint_position`` (after the 7 arm joints).
``test_franka.py`` detects it by name and drives it with a separate triangle
wave while the arm joints follow their sinusoidal pattern.

**Draccus compatibility.**  The LeRobot config system (draccus) leaves nested
YAML blocks as raw ``dict`` objects instead of instantiating the annotated
``GripperConfig`` dataclass.  The driver handles both forms:

```python
if isinstance(gripper_cfg, dict):
    com = gripper_cfg.get("com_port")
    did = gripper_cfg.get("device_id", 9)
else:
    com = getattr(gripper_cfg, "com_port", None)
    did = getattr(gripper_cfg, "device_id", 9)
```

**Config format:**

```yaml
robot:
  type: franka
  ip: 172.16.0.2
  gripper:
    type: robotiq
    device_id: 9        # Modbus device ID (default for Robotiq)
    com_port: null      # auto-detect; set to "/dev/ttyUSB0" to force
    speed: 150           # 0-255, higher = faster
    force: 100           # 0-255, higher = grip harder
```

**Hardware-verified behaviour:**

- Gripper connects and activates on ``connect()`` → ``activate()``.
- ``move(wait=False)`` sends non-blocking position targets at 50 Hz.
- ``position(refreshStatus=False)`` returns cached position without a new
  Modbus read — the status cache is updated by the previous ``move()``
  which defaults to ``readStatus=True``.
- Tracking error ~0.03 m mean, ~0.07 m max — bounded by Modbus RTU latency
  (~10-15 ms/command).  No error accumulation over 30-second runs.
- Live state updates in ``test_franka.py`` terminal display.
- ``objectDetection()`` correctly reports 0 (no object) during free motion.

**Implementation.**  The wrapper lives in ``r2d2/src/r2d2/_robotiq/`` as a
standalone subpackage.  Both the LeRobot-tree driver (``robot_lerobot.py``)
and the standalone driver (``robot.py``) import it lazily at connect time.

**Files created:**

```
r2d2/src/r2d2/_robotiq/
├── __init__.py              # Exports RobotiqGripperWrapper
└── _wrapper.py              # RobotiqGripperWrapper class (~150 lines)

r2d2/config/station.franka.robotiq.yaml
r2d2/launch_scripts/franka_robotiq.sh
r2d2/tests/test_robotiq.py   # 28 tests
```

**Files adapted:**

| File | Change |
|---|---|
| ``r2d2/src/r2d2/_franka/config.py`` | Added ``GripperConfig`` dataclass (``type``, ``device_id``, ``com_port``, ``speed``, ``force``); ``FrankaRobotConfig`` gains ``gripper`` field |
| ``r2d2/src/r2d2/_franka/config_lerobot.py`` | Same ``GripperConfig`` + field (self-contained LeRobot copy) |
| ``r2d2/src/r2d2/_franka/robot.py`` | ``connect()`` dispatches to ``RobotiqGripperWrapper`` when ``gripper.type == "robotiq"``; handles dict-form config (draccus) |
| ``r2d2/src/r2d2/_franka/robot_lerobot.py`` | Same gripper selection logic (LeRobot-tree copy) |
| ``r2d2/src/r2d2/_franka/__init__.py`` | Exports ``GripperConfig`` |
| ``r2d2/Dockerfile`` | Added ``pyrobotiqgripper`` to ``pip install`` |
| ``n-droids/franka_setup.md`` | Added Robotiq USB setup section + troubleshooting |
| ``toy-so101/test_franka.py`` | Added gripper detection by joint name, triangle wave driving, live display, error tracking |

---
