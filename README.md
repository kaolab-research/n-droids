# N‑Droids

## A lightweight middleware for robot learning research

---

## Abstract

N‑Droids is a two‑component middleware that decouples robot hardware from AI inference. It consists of **r2d2**, a lightweight Docker server running on a NUC at each robot station, and **c3po**, a pure‑Python client library that researchers install on their own machines. Together they let anyone walk up to a robot station, plug in a single Ethernet cable, and interact with the full hardware stack — arms, cameras, grippers, teleoperation controllers — through a single `Robot` object with a Gym‑compatible API.

The NUC handles all hardware interaction using LeRobot's battle‑tested robot drivers. The researcher's machine runs a policy, collects data, or drives teleoperation — all from a Python script with three dependencies.

---

## 1. System Architecture

```
┌─── NUC (r2d2) ─────────────────────-──┐      ┌─── Researcher's machine ──────────┐
│                                       │      │                                   │
│  Docker container (python:3.12-slim)  │      │  Python script                    │
│  ┌─────────────────────────────────┐  │      │  ┌─────────────────────────────┐  │
│  │  r2d2 server                    │  │      │  │  from c3po import Robot     │  │
│  │                                 │  │      │  │                             │  │
│  │  LeRobot hardware layer:        │  │      │  │  robot = Robot()            │  │
│  │  ├─ SOFollower / Franka / etc.  │  │      │  │  obs = robot.reset()        │  │
│  │  ├─ OpenCVCamera / RealSense    │  │  ws  │  │  while True:                │  │
│  │  ├─ SOLeader / gamepad / etc.   │◄─┼──────┼─►│      action = policy(obs)   │  │
│  │                                 │  │      │  │      obs = robot.step(      │  │
│  │  Protocol bridge:               │  │      │  │          action)            │  │
│  │  ├─ JSON control messages       │  │      │  └─────────────────────────────┘  │
│  │  └─ Binary raw camera frames     │  │      │                                   │
│  │                                 │  │      │  Dependencies:                    │
│  │  LeRobot v3.0 dataset writer    │  │      │    numpy, Pillow,                 │
│  │  (parquet + MP4 video)          │  │      │    websocket-client               │
│  └─────────────────────────────────┘  │      │                                   │
│                                       │      │  Any OS. No ROS 2. No CUDA.       │
│  Static IP on inference NIC           │      │  No robot drivers. No PyTorch.    │
│  (10.42.0.1:9090)                     │      │                                   │
│                                       │      │                                   │
│  Physical connections:                │      │                                   │
│  ├─ Robot arms (USB/serial, Ethernet) │      │                                   │
│  ├─ Leader arms (USB/serial)          │      │                                   │
│  ├─ Cameras (USB)                     │      │                                   │
│  └─ HID controllers (USB)             │      │                                   │
└───────────────────────────────────────┘      └───────────────────────────────────┘
```

**r2d2** owns all hardware interaction. It runs LeRobot's robot drivers, camera backends, calibration workflows, and dataset recording inside a single Docker container. It never runs an AI policy.

**c3po** is a pure‑Python package installable on any OS. It communicates with r2d2 over a single WebSocket connection using a lightweight custom protocol: JSON text frames for control and joint state, binary frames for raw camera pixels (RGB and depth; JPEG in toy mode). No ROS 2, no rosbridge, no DDS.

**Networking** is simple. The NUC's inference Ethernet port is configured with a static IP (`10.42.0.1`). The researcher sets a static IP on the same subnet (`10.42.0.2`), plugs in a cable, and c3po connects to `ws://10.42.0.1:9090`.

---

## 2. Why Two Repositories?

N‑Droids is two independent repositories with a strict separation of concerns:

|                   | r2d2                                                                   | c3po                                       |
| ----------------- | ---------------------------------------------------------------------- | ------------------------------------------ |
| **Where it runs** | NUC at robot station                                                   | Researcher's machine                       |
| **Owns**          | Robot drivers, camera backends, calibration, dataset recording, safety | Policy loop, data collection, teleop logic |
| **Packaging**     | Docker image                                                           | `pip install c3po`                         |
| **Dependencies**  | LeRobot hardware layer, camera SDKs, motor SDKs, pyarrow, opencv       | `numpy`, `Pillow`, `websocket-client`      |
| **Maintained by** | Lab infrastructure team                                                | Package maintainers                        |
| **Updated when**  | New robots, sensors, or camera backends are added                      | API evolves or client bugs are fixed       |

The two repos are versioned independently with semantic versioning. Compatibility is guaranteed by the `describe` manifest contract enforced by integration tests.

---

## 3. Protocol

### Transport

A single WebSocket connection on port 9090 carries all traffic. Two frame types:

- **Text frames (JSON)** for control — `describe` requests, observation streaming, action commands, recording commands. Joint state is small (~200 bytes per arm at 100 Hz).
- **Binary frames** for camera images — raw pixel payloads (``RAW_RGB`` / ``RAW_DEPTH``; JPEG in toy mode) with a small binary header. No base64, no JSON wrapping. A per‑station streaming resolution cap (default 480p) keeps multiple 30 fps camera streams comfortably within gigabit Ethernet.

### Discovery and manifest

On connection, c3po sends a `describe` request. r2d2 responds with a machine‑readable manifest:

```json
{
  "api_version": "1.0",
  "station_model": "so101_teleop",
  "control_rate": 50.0,
  "arms": [
    {
      "name": "follower",
      "joint_count": 6,
      "joint_names": [
        "shoulder_pan",
        "shoulder_lift",
        "elbow_flex",
        "wrist_flex",
        "wrist_roll",
        "gripper"
      ],
      "command_mode": "joint_position"
    }
  ],
  "cameras": [
    { "name": "front_rgb", "resolution": [720, 1280] },
    { "name": "wrist_rgb", "resolution": [480, 640] }
  ],
  "controllers": [
    { "name": "leader", "type": "joint_position", "joint_count": 6 }
  ]
}
```

c3po parses this to auto‑derive observation and action dictionaries. The researcher never configures key names or array shapes — they read `robot.arms`, `robot.cameras`, and `robot.action_keys` to introspect the station.

### Observation format

Flat dictionaries of NumPy arrays:

```python
{
    "follower/joint_position": np.array([0.1, -0.3, 0.5, -0.2, 0.0, 0.0]),
    "follower/joint_velocity": np.array([0.01, -0.02, 0.0, 0.01, 0.0, 0.0]),
    "leader/joint_position":  np.array([0.12, -0.28, 0.52, -0.18, 0.0, 0.0]),
    "front_rgb":              np.ndarray(shape=(720, 1280, 3), dtype=uint8),
    "wrist_rgb":              np.ndarray(shape=(480, 640, 3), dtype=uint8),
}
```

### Action format

Flat dictionaries matching `robot.action_keys`:

```python
{"follower/joint_position": np.array([0.15, -0.29, 0.51, -0.19, 0.0, 0.0])}
```

### Recording

r2d2 records datasets in LeRobot v3.0 format (parquet + MP4 video) natively. c3po sends `start_recording`, `stop_recording`, and `cancel_episode` messages. Episode boundaries are signaled by `reset()`. Recording is transparent — the researcher's loop doesn't change, and the dataset on disk is immediately compatible with LeRobot's training pipelines.

---

## 4. Key Design Decisions

### 4.1 LeRobot as hardware layer, not as dependency

r2d2 imports LeRobot's robot, camera, and calibration code from a vendored source tree (cloned at the pinned v0.6.0 tag during the Docker build) rather than as a pip package. This avoids pulling in LeRobot's PyTorch, HuggingFace Hub, and training dependencies. Two small patches make `types.py` and `device_utils.py` torch‑optional. Hardware LeRobot itself doesn't support (Franka, ZED) ships as third‑party plugin packages under `plugins/` (see the r2d2 README, §4).

### 4.2 MDP‑inspired API

c3po exposes `reset()` and `step(action)` — the same interface as Gym, DM Env, and every RL framework. r2d2 owns the control loop timing. c3po's `step()` blocks until the next observation arrives from r2d2, so the researcher's loop is naturally paced at the station's native control rate.

### 4.3 Manifest‑driven schema

Every key in the observation and action dictionaries is mechanically derived from the `describe` manifest. Hardware changes → manifest changes → user code introspects `robot.arms`, `robot.cameras`, and `robot.action_keys` to adapt. No configuration duplication.

### 4.4 Controllers are sensors

Leader arms, gamepads, and other teleoperation devices plug into the NUC. Their state appears in the observation dictionary alongside the follower arms. The protocol treats them identically — the policy decides what to do with the numbers.

### 4.5 No real‑time kernel on the NUC (except Franka)

r2d2 communicates with each robot's internal real‑time controller (Franka control box, Kinova base controller, Feetech servo firmware) over Ethernet or USB‑serial. The NUC is a setpoint relay. For the SO‑101, ReBot, and most arms no PREEMPT_RT kernel is required. **Exception:** the Franka Panda's libfranka FCI link requires a PREEMPT_RT kernel on the NUC — see `franka_setup.md`. Each arm's hardware safety reflexes remain fully active.

### 4.6 Recording is server‑side, format is community‑standard

Data is recorded on r2d2 in LeRobot v3.0 format — the same format used by LeRobot's training pipelines and HuggingFace Hub datasets. c3po never writes files. The researcher downloads finished datasets from the NUC.

### 4.7 Keyboard controls without extra dependencies

c3po includes a built‑in keyboard listener that captures **q** (quit / stop recording), **n** (next episode), and **r** (re‑record episode) from the terminal — the same signals LeRobot uses, the same muscle memory. It uses only Python stdlib (`termios`, `tty`, `select`) on Unix and gracefully degrades on Windows. No `pynput`, no extra pip installs.

---

## 5. Quick Start

### On the NUC

```bash
docker run -d --restart=unless-stopped \
  -p 9090:9090 \
  -p 9091:9091 \
  --device=/dev/ttyACM0:/dev/ttyACM0 \
  --device=/dev/video0:/dev/video0 \
  -v /opt/r2d2/station.yaml:/config/station.yaml \
  r2d2:v0.1
```

### On the researcher's machine

```bash
pip install c3po
```

```python
from c3po import Robot

with Robot() as robot:
    with robot.recording("session_001") as rec:
        while not rec.stop:
            obs = robot.reset()
            while not rec.stop and not rec.done:
                obs = robot.step(policy(obs))
            if rec.rerecord:
                robot.cancel_episode()
            rec.clear()   # reset episode flags for next iteration

Press **n** to end an episode, **r** to re‑record, **q** to stop. That's it.

---

## 6. Supported Hardware

| Robot                    | Connection              | Backend                           | Status  |
| ------------------------ | ----------------------- | --------------------------------- | ------- |
| SO‑101 (Feetech STS3215) | USB‑serial              | LeRobot `SOFollower`              | ✓       |
| Franka Panda             | Ethernet to control box | Custom `FrankaRobot` (franky/libfranka, plugin package)  | ✓ (hardware‑verified) |
| DROID (Franka Panda + Robotiq 2F‑85 + 2× ZED) | Ethernet + USB | Custom `DroidRobot` (pylibfranka 1 kHz torque loop, plugin package) | station hardware‑verified; torque loop pending arm validation |
| Kinova Gen3              | Ethernet                | Custom `KinovaRobot` (Kortex API) | planned |
| ReBot B601‑DM            | CAN bus                 | LeRobot `RebotB601Follower` (native in v0.6.0) | ✓ |

| Camera          | Connection | Backend                      | Depth |
| --------------- | ---------- | ---------------------------- | ----- |
| UVC webcam      | USB        | LeRobot `OpenCVCamera`       | —     |
| Intel RealSense | USB        | LeRobot `RealSenseCamera`    | ✓     |
| Stereolabs ZED  | USB        | Custom `ZedCamera` (ZED SDK) | ✓     |

| Controller              | Connection   | Backend                          |
| ----------------------- | ------------ | -------------------------------- |
| SO‑101 leader arm       | USB‑serial   | LeRobot `SOLeader`               |
| ReBot Arm 102 leader    | USB‑UART     | LeRobot `RebotArm102Leader`      |
| Gamepad / keyboard      | USB HID      | LeRobot teleop backends          |

| Gripper        | Connection     | Backend                                       |
| -------------- | -------------- | --------------------------------------------- |
| Robotiq 2F‑85  | USB (RS‑485)   | Shared `RobotiqGripperWrapper` (plugin package) |

---

## 7. Repository Structure

| Repository | Purpose                       | Packaging                         |
| ---------- | ----------------------------- | --------------------------------- |
| `r2d2`     | Robot station server (NUC)    | Docker image (`python:3.12-slim`) |
| `c3po`     | Inference client (researcher) | `pip install c3po`                |

The `describe` manifest is the compatibility boundary. Any r2d2 server with the same API major version is compatible with any c3po client with the same major version.
