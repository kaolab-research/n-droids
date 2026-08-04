# Franka Panda Setup Guide

This guide explains how to set up a Franka Panda robot station with N‑Droids.
It assumes you have already completed the [network setup guide](./network_setup.md)
(IP addresses, Ethernet cable connection).

No prior Franka or real-time Linux knowledge is assumed.

---

## 1. Background

The Franka Panda uses a control box that runs its own internal real-time
controller with active safety reflexes.  A PC (the NUC) communicates with it
over Ethernet using **libfranka**, which requires a real-time kernel to maintain
the 1 kHz communication cycle.

N‑Droids uses the **franky** Python library (which wraps libfranka) to read
joint state and send position commands at 50 Hz.  The NUC is a setpoint relay —
it never runs the low-level 1 kHz control loop.

---

## 2. One-time NUC Setup

The NUC must run **Ubuntu 24.04 LTS**.  Run these commands once.

### Enable the real-time kernel

```bash
sudo pro attach <your-ubuntu-pro-token>
sudo pro enable realtime-kernel
sudo reboot
```

After reboot, verify:

```bash
uname -a   # should show PREEMPT_RT
```

### Create the realtime group

```bash
sudo addgroup realtime
sudo usermod -a -G realtime $USER
```

Add these lines to `/etc/security/limits.conf`:

```
@realtime soft rtprio 99
@realtime soft memlock 102400
@realtime hard rtprio 99
@realtime hard memlock 102400
```

Log out and back in.  Verify your groups:

```bash
groups   # should include "realtime"
```

### Install CUDA on the RT kernel (for ZED cameras)

If you plan to use ZED cameras, NVIDIA drivers need a compatibility flag to
install on a real-time kernel.  Franky provides a convenience script:

```bash
wget https://raw.githubusercontent.com/timschneider42/franky/master/tools/install_cuda_realtime.bash
chmod +x install_cuda_realtime.bash
sudo ./install_cuda_realtime.bash
```

### Robotiq 2F-85 gripper (optional)

If you replaced the stock Franka hand with a Robotiq 2F-85 gripper:

1. Connect the gripper's USB cable to any USB port on the NUC.
2. Find the device path:

   ```bash
   ls -l /dev/serial/by-path/
   # Example output:
   # pci-0000:80:14.0-usb-0:1:1.0-port0 -> ../../ttyUSB0
   ```

3. Note the serial number printed on the gripper label (`C-51965`).
   This goes into the station config (see the robotiq launch script).

No driver installation is needed --- pyrobotiqgripper communicates over
USB serial and is installed inside the Docker container.

---

## 3. Per-Session Startup

Follow these steps **in order** every time you power on the Franka station.

### Step 1: Power on the Franka control box

Wait about 60 seconds for the web interface to become available.

### Step 2: Unlock joints and activate FCI via Franka Desk

Open a browser on the NUC and navigate to `https://172.16.0.2`.
Accept the self-signed certificate warning.

1. **Log in** (default: `franka` / `franka`, or your lab credentials).
2. Go to the **Robot** page (or Dashboard on newer firmware).
3. Click **Unlock Joints** — the brakes release and the arm may sag slightly.
4. Click **Activate FCI** — this makes the Franka Control Interface available
   on port 30200 so that libfranka / franky can connect.

> **Note**: If your robot has an external activation device (EAD), insert and
> turn the key to the unlocked position **before** unlocking joints.

### Step 3: Build and start the r2d2 Docker container

On the NUC, from the r2d2 repository:

```bash
cd ~/Projects/r2d2
docker build -t r2d2:latest .

# Stock Franka hand (default):
./launch_scripts/franka.sh

# Or, if you have a Robotiq 2F-85 gripper:
./launch_scripts/franka_robotiq.sh

docker logs -f r2d2-franka
```

You should see:

```
r2d2 server starting on 0.0.0.0:9090 (toy=False, rate=50.0 Hz)
Connecting to Franka at 172.16.0.2 ...
Franka connected: 172.16.0.2 (dynamics=5%)
Describe handshake complete
c3po client connected
```

### Step 4: Connect from the inference machine

On the inference machine, set the static IP (see [network setup](./network_setup.md)):

```bash
sudo ip addr add 10.42.0.2/24 dev <INFERENCE-INTERFACE>
```

Then run the test script:

```bash
cd ~/Projects/toy-so101
uv run python test_franka.py
```

The arm moves in a gentle sinusoidal pattern.  Press **Ctrl-C** to stop.

---

## 4. Shutdown

1. Press **Ctrl-C** in the test script terminal (or it stops after the
   configured duration).
2. Stop the Docker container:

   ```bash
   docker stop r2d2-franka
   ```

3. The Franka arm will hold its position (torque stays on).  To lock the
   joints, go to Franka Desk → **Lock Joints**, or simply power off the
   control box.

---

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Could not connect to Franka` | Control box not powered or wrong IP | Ping `172.16.0.2`; check Ethernet cable |
| `communication_constraints_violation` | RT kernel not enabled or realtime group missing | Re-check Section 2 |
| `IncompatibleVersionException` | Wrong libfranka version for your firmware | Franka Panda uses libfranka 0.9.2 — check the Dockerfile |
| FCI activation button greyed out | Brakes not unlocked first | Unlock joints, then activate FCI |
| Arm does not move | FCI not activated in Desk | Go to Desk → Activate FCI |
| `franky is not installed` in Docker logs | Docker image is stale | Rebuild with `docker build -t r2d2:latest .` |
| Arm is jerky during teleop | Dynamics factor too high | Lower `relative_dynamics_factor` (currently 0.05 = 5%) |
| Joints unlock but arm sags | Normal — gravity compensation starts when FCI activates | Activate FCI in Desk |
| Gripper not available error (ignored) | Stock Franka hand missing or replaced | The driver skips gripper init for the stock hand — no action needed.  For Robotiq, use the robotiq launch script. |
| `could not open port` in Docker logs | Robotiq USB device not passed to container | Verify `--device=/dev/ttyUSB0` is in the launch script and the device exists on the host |
| Gripper does not respond to commands | Wrong serial number or Modbus communication failure | Check the serial number on the gripper label; verify `/dev/serial/by-path/` exists inside the container |
