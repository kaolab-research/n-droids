# Phase 21: c3po Live View (tabled)

**Goal**: A lightweight popup window showing live camera feeds and joint
torque plots during teleop data collection.  Helps the operator see what the
robot sees without needing a separate monitor or VNC session.

**Key design decision**: This is an **optional extra**, not part of c3po core.
It lives in a separate ``c3po.viewer`` submodule (or a standalone
``c3po-live`` entry point) with extra dependencies (``opencv-python-headless``
or ``matplotlib``).  c3po's core dependency footprint stays at 3.

#### Task 21.1: Camera feed window (2 tests)

**Files**: NEW ``c3po/src/c3po/viewer/__init__.py``

- ``LiveViewer(robot)``: opens a persistent OpenCV window showing the latest
  frame from each camera, updated on every ``step()`` call.
- Multiple cameras are tiled in a grid layout (e.g., 2 cameras → side by side).
- Press ``q`` or close the window to stop the viewer (does not affect the
  robot connection).
- **Tests**: window opens without error (headless test with mocked OpenCV),
  multiple camera feeds are tiled correctly.

#### Task 21.2: Joint torque / position plot (1 test)

**Files**: ADAPT ``c3po/src/c3po/viewer/__init__.py``

- A rolling matplotlib plot (or a simple terminal ASCII plot) of joint
  torques and positions over the last N seconds.
- Auto-scaling y-axis, color-coded per joint.
- Updates once per episode or on a configurable interval.
- **Test**: plot data accumulates correctly over multiple steps, data
  clears on reset.

---
