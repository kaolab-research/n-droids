
# N(ecl)‑Droids Technical Report

## A Protocol Droid System for Robot Learning Research

---

## Abstract

N‑Droids is a two‑component middleware that decouples robot hardware from AI inference. It consists of **r2d2**, a Docker-based server that runs on a robot-station NUC and translates hardware-specific protocols into standardised ROS 2 topics, and **c3po**, a lightweight Python client library that AI researchers use on their own machines to interact with any robot station via a simple `obs`/`action` dictionary API. The system removes the need for researchers to ever touch a robot driver, USB bandwidth issues, or ROS 2 launch files, while keeping the full power of native ROS 2 communication on the wire. This report details the overall architecture, the reasoning behind the two-repository split, the communication contract, and the phased deployment plan beginning with the SO‑101 educational arm.

---

## 1. System Architecture

```
┌──────────────────────────────────┐         Ethernet (direct)        ┌──────────────────────────────┐
│  Robot Station NUC               │◄────────────────────────────────►│  Researcher’s Laptop         │
│                                  │                                  │                              │
│  ┌────────────────────────────┐  │  /observations/joint_position    │  ┌──────────────────────────┐│
│  │ r2d2 Docker Container      │  │  /observations/front_rgb         │  │  Python Script           ││
│  │ • robot adapter (SO‑101,   │  │  /observations/wrist_rgb         │  │  from c3po import        ││
│  │   Franka, Kinova…)         │  │                                  │  │      RobotClient         ││
│  │ • camera drivers (UVC,     │  │  /commands/joint_position        │  │  robot = RobotClient()   ││
│  │   RealSense…)              │  │  /commands/joint_velocity        │  │  while True:             ││
│  │ • DHCP server              │  │  /describe (service)             │  │      obs = robot.get_obs()││
│  │ • /describe service        │  │                                  │  │      act = policy(obs)   ││
│  └────────────────────────────┘  │                                  │  │      robot.send_action(  ││
│                                  │                                  │  │          act)            ││
│  Physical connections:           │                                  │  └──────────────────────────┘│
│  - Robot arm (USB/serial, Eth)   │                                  │                              │
│  - Cameras (USB)                 │                                  │                              │
└──────────────────────────────────┘                                  └──────────────────────────────┘
```

- **r2d2** owns all hardware interaction. It is the only place where robot‑specific drivers and camera backends exist.
- **c3po** is a pure Python library that discovers the robot via ROS 2’s built‑in DDS discovery, receives standardised observations, and sends actions.
- A **single Ethernet cable** with DHCP (provided by r2d2) connects the two. No manual IP configuration is required.

---

## 2. Why Two Repositories?

N‑Droids is divided into two independent repositories, `r2d2` and `c3po`, with a strict separation of concerns:

- **`r2d2`** contains heavy, hardware‑specific dependencies (robot drivers, `libfranka`, kernel modules) and is deployed as a Docker image. It is maintained by the lab infrastructure team and updated when new robots or sensors are added.
- **`c3po`** is a pure‑Python package installable via `pip`. It depends only on `numpy` and the system‑provided `rclpy` (ROS 2 Humble). It is updated when the observation/action API evolves or when client‑side bugs are fixed.

A shared message contract (topic names, service definitions, and message types) guarantees compatibility across versions. The two repos are versioned independently with semantic versioning, and the contract is documented in each repo’s `README` and enforced via integration tests.

---

## 3. Communication Contract

All communication between r2d2 and c3po happens over ROS 2 native DDS on a dedicated Ethernet link.

### Discovery
- **Service**: `/describe` (custom service type `c3po_msgs/Describe`)
  - Returns a JSON string containing: `robot_model`, `joint_count`, `control_rate`, `camera_names` (list of strings), `command_mode` (e.g., `"joint_position"`).
- r2d2 runs this service. c3po’s `RobotClient` calls it on startup to dynamically build subscribers and publishers.

### Observations
- **Joint state**: `/observations/joint_position` (`sensor_msgs/JointState`) with `position` and `velocity` fields.
- **Camera images**: `/observations/<camera_name>_rgb` (`sensor_msgs/Image`), raw or compressed. Depth images follow same pattern with `_depth` suffix.
- Additional modalities (force‑torque, haptics) will be added later under the `/observations` namespace.

### Actions
- **Joint position command**: `/commands/joint_position` (custom message `c3po_msgs/Action` with `mode = "joint_position"` and `float64[] data`).
- **Joint velocity command**: `/commands/joint_velocity` (same message type, different mode).
- Future modes (Cartesian, gripper) will extend the `mode` field and `data` layout.

### QoS
- Observations use `reliable` + `volatile` with queue depth 1 (latest sample only) to avoid latency buildup.
- Commands use `reliable` + `keep_last(1)`.

---

## 4. Key Design Decisions

1. **Native ROS 2 on both sides**  
   No custom HTTP/WebSocket bridge. The client directly speaks DDS, giving full access to ROS 2 tooling (topic echo, bag recording) and avoiding a single‑point‑of‑failure translation layer. The one‑time ROS 2 installation on the researcher’s machine is considered acceptable given the lab’s technical proficiency and the availability of ROS 2 Humble in standard Ubuntu repositories.

2. **MDP‑inspired API**  
   The c3po client exposes a single `RobotClient` object with `get_observation() -> dict` and `send_action(dict)`. This matches the mental model of reinforcement learning and behavior cloning, aligning with Gym and LeRobot data conventions. Observations and actions are dictionaries of NumPy arrays; the user never imports ROS 2 types.

3. **No real‑time kernel on the NUC**  
   r2d2 uses the robot’s own internal real‑time controller (e.g., Franka’s control box, SO‑101 firmware) and communicates via non‑real‑time setpoint protocols (serial, or Franka’s joint velocity interface). This eliminates the need for a PREEMPT_RT kernel on the NUC and simplifies deployment. Hard real‑time torque‑control mode (FCI) is not used; the NUC acts solely as a setpoint relay.

4. **Containerised server, native client**  
   r2d2 is a Docker container to encapsulate complex native dependencies. c3po is a plain Python package to integrate naturally with researchers’ existing environments (conda, pip, IDE debugging). This hybrid approach balances maintainability and user experience.

5. **Direct Ethernet connection with DHCP**  
   r2d2 runs a minimal DHCP server on the inference‑facing NIC. The researcher’s laptop obtains an IP automatically, and ROS 2 multicast discovery works out of the box. This eliminates all network configuration steps.

---

## 5. Phased Deployment Roadmap

**v0.1 – Echo Station**  
- Robot: SO‑101 (6‑DOF, serial communication)  
- Cameras: up to two USB UVC webcams  
- Control mode: joint position  
- Validation: teleoperation demo (leader‑follower SO‑101 pair)

**v0.2 – Protocol Expansion**  
- Robot: Franka Panda (joint velocity setpoint mode)  
- Gripper support  
- Safety watchdog (`goldenrod`) for command timeout

**v0.3 – Rebel Fleet**  
- Robots: Kinova Gen3, ReBot  
- Cartesian velocity control  
- Multi‑station ROS 2 domain segregation

**v1.0 – Full Deployment**  
- ALOHA bimanual setup  
- Ethernet camera support for >2 sensors  
- Profiling dashboard and latency visualisation

---

## 6. Repository Structure

| Repository | Purpose | Packaging |
|------------|---------|-----------|
| `r2d2`    | Robot station server (NUC) | Docker image (`ghcr.io/necl/r2d2`) |
| `c3po`    | Inference client (researcher) | PyPI package (`c3po`) |

Each repo contains its own tests, examples, and CI. The shared message definitions (`c3po_msgs`) are kept in a `msgs/` directory within `r2d2` and copied into `c3po` during development; long‑term they will become a separate ROS 2 package.
