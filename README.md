# N‑Droids

## A Protocol Droid System for Robot Learning Research

---

## Abstract

N‑Droids is a two‑component middleware that decouples robot hardware from AI inference. It consists of **r2d2**, a Docker‑based server running on a dedicated NUC at each robot station, and **c3po**, a lightweight pure‑Python client library that researchers install on their own machines. Together they let anyone walk up to a robot station, plug in a single Ethernet cable, and interact with the full hardware stack — arms, cameras, grippers, teleoperation controllers — through a single `Robot` object with an API that matches the RL mental model.

The system eliminates the need for researchers to install robot drivers, camera SDKs, or ROS 2. The NUC handles all hardware interaction. The researcher’s machine runs a policy, collects data, or drives teleoperation — all from a Python script with two dependencies.

---

## 1. System Architecture

```
┌─── NUC (r2d2) ──────────────────────────┐      ┌─── Inference machine ───────────┐
│                                          │      │                                 │
│  Docker container                         │      │  Python script                  │
│  ┌────────────────────────────────────┐  │      │  ┌───────────────────────────┐ │
│  │  Composable ROS 2 nodes            │  │      │  │  from c3po import Robot   │ │
│  │  ├─ adapter_node (arms)            │  │      │  │                           │ │
│  │  ├─ camera_node (cameras)          │  │      │  │  robot = Robot()          │ │
│  │  ├─ controller_node (leaders,      │  │      │  │  obs = robot.reset()      │ │
│  │  │   spacemouse, pedals)           │  │  ws  │  │  while True:              │ │
│  │  ├─ abstraction_node (republish)   │◄─┼──────┼─►│      action = policy(obs) │ │
│  │  ├─ describe_node (/describe)      │  │      │  │      obs = robot.step(    │ │
│  │  ├─ watchdog_node (safety)         │  │      │  │          action)          │ │
│  │  └─ rosbridge (WebSocket bridge)   │  │      │  └───────────────────────────┘ │
│  └────────────────────────────────────┘  │      │                                 │
│                                          │      │  Dependencies:                   │
│  DHCP server on inference NIC            │      │    numpy, websocket-client       │
│  (always at 10.42.0.1:9090)              │      │                                 │
│                                          │      │  Any OS. No ROS 2 required.      │
│  Physical connections:                   │      │                                 │
│  ├─ Follower arm (USB/serial, Eth)       │      │                                 │
│  ├─ Leader arm (USB/serial)              │      │                                 │
│  ├─ Cameras (USB)                        │      │                                 │
│  └─ HID controllers (USB)                │      │                                 │
└──────────────────────────────────────────┘      └─────────────────────────────────┘
```

**r2d2** owns all hardware interaction. Every robot‑specific driver, camera SDK, and controller protocol lives inside the Docker container on the NUC. It is never installed on a researcher’s machine.

**c3po** is a pure‑Python package than can be installed on any operating system. It communicates with r2d2 over a single WebSocket connection. The researcher’s machine receives standardised observation dictionaries and sends action dictionaries — no ROS 2 types, no launch files, no DDS configuration.

**Networking** is automatic. r2d2 runs a DHCP server on the inference Ethernet port, assigning itself `10.42.0.1`. The researcher plugs in a cable, their machine obtains an IP, and c3po connects to `ws://10.42.0.1:9090`. No manual IP configuration.

---

## 2. Why Two Repositories?

N‑Droids is divided into two independent repositories with a strict separation of concerns:

| | r2d2 | c3po |
|---|---|---|
| **Where it runs** | NUC at robot station | Researcher’s machine |
| **Owns** | Robot drivers, camera SDKs, kernel modules, DHCP | Policy loop, data collection, teleoperation logic |
| **Packaging** | Docker image | `pip install c3po` |
| **Dependencies** | ROS 2 Humble, librealsense, DepthAI, libfranka, etc. | `numpy`, `websocket-client` |
| **Maintained by** | Lab infrastructure team | Package maintainers (API design) |
| **Updated when** | New robots or sensors are added | API evolves or client bugs are fixed |

The two repos are versioned independently with semantic versioning. Compatibility is guaranteed by the `/describe` manifest contract, which both sides implement and integration tests enforce.

---

## 3. Communication Contract

### Transport

r2d2 runs a **rosbridge** WebSocket server on port 9090 of the inference NIC. c3po connects to `ws://10.42.0.1:9090` and communicates using the standard rosbridge JSON protocol. ROS 2 DDS operates entirely inside the NUC — it never crosses the Ethernet cable into the researcher’s environment.

This design was chosen because:
- **c3po becomes truly dependency‑light.** No `rclpy`, no ROS 2 system packages. `numpy` and `websocket-client` are the only requirements.
- **Any OS works.** macOS, Windows (WSL2 or native), any Linux distribution.
- **The NUC still benefits from ROS 2 internally.** DDS, QoS, topic recording, and the ROS 2 node ecosystem are all available where they matter — inside the hardware‑facing container.

### Discovery and manifest

On connection, c3po calls the `/describe` service through rosbridge. r2d2 responds with a machine‑readable manifest describing every piece of hardware at the station:

```json
{
  "api_version": "1.0",
  "station_model": "so101_teleop",
  "control_rate": 50.0,
  "arms": [
    {"name": "follower", "joint_count": 6, "joint_names": ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"], "command_mode": "joint_position"}
  ],
  "cameras": [
    {"name": "follower/wrist_rgb", "resolution": [480, 640]},
    {"name": "front_rgb", "resolution": [720, 1280]}
  ],
  "controllers": [
    {"name": "leader", "type": "joint_position", "joint_count": 6, "joint_names": ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"]}
  ]
}
```

c3po uses this manifest to auto‑derive the observation and action dictionaries. The researcher never configures key names or array shapes — they read `robot.arms`, `robot.cameras`, `robot.controllers`, and `robot.action_keys` to introspect the station.

### Observation format

Observations are flat dictionaries of NumPy arrays. Keys follow a simple convention:

| Key pattern | Meaning | Type |
|---|---|---|
| `{arm}/joint_position` | Joint angles in radians | `float64` array, shape `(joint_count,)` |
| `{arm}/joint_velocity` | Joint velocities in rad/s | `float64` array, shape `(joint_count,)` |
| `{camera}` | Camera image (RGB or depth) | `uint8` array for RGB, `uint16` for depth |
| `{controller}/state` | Controller reading | Depends on controller type |

For single‑arm stations, the arm prefix is omitted: `joint_position` rather than `follower/joint_position`. For multi‑arm stations (bimanual ALOHA), every arm gets its own prefix: `left_follower/joint_position`, `right_follower/joint_position`.

Single‑arm example:
```python
{
    "joint_position": np.array([0.1, -0.3, 0.5, -0.2, 0.0, 0.0]),
    "joint_velocity": np.array([0.01, -0.02, 0.0, 0.01, 0.0, 0.0]),
    "leader/joint_position": np.array([0.12, -0.28, 0.52, -0.18, 0.0, 0.0]),
    "front_rgb": np.ndarray(shape=(720, 1280, 3), dtype=uint8),
    "follower/wrist_rgb": np.ndarray(shape=(480, 640, 3), dtype=uint8),
}
```

### Action format

Actions are flat dictionaries with the same key structure. The keys that `step()` expects are listed in `robot.action_keys`:

```python
{
    "follower/joint_position": np.array([0.15, -0.29, 0.51, -0.19, 0.0, 0.0]),
}
```

---

## 4. Key Design Decisions

### 4.1 WebSocket‑only client transport

ROS 2 is the right tool for hardware integration. It is not the right dependency for a researcher’s Python environment. By keeping ROS 2 confined to the NUC and bridging to the client via WebSocket, n‑droids delivers on its core promise: "researchers don’t need to install anything except `pip install c3po`."

### 4.2 MDP‑inspired API

c3po exposes a single `Robot` class with `reset()` and `step(action)` — the same interface as Gym, DM Env, and every RL framework researchers already use. `step()` handles control‑rate timing internally, freeing the researcher from managing `time.sleep()` or worrying about sensor rate mismatches. Each call returns the latest available observation from every sensor without blocking on slow topics.

### 4.3 Manifest‑driven schema

Every key in the observation and action dictionaries is mechanically derived from the `/describe` manifest. The researcher never names a joint or camera. When hardware changes, the manifest changes, and user code introspects `robot.arms`, `robot.cameras`, and `robot.action_keys` to adapt. No configuration duplication, no stale schemas.

### 4.4 Controllers are sensors

Teleoperation devices — leader arms, spacemouse, foot pedals, keyboards — plug into the NUC alongside the follower arms and cameras. Their state is published into the observation stream and appears in the observation dictionary alongside everything else. Whether a particular observation key represents a controller or a follower is irrelevant — the policy decides what to do with the numbers.

### 4.5 No real‑time kernel

r2d2 uses each robot’s internal real‑time controller (SO‑101 firmware, Franka control box) and communicates via non‑real‑time setpoint protocols. The NUC acts solely as a setpoint relay. No PREEMPT_RT kernel required. The arm’s own safety reflexes remain fully active.

### 4.6 Containerised server

r2d2 runs as a single Docker container with composable internal nodes. Every hardware driver and SDK is pre‑installed in the image. The lab manager runs one `docker run` command per station and leaves it running. No per‑researcher setup, no dependency conflicts between stations.

---

## 5. Controllers and Teleoperation

Controllers are input devices that publish state but do not accept commands. They appear in the `/describe` manifest under `controllers` and their readings appear in observation dictionaries.

**Leader arms** plug into the NUC via USB‑serial (same driver as a follower arm). Their joint positions appear as, e.g., `leader/joint_position`. A teleoperation policy is simply:

```python
from c3po import Robot

with Robot() as robot:
    obs = robot.reset()
    while True:
        # Teleop: leader position maps to follower command
        obs = robot.step({"follower/joint_position": obs["leader/joint_position"]})
```

**HID controllers** (spacemouse, keyboard, gamepad, foot pedal) can plug into either the NUC or the researcher’s machine depending on complexity. Simple HID devices with cross‑platform drivers may stay on the researcher’s machine. Devices requiring platform‑specific SDKs belong on the NUC and are published as controller observations.

The researcher’s policy script is always the canonical decision‑maker. The NUC never applies policy logic — it reliably transports sensor data and actuator commands.

---

## 6. Recording and Replay

Data collection is a first‑class feature. c3po provides a `Recorder` context manager:

```python
from c3po import Robot, Recorder

with Robot() as robot, Recorder(robot, "session_001.h5") as rec:
    obs = robot.reset()
    rec.start_episode()
    while not done:
        action = policy(obs)
        obs = robot.step(action)
        reward = compute_reward(obs)
        done = check_done(obs)
        rec.record(obs, action, reward, done)
    rec.end_episode()
```

For offline development, `ReplayClient` replays recorded sessions:

```python
from c3po import ReplayClient

with ReplayClient("session_001.h5") as robot:
    # robot.step() returns recorded frames in sequence
    for obs in robot:
        action = policy(obs)
```

The recording format is self‑describing HDF5 with the robot manifest embedded. A `to_lerobot_format()` utility converts recorded observations to LeRobot dataset format for training compatibility.

---

## 7. Deployment Roadmap

**Phase 1 — Foundation**
- Composable node architecture in r2d2
- WebSocket transport in c3po
- `Robot` class with `reset()` / `step()` / timing
- Extended `/describe` manifest
- Watchdog safety node
- SO‑101 adapter (joint position)

**Phase 2 — Transport & cameras**
- UVC webcam support
- Observation pipeline with camera frames
- RealSense camera adapter
- Recording and replay

**Phase 3 — Multi‑arm & production**
- Bimanual station support
- Franka Panda adapter (joint velocity)
- Controller abstraction (leader arm, HID)
- CI/CD pipeline with integration tests
- Station health monitoring

**Phase 4 — Full fleet**
- Kinova Gen3, ReBot adapters
- ALOHA bimanual deployment
- Multi‑station ROS 2 domain segregation
- Latency profiling dashboard

---

## 8. Repository Structure

| Repository | Purpose | Packaging |
|---|---|---|
| `r2d2` | Robot station server (NUC) | Docker image |
| `c3po` | Inference client (researcher) | PyPI package |
| `c3po_msgs` | Shared ROS 2 message definitions | ROS 2 package (vendored in both repos) |

Each repository contains its own tests, examples, and CI. The `/describe` manifest contract is the compatibility boundary — any r2d2 server with the same API version is compatible with any c3po client with the same major API version.
