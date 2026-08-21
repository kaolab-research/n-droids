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

N‑Droids uses the **franky 2.0** Python library (which wraps libfranka) to read
joint state and send position commands at 50 Hz.  The NUC is a setpoint relay —
it never runs the low-level 1 kHz control loop.  franky 2.x wheels bundle a
fixed libfranka version that must match the control box's FCI server version:
the legacy Emika Panda (system 4.2.x) tops out at FCI server 5 → libfranka
0.9.2, the wheel the r2d2 Dockerfile installs by default.

---

## 2. One-time NUC Setup

The NUC must run **Ubuntu 22.04 LTS** (the current, hardware‑verified
setup).  An Ubuntu 24.04 migration is planned (plan/phase_25.md) but not
yet validated.  Run these commands once.

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

3. No special driver needed — pyrobotiqgripper communicates over Modbus
   RTU via the USB serial port and is installed inside the Docker container.
   The default Modbus device ID is 9 (standard for Robotiq grippers).

   The launch scripts map the host device to a stable container-side name
   ``/dev/robotiq`` (the station configs set ``gripper.com_port`` to it,
   which makes the gripper connect directly instead of probing every
   serial port at startup).  For a stable name across reboots, point the
   script at the by-path symlink found in step 2:

   ```bash
   ROBOTIQ_DEVICE=/dev/serial/by-path/pci-0000:80:14.0-usb-0:1:1.0-port0 \
     ./launch_scripts/franka_zed.sh
   ```

   If you need to change the device ID, edit ``station.franka.robotiq.yaml``
   and set ``gripper.device_id``.

### ZED stereo cameras (optional)

If you are using ZED stereo cameras for the DROID-style setup:

1. **Install CUDA on the RT kernel** (if not already done above for Franka).
   The ZED SDK requires CUDA for depth computation:

   ```bash
   wget https://raw.githubusercontent.com/timschneider42/franky/master/tools/install_cuda_realtime.bash
   chmod +x install_cuda_realtime.bash
   sudo IGNORE_PREEMPT_RT_PRESENCE=1 bash install_cuda_realtime.bash
   ```

2. **Install the NVIDIA Container Toolkit** so the Docker container can use
   the GPU.  This injects the NVIDIA driver libraries (``libcuda.so.1``,
   ``libnvidia-ml.so.1``, …) and device nodes into containers started with
   ``--gpus all``.  Without it, the r2d2 server fails at startup with
   ``ImportError: libcuda.so.1: cannot open shared object file``:

   ```bash
   sudo apt-get install -y nvidia-container-toolkit
   sudo nvidia-ctk runtime configure --runtime=docker
   sudo systemctl restart docker

   # Verify GPU access from inside a container:
   sudo docker run --rm --gpus all ubuntu nvidia-smi
   ```

3. **Install the ZED SDK** on the host.  Download the `.run` installer for
   your Ubuntu version from https://www.stereolabs.com/developers/release/.
   Install the version matching the r2d2 ``Dockerfile``'s
   ``ZED_SDK_VERSION`` build arg (currently **5.4.1**); the exact installer
   filename varies by release, e.g.:

   ```bash
   # For Ubuntu 22.04 + CUDA 12.x + ZED SDK 5.4.1 (filename may differ):
   wget https://download.stereolabs.com/zedsdk/5.4.1/ZED_SDK_Ubuntu22_cuda12.1.run
   chmod +x ZED_SDK_Ubuntu22_cuda12.1.run
   ./ZED_SDK_Ubuntu22_cuda12.1.run -- silent skip_od_model_download
   ```

   The SDK installs to ``/usr/local/zed/``.  Three pieces of the SDK are
   needed inside the Docker container:

   - The **pyzed Python bindings** are baked into the Docker image as a
     CPython-3.12 wheel from Stereolabs, version-matched to the host SDK
     (see ``ZED_SDK_VERSION`` in the r2d2 ``Dockerfile``).  Do **not**
     volume-mount the host's ``/usr/lib/python3/dist-packages/pyzed`` —
     it is built for the distro Python (3.10), not for the container's
     Python 3.12, and will fail with ``ModuleNotFoundError: pyzed.sl``.
   - The SDK's native ``.so`` libraries (``/usr/local/zed/lib``) and the
     CUDA runtime (``/usr/local/cuda/lib64``) live on the host and are
     volume-mounted by ``launch_scripts/franka_zed.sh``.
   - The NVIDIA **driver** libraries (``libcuda.so.1`` etc.) and GPU device
     nodes are injected by the NVIDIA Container Toolkit via the script's
     ``--gpus all`` flag (installed in step 2 above).

   If you upgrade the ZED SDK on the host, rebuild the image with the
   matching version:

   ```bash
   docker build --build-arg ZED_SDK_VERSION=5.4.1 -t r2d2:latest .
   ```

4. **Find your camera serial numbers**:

   ```bash
   python3 -c "import pyzed.sl as sl; devices = sl.Camera.get_device_list(); \
       [print(f'  {d.serial_number}  {d.camera_model}') for d in devices]"
   ```

   Add the serial numbers to ``station.franka.zed.yaml`` to guarantee which
   camera is wrist vs. scene.

5. **Verify**:

   ```bash
   python3 -c "import pyzed.sl as sl; print(sl.Camera.get_device_list())"
   # Should list your connected ZED cameras.
   ```

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
| `IncompatibleVersionException` | Wrong libfranka version for your firmware | Franka Panda uses libfranka 0.9.2 (FCI server 5) — the Dockerfile's `FRANKY_LIBFRANKA` build arg must match the server |
| FCI activation button greyed out | Brakes not unlocked first | Unlock joints, then activate FCI |
| Arm does not move | FCI not activated in Desk | Go to Desk → Activate FCI |
| `franky is not installed` in Docker logs | Docker image is stale | Rebuild with `docker build -t r2d2:latest .` |
| Arm is jerky during teleop | Dynamics factor too high | Lower `relative_dynamics_factor` (currently 0.05 = 5%) |
| Joints unlock but arm sags | Normal — gravity compensation starts when FCI activates | Activate FCI in Desk |
| Gripper not available error (ignored) | Stock Franka hand missing or replaced | The driver skips gripper init for the stock hand — no action needed.  For Robotiq, use the robotiq launch script. |
| `could not open port` in Docker logs | Robotiq USB device not passed to container | Verify `--device="${ROBOTIQ_DEVICE}:/dev/robotiq"` is in the launch script and the device exists on the host |
| Gripper does not respond to commands | Wrong serial number or Modbus communication failure | Check the serial number on the gripper label; verify `/dev/serial/by-path/` exists inside the container |
| `ImportError: libcuda.so.1: cannot open shared object file` | NVIDIA Container Toolkit not installed, or container started without `--gpus all` | Install `nvidia-container-toolkit`, restart Docker, and use `launch_scripts/franka_zed.sh` (which passes `--gpus all`) |
| `docker: ... could not select device driver ... [[gpu]]` | Same as above | Same as above |
| `libpng16.so.16` / `libgomp.so.1` / `libudev.so.1` / `libturbojpeg.so.0` missing in Docker logs | System runtime libraries for the ZED SDK missing from the image | Rebuild the image (the Dockerfile installs them; jpeg/turbojpeg come from Ubuntu packages for symbol-version parity with the SDK) |
| `libjpeg.so.8: version LIBJPEG_8.0 not found` | The ZED SDK needs Ubuntu's libjpeg-turbo8 (SONAME + symbol versions); Debian's libjpeg62-turbo is not version-compatible | Rebuild the image — the Dockerfile installs Ubuntu's `libjpeg-turbo8` and `libturbojpeg0` packages |
| `CAMERA STREAM FAILED TO START` in Docker logs | Camera busy in another application, USB 2.0 port/hub, or cable/firmware issue | Run the camera-open diagnostic above (host first, then container); replug the camera's USB cable if a previous open crashed |
| `CAMERA MOTION SENSORS NOT DETECTED` + `can't claim interface` at container start | A ZED wedged at the USB level by a previous session (seen once after an e-stop incident; the SDK's own retry/USB-reboot can't reclaim the device) | Reset the device from the host instead of replugging: `sudo usbreset 004/021` (ZED-M) / `sudo usbreset 004/022` (ZED 2), or by vendor/product ID: `sudo usbreset 2b03:f682` (ZED-M) / `2b03:f780` (ZED 2).  Both ZEDs share USB **bus 004** (`usbreset` lists `bus/device`); the other devices (mouse/keyboard/hub/RS-485) are on bus 003.  Wait a few seconds for re-enumeration, then restart the container.  If the same camera wedges repeatedly, its port/hub is suspect — check `lsusb -t` and move it to a port on a different controller |
| `CORRUPTED SDK INSTALLATION` / `NEURAL TRT NOT FOUND` (host) | ZED SDK's default NEURAL depth mode requires TensorRT, which the host SDK install lacks | Use `DEPTH_MODE.PERFORMANCE` (the r2d2 driver already does), or re-run the SDK installer with the AI module |
| `exec /usr/local/bin/python: operation not permitted` | The image's python carries the `cap_sys_nice` file capability (for libfranka), and Linux won't exec it without that capability in the bounding set | Add `--cap-add=SYS_NICE` to the `docker run` (the launch scripts already include it) |
| Container lists `0` cameras (`get_device_list() -> []`) | ZED USB enumeration needs raw device access | Run the container with `--privileged` (Stereolabs' official recommendation — plain `/dev/bus/usb` mounts are not enough), as `franka_zed.sh` does |
| `Invalid calibration file` / `No calibration file ... Downloading ... curl` | Factory calibration download needs `curl` (now in the image) and network; the settings dir should persist | Rebuild the image (includes `curl` + `ca-certificates`), mount `/usr/local/zed/settings` (the script does), and set `LC_ALL=C` — the script does both |
| Any other `cannot open shared object file` | A library the SDK links is missing inside the container | Run the diagnostic below to list **all** remaining gaps at once (no rebuild needed) |
| `ImportError: No module named 'pyzed.sl'` | Host pyzed bindings mounted into the container (built for distro Python 3.10, not 3.12) | Remove any `-v .../pyzed` mount; the correct bindings are baked into the image (see the ZED section above) |

### Library diagnostic (run on the NUC, before starting the server)

This reproduces the container's library view — same mounts and linker
path as `franka_zed.sh` — and lists every unresolved library in one shot:

```bash
docker run --rm --entrypoint /bin/sh --gpus all \
  -v /usr/local/zed/lib:/usr/local/zed/lib:ro \
  -v /usr/local/cuda:/usr/local/cuda:ro \
  -e LD_LIBRARY_PATH=/usr/local/zed/lib:/usr/local/cuda/lib64 \
  r2d2:latest -c "ldd /usr/local/zed/lib/libsl_zed.so | grep 'not found'"
```

Empty output means the SDK libraries will load.  (For reference,
`libsl_ai.so` legitimately shows `libnvinfer*.so.10 => not found` even on
the host — those TensorRT AI modules are loaded lazily and are not needed
for camera streaming.)

### Camera open diagnostic

`CAMERA STREAM FAILED TO START` from `sl::Camera::open()` is a
hardware-access error, not a library problem.  Bisect host vs container:

**1. Can the camera open on the host?**

```bash
python3 - <<'EOF'
import pyzed.sl as sl
devs = sl.Camera.get_device_list()
print(len(devs), [(d.serial_number, d.camera_model, d.camera_state) for d in devs])
init = sl.InitParameters()
init.camera_resolution = sl.RESOLUTION.HD720
init.camera_fps = 30
init.depth_mode = sl.DEPTH_MODE.PERFORMANCE  # like the r2d2 driver; avoids TensorRT
cam = sl.Camera()
print("open:", cam.open(init))
cam.close()
EOF
```

If the host open fails with `CORRUPTED SDK INSTALLATION` /
`NEURAL TRT NOT FOUND`: the SDK's *default* NEURAL depth mode needs
TensorRT, which the host SDK install lacks.  The r2d2 driver uses
`PERFORMANCE` mode (no TensorRT needed) — run the test above with
`PERFORMANCE` (as written).  If you want NEURAL/AI features on the host
later, re-run the ZED SDK installer with the AI module (or verify
`libnvinfer*.so.10` exist under `/usr/local/zed/lib`).

If the host open also fails with `PERFORMANCE`: the camera is busy in
another application (ZED cameras are exclusive — close ZED_Explorer /
any zed process), is on a USB 2.0 port or hub (check `lsusb -t` for
SuperSpeed / 5000M), or needs a replug/firmware update.  A previously
crashed open (segfault) can leave the camera stuck — replug its USB
cable before retrying.

**2. If the host works, can the container open it?**

```bash
docker run -i --rm --privileged --gpus all --cap-add=SYS_NICE --entrypoint python \
  -v /usr/local/zed/lib:/usr/local/zed/lib:ro \
  -v /usr/local/zed/settings:/usr/local/zed/settings \
  -v /usr/local/cuda:/usr/local/cuda:ro \
  -e LD_LIBRARY_PATH=/usr/local/zed/lib:/usr/local/cuda/lib64 \
  -e LC_ALL=C \
  r2d2:latest - <<'EOF'
import pyzed.sl as sl
devs = sl.Camera.get_device_list()
print(len(devs), [(d.serial_number, d.camera_model, d.camera_state) for d in devs])
init = sl.InitParameters()
init.camera_resolution = sl.RESOLUTION.HD720
init.camera_fps = 30
init.depth_mode = sl.DEPTH_MODE.PERFORMANCE
cam = sl.Camera()
print("open:", cam.open(init))
cam.close()
EOF
```

(`--cap-add=SYS_NICE` is required for *any* direct `python`/`r2d2-server`
exec in this image: the python binary carries the `cap_sys_nice` file
capability for libfranka, and Linux refuses to exec it unless that
capability is in the container's bounding set.  `franka_zed.sh` already
passes it — without it you get
`exec /usr/local/bin/python: operation not permitted`.)

If the container lists 0 cameras, the USB devices aren't passed through —
use the bind mount `-v /dev/bus/usb:/dev/bus/usb` (NOT `--device` with a
directory, which doesn't grant the cgroup access USB enumeration needs)
and compare `ls /dev/bus/usb/*/*` inside and outside the container.
