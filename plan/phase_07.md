# Phase 07: (recovered from git history)

> **Provenance**: this file was recovered from commit `492d4dbc`
> (2026-07-01 15:09:48 -0700) — the planning record at that point in the project's
> history.  It is kept for its notes and learning points; the
> current status line below reflects today's plan.

**Current status**: `Phase 7: SO-101 Hardware + UVC Camera ✅ (12 tests)`

---

# Phase 07: (historical plan) SO-101 Hardware + UVC Camera + Configurable Rate ← NEXT

**Goal**: Teleoperate a real SO-101 leader-follower pair through c3po with one UVC
webcam streaming, at a researcher-configurable control rate, and record a valid
LeRobot v3.0 dataset.

**Architecture**: r2d2 uses LeRobot's `make_robot_from_config()` and
`make_teleoperator_from_config()` directly — no custom `HardwareSensor` wrapper.
The only glue is a key-mapping layer that translates between LeRobot observation
keys (`shoulder_pan.pos`) and protocol keys (`follower/joint_position`).
LeRobot's own config system (dataclass-based) is used; a thin YAML loader maps a
declarative config file to those dataclasses.

c3po gains a `rate` parameter (default 50 Hz). After the describe handshake, c3po
always sends a `configure` message with the desired rate. r2d2 uses this to pace
the control loop. The station config no longer has a `control_rate` field — the
client is the single source of truth.

---

#### Task 7.1: Config file loader (TDD — 4 tests)

**Files**: New `r2d2/src/r2d2/_config.py`

A `load_station_config(path) -> StationConfig` function that reads a YAML file
and produces LeRobot config objects. The YAML format mirrors LeRobot's internal
structure:

```yaml
# config/station.so101.yaml
station_model: so101_teleop

robot:
  type: so_follower
  port: /dev/ttyACM1
  baudrate: 1000000
  cameras:
    front_rgb:
      type: opencv
      index_or_path: 0
      width: 640
      height: 480
      fps: 30

teleop:
  type: so_leader
  port: /dev/ttyACM0
  baudrate: 1000000
```

The loader returns a `StationConfig` dataclass containing:

- `robot_config` — LeRobot `RobotConfig` subclass (e.g. `SOFollowerRobotConfig`)
- `teleop_config` — LeRobot `TeleoperatorConfig` subclass (or `None`)
- `camera_configs` — dict of `{name: CameraConfig}`
- `station_model` — str
- `max_rate` — float (derived from the robot's native control rate)

Tests:

1. `test_load_so101_config` — YAML loads, returns correct config types
2. `test_camera_config_parsed` — camera section becomes `OpenCVCameraConfig`
3. `test_bimanual_config` — two arms, two leaders, multiple cameras
4. `test_defaults_applied` — missing optional fields get LeRobot defaults

#### Task 7.2: Key mapping module (TDD — 4 tests)

**Files**: New `r2d2/src/r2d2/_mapping.py`

Two pure functions that translate between LeRobot's observation/action format and
the N-Droids protocol format.

`obs_to_protocol(le_obs: dict, joint_names: list[str], arm_prefix: str) -> dict[str, list[float]]`:

- Input: `{"shoulder_pan.pos": 0.5, "gripper.pos": 1.0}`
- Output: `{"follower/joint_position": [0.5, ...], "follower/joint_velocity": [...]}`

`action_from_protocol(proto_action: dict, joint_names: list[str]) -> dict`:

- Input: `{"follower/joint_position": [0.1, -0.3, ...]}`
- Output: `{"shoulder_pan.pos": 0.1, "shoulder_lift.pos": -0.3, ...}`

Tests:

1. `test_obs_to_protocol_single_arm` — correct key mapping and ordering
2. `test_action_from_protocol_single_arm` — roundtrip: protocol → LeRobot → protocol
3. `test_obs_to_protocol_bimanual` — left* and right* prefixes
4. `test_action_from_protocol_bimanual` — both arms mapped correctly

#### Task 7.3: Adapt DatasetRecorder for numpy arrays (3 tests)

**Files**: ADAPT `r2d2/src/r2d2/_recording.py`

Change `append_frame()` to accept `camera_frames: dict[str, np.ndarray]` instead
of `dict[str, bytes]`. The recorder JPEG-encodes frames internally before
writing MP4. The server's control loop passes raw numpy arrays from
`robot.get_observation()` — no pre-encoding needed.

Tests:

1. `test_append_frame_with_numpy_camera` — numpy array encoded to MP4 correctly
2. `test_multiple_cameras_numpy` — two cameras, both in MP4
3. `test_backward_compat_jpeg_bytes_still_works` — toy mode still passes bytes

#### Task 7.4: Add configure message to protocol (2 tests)

**Files**: ADAPT `c3po/src/c3po/_protocol.py`, sync to `r2d2/src/r2d2/_protocol.py`

Add `Configure` dataclass:

```python
@dataclass
class Configure:
    rate: float
    type: str = field(default="configure", init=False)
```

Tests: roundtrip encode/decode, unknown type handling unchanged.

#### Task 7.5: Add rate parameter to c3po Robot (3 tests)

**Files**: ADAPT `c3po/src/c3po/robot.py`, ADAPT `c3po/tests/test_robot.py`

- Add `rate: float = 50.0` parameter to `Robot.__init__()`
- After describe handshake and version check: send `Configure(rate=rate)`
- Expose `self.rate` property
- r2d2 caps the rate at `max_rate` if the requested rate exceeds it, and logs a
  warning. The client receives the capped rate in the manifest's `control_rate`.

Tests:

1. `test_configure_message_sent` — verify Configure is sent after handshake
2. `test_rate_property_set` — `robot.rate == 50.0`
3. `test_default_rate_is_50` — no rate arg → defaults to 50.0

#### Task 7.6: Wire hardware mode into r2d2 server (5 tests)

**Files**: ADAPT `r2d2/src/r2d2/_server.py`

In `create_server()`, when `toy=False`:

1. Load config via `load_station_config(config_path)`
2. Create robot: `make_robot_from_config(robot_config)`
3. Create teleop: `make_teleoperator_from_config(teleop_config)` (if present)
4. Connect: `robot.connect()`, `teleop.connect()`
5. Build manifest from `robot.observation_features`, `robot.action_features`, and
   camera configs
6. Control loop dispatches on mode:
   - **Toy**: `_ToySensor.read()` → protocol
   - **Hardware**: `robot.get_observation()` → `obs_to_protocol()` → protocol →
     receive action → `action_from_protocol()` → `robot.send_action()` → record

The `_handler()` receives a `configure` message via the recv_loop: adjust
`period`. If the requested rate exceeds `max_rate`, cap it and log a warning.

Add `--config` CLI argument to `main()`.

Tests (with mocked LeRobot objects):

1. `test_hardware_mode_manifest` — manifest built from robot.features
2. `test_control_loop_calls_get_observation` — mock robot.get_observation() called
3. `test_control_loop_calls_send_action` — mock robot.send_action() receives action
4. `test_configure_changes_rate` — sending configure adjusts the period
5. `test_rate_capped_at_max` — requesting 1000 Hz when max is 100 → capped, warning logged

#### Task 7.7: Docker device passthrough + SO-101 smoke test (manual)

**Files**: ADAPT `r2d2/Dockerfile`, NEW `r2d2/config/station.so101.yaml`

Write the example config file. Update Docker run instructions for hardware mode:

```bash
docker run -d --name r2d2-so101 \
  -p 9090:9090 \
  --device=/dev/ttyACM0 --device=/dev/ttyACM1 \
  --device=/dev/video0 \
  -v $(pwd)/config/station.so101.yaml:/config/station.yaml \
  -v ~/datasets:/datasets \
  r2d2:latest --config /config/station.yaml
```

Manual smoke test from the inference machine:

1. Connect: verify `station_model == "so101_teleop"`
2. Teleop: 100 steps of leader → follower identity mapping
3. Camera: verify camera frames in observations (correct resolution, not 64×64)
4. Recording: 2 episodes, verify parquet + MP4 with real data
5. Rate: verify `robot.control_rate` matches the configured rate (default 50 Hz)

#### Task 7.8: Multiple UVC cameras (manual)

**Files**: ADAPT `r2d2/config/station.so101.yaml`

Add a second camera entry. No code changes needed — the server already iterates
over all cameras in the config. Smoke test verifies both cameras appear in
observations and in the recorded dataset.

---

### Test totals

| Phase             | Tests                          |
| ----------------- | ------------------------------ |
| Phase 1           | 21                             |
| Phase 2           | 57                             |
| Phase 3           | 19                             |
| Phase 4           | 18 (10 keyboard + 8 recording) |
| Phase 5           | 17 (11 recording + 6 safety)   |
| Phase 6           | 5 (integration)                |
| Phase 7           | 21 automated + 2 manual        |
| **Running total** | **158 automated + 4 manual**   |

### File delta for Phase 7

| Action | Files                                                                                                                                                                                          |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NEW    | `r2d2/src/r2d2/_config.py`, `r2d2/src/r2d2/_mapping.py`, `r2d2/config/station.so101.yaml`                                                                                                      |
| ADAPT  | `r2d2/src/r2d2/_server.py`, `r2d2/src/r2d2/_recording.py`, `r2d2/src/r2d2/_protocol.py`, `c3po/src/c3po/_protocol.py`, `c3po/src/c3po/robot.py`, `c3po/tests/test_robot.py`, `r2d2/Dockerfile` |
| DELETE | (nothing)                                                                                                                                                                                      |

### What we explicitly do NOT build in Phase 7

- A custom `HardwareSensor` class — LeRobot's `Robot` and `Teleoperator` APIs are
  used directly
- A custom robot/teleop factory — LeRobot's `make_robot_from_config` and
  `make_teleoperator_from_config` handle this
- A custom config schema — the YAML maps transparently to LeRobot's dataclass
  config system
- Rate optimization / hardware rate reports — c3po defaults to 50 Hz, r2d2 caps
  at max and warns once if capped
- RealSense, ZED, Franka, Kinova — deferred to later phases
