# N‑Droids Implementation Plan

The plan is split into one file per phase under [`plan/`](plan/).

- Each `phase_XX.md` contains that phase's full plan: goals, design
  decisions, task breakdowns, tests, and — for completed phases — what
  was actually learned along the way.
- Phases 00–07 were compacted to one-line summaries in an earlier
  cleanup; their full planning content has been **recovered from the git
  history** (provenance is noted at the top of each file).
- Phase 26 onward is the living log: audit fixes, the plugin
  architecture, and every hardware bring-up follow-up are recorded there.

| Phase | Title | Status |
|---|---|---|

† Recovered from git history (provenance noted in the file).
| [00](plan/phase_00.md) † | Foundation | ✅ |
| [01](plan/phase_01.md) † | Protocol spec + mock infrastructure (21 tests) | ✅ |
| [02](plan/phase_02.md) † | c3po transport + robot (57 tests) | ✅ |
| [03](plan/phase_03.md) † | r2d2 server, toy mode (19 tests) | ✅ |
| [04](plan/phase_04.md) † | c3po recording + keyboard (18 tests, 2 skipped) | ✅ |
| [05](plan/phase_05.md) † | r2d2 recording + safety (17 tests) | ✅ |
| [06](plan/phase_06.md) † | Integration + Docker + E2E (5 tests) | ✅ |
| [07](plan/phase_07.md) † | SO-101 Hardware + UVC Camera (12 tests) | ✅ |
| [08](plan/phase_08.md) | Camera Transmission Pipeline | ✅ |
| [09](plan/phase_09.md) | Camera Streaming Resolution | ✅ |
| [10](plan/phase_10.md) | Bug fixes & signal handling | ✅ |
| [11](plan/phase_11.md) | Status protocol & runtime introspection | ✅ |
| [12](plan/phase_12.md) | Dataset forwarding over Ethernet | ✅ |
| [13](plan/phase_13.md) | LeRobot v0.6.0 Bump | ✅ |
| [14](plan/phase_14.md) | ReBot B601-DM Support | ✅ |
| [15](plan/phase_15.md) | Controller Architecture (27 tests, hardware-verified) | ✅ |
| [16](plan/phase_16.md) | Franka Panda Support (16 tests, hardware-verified) | ✅ |
| [17](plan/phase_17.md) | Robotiq 2F-85 Gripper Support (28 tests, hardware-verified) | ✅ |
| [18](plan/phase_18.md) | Stereolabs ZED Camera Support (22 tests, hardware-verified) | ✅ |
| [19](plan/phase_19.md) | π0.5-DROID Policy Interface Alignment | 🔄 19.1–19.5 ✅, 19.6 pending hardware |
| [20](plan/phase_20.md) | Lightweight LeRobot v3.0 Dataset Parser (c3po) | planned |
| [21](plan/phase_21.md) | c3po Live View | tabled |
| [22](plan/phase_22.md) | BOX Dataset Upload (r2d2) | planned |
| [23](plan/phase_23.md) | Remote Lab Server as Inference Machine | tabled |
| [24](plan/phase_24.md) | Operational Maturity Roadmap | tabled |
| [25](plan/phase_25.md) | Ubuntu 24.04 LTS Migration | planned |
| [26](plan/phase_26.md) | Audit fixes + third-party plugin architecture | ✅ |

---

## Deferred Phases

**Deferred**: HuggingFace Hub and Dropbox upload backends.  These require
auth tokens (HF_TOKEN, DROPBOX_TOKEN) and the existing HTTP forwarding
covers the immediate need.  Will be implemented when tokens are available.

**Deferred**: server-side stop on watchdog timeout (r2d2 aborts Franka
motion instead of only alarming).  The watchdog is currently a
monitoring alarm — if c3po dies mid-motion the arm finishes the last
``JointMotion`` and holds.  Physical e-stop and FCI reflexes remain the
stop mechanism; a software stop is worth adding before long autonomous
π0.5 rollouts.  Raised by the 2026-08-17 audit.

---

## Hardware proven

| Feature | Status |
|---|---|
| SO-101 leader→follower teleop | ✅ |
| UVC webcam (640×480) | ✅ |
| RealSense RGB (1280×720) | ✅ |
| RealSense depth | ✅ (raw uint16, native rate) |
| 50Hz teleop with cameras | ✅ (cameras decoupled from control loop) |
| Multiple simultaneous cameras | ✅ (2× UVC + 1× RealSense) |
| Dataset recording (parquet + MP4) | ✅ |
| Stable device naming (by-path) | ✅ |
| Configurable control rate | ✅ |
| Streaming resolution cap | ✅ |
| StatusMessage protocol | ✅ |
| Graceful SIGTERM shutdown | ✅ |
| Connect/disconnect logging | ✅ |
| Health check log suppression | ✅ |
| Camera error resilience (graceful fallback + status) | ✅ |
| Recording episode counter / discard / ready messages | ✅ |
| Spec runtime introspection (`robot.spec()`) | ✅ |
| Plain-text spec output (`str(spec)`) | ✅ |
| Dataset HTTP transfer | ✅ |
| Dataset download (`robot.download_dataset()`) | ✅ |
| ReBot B601-DM config + launch scripts | ✅ (manifest + mapping proven in tests) |
| ReBot bimanual leader-follower teleop | ✅ (hardware-verified) |
| Controller abstraction (`Controller` dataclass) | ✅ |
| Manifest-driven capabilities (`controller_capabilities`) | ✅ |
| Auto-reset (leader → home on connect) | ✅ (hardware-verified on SO-101) |
| Haptic feedback stub (`.current` → `send_feedback`) | ✅ (stub, gates on capability) |
| No-camera station config | ✅ |
| Franka Panda teleop (JointMotion, 10 Hz sinusoidal) | ✅ (hardware-verified, error ~0.04 rad RMS, no accumulation) |
| Franka Panda config + launch script | ✅ (server v5, libfranka 0.9.2, PREEMPT_RT on NUC) |
| Franka Panda Docker integration (franky-control + setcap) | ✅ |
| Robotiq 2F-85 gripper connect + activate (pyrobotiqgripper v3.3.13) | ✅ (hardware-verified, device 9, /dev/ttyUSB0) |
| Robotiq 2F-85 live state + move at 50 Hz | ✅ (hardware-verified, bounded ~0.03 m tracking error) |
| Robotiq 2F-85 Docker integration (USB serial passthrough) | ✅ |
| Franka tracking error analysis (test_franka.py) | ✅ (per-joint mean/max/RMS, no error accumulation) |
| Third-party plugin architecture (lerobot_robot_franka / lerobot_camera_zed) | ✅ (register_third_party_plugins, no vendored-tree copies) |
| ZED in container: pyzed cp312 wheel + host .so mounts + --gpus all + --privileged | ✅ (2× ZED open in container) |
| ZED calibration in container (host settings mount + LC_ALL=C + curl) | ✅ |
| ZED background grab threads (non-blocking snapshots) | ✅ |
| ZED RGB streaming at native rate | ✅ (30 fps per camera, steady) |
| ZED depth streaming (uint16 mm) | ✅ (30 fps, RAW_DEPTH) |
| ZED + Franka + Robotiq simultaneously, ~48–50 Hz control loop | ✅ (hardware-verified) |
| Robotiq direct-port connection (com_port, no auto-detect probing) | ✅ |
| DROID station end-to-end (r2d2 in Docker ↔ c3po over Ethernet) | ✅ |
