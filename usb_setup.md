# USB Device Setup Guide

This guide explains how to identify and hardcode USB device paths for the
ReBot B601-DM robot station so the r2d2 Docker container can reliably find
the CAN adapter, leader arm UART adapters, and RealSense cameras.  No prior
Linux device knowledge is assumed.

---

## 1. Background

Linux assigns device names like `/dev/ttyACM0` and `/dev/ttyUSB0` dynamically.
The same physical device may get a different name after a reboot, which breaks
the station config.  We solve this with **`/dev/serial/by-path/` symlinks** —
these are tied to the physical USB port the device is plugged into.  As long
as cables aren't moved, the path stays stable.

For **RealSense cameras**, we use the camera's unique **serial number** instead
of a device path.  This is always stable regardless of which USB port it's in.

---

## 2. Identify your USB devices

Run this on the NUC with all devices connected:

```bash
ls -l /dev/serial/by-path/
```

You'll see output like:

```
lrwxrwxrwx 1 root root 13 Jul 27 10:00 pci-0000:00:14.0-usb-0:1:1.0 -> ../../ttyACM0
lrwxrwxrwx 1 root root 13 Jul 27 10:00 pci-0000:00:14.0-usb-0:3:1.0 -> ../../ttyUSB0
lrwxrwxrwx 1 root root 13 Jul 27 10:00 pci-0000:00:14.0-usb-0:4:1.0 -> ../../ttyUSB1
```

Each symlink name is a unique PCI path.  The right-hand side shows which
`/dev/tty*` device it currently points to.

### Which is which?

This depends on your physical wiring.  A reliable way to identify:

1. **Disconnect all USB devices from the NUC.**
2. Plug in ONLY the Damiao CAN adapter and run `ls -l /dev/serial/by-path/`.
   The single new entry is your **CAN adapter**.  Note its PCI path.
3. Plug in the left leader UART adapter.  The new entry is your **left leader**.
4. Plug in the right leader UART adapter.  The new entry is your **right leader**.

Keep a note — you'll copy these paths into the station config and launch script.

### Alternative: by-id

If your devices have USB serial numbers (most do), you can use
`/dev/serial/by-id/` instead:

```bash
ls -l /dev/serial/by-id/
```

This is also stable across reboots as long as the same physical device is used.
The mechanism is identical — just use `by-id` paths in your config.

---

## 3. Identify your RealSense cameras

RealSense cameras are identified by serial number, not by device path:

```bash
rs-enumerate-devices | grep "Serial"
```

Example output:

```
Serial No: 241322074564
Serial No: 241322071938
Serial No: 233622072542
```

If `rs-enumerate-devices` is not installed, you can also check with:

```bash
lsusb -v 2>/dev/null | grep -A5 "Intel(R) RealSense"
```

Copy each serial number into the station config's `serial_number_or_name` field.

---

## 4. CAN bus setup (if using SocketCAN)

The configs in this repo default to `can_adapter: damiao` (the Damiao dedicated
serial bridge).  If your ReBot uses a SocketCAN adapter (e.g., PCAN, slcan):

1. Configure the CAN interface on the NUC:

   ```bash
   sudo ip link set can0 type can bitrate 1000000
   sudo ip link set up can0
   ```

2. In the station config, change the arm config:

   ```yaml
   left_arm_config:
     port: can0
     can_adapter: socketcan
   ```

3. The launch script must bind-mount the CAN device (if it's a character
   device) or use `--network=host` for network-based CAN adapters.

---

## 5. Update your station config

Once you've identified all paths, update the station config YAML:

```yaml
robot:
  type: bi_rebot_b601
  left_arm_config:
    port: /dev/serial/by-path/pci-0000:00:14.0-usb-0:1:1.0  # your CAN adapter path
    cameras:
      left_wrist:
        serial_number_or_name: "241322074564"  # your left wrist camera serial
  right_arm_config:
    port: /dev/serial/by-path/pci-0000:00:14.0-usb-0:1:1.0  # same CAN bus
    cameras:
      right_wrist:
        serial_number_or_name: "241322071938"  # your right wrist camera serial

teleop:
  left_arm_config:
    port: /dev/serial/by-path/pci-0000:00:14.0-usb-0:3:1.0  # your left leader path
  right_arm_config:
    port: /dev/serial/by-path/pci-0000:00:14.0-usb-0:4:1.0  # your right leader path
```

The launch scripts already bind-mount the `/dev/serial/by-path/` and
`/dev/bus/usb` directories, so the symlinks and RealSense cameras resolve
inside the container.

---

## 6. Verify the connection

After starting r2d2 with your config, check the logs:

```bash
docker logs -f r2d2-rebot-bimanual-2rs
```

You should see:

```
r2d2 server starting on 0.0.0.0:9090 (toy=False, rate=50.0 Hz)
Describe handshake complete
c3po client connected
```

If you see errors about being unable to open a port or find a camera:

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `Could not open port /dev/serial/by-path/...` | Wrong PCI path or device not connected | Re-run Step 2 above |
| `No device matching serial ...` | Wrong RealSense serial number | Re-run Step 3 above |
| `Permission denied` on /dev/tty* | User not in `dialout` group | `sudo usermod -aG dialout $USER` on NUC |
| Camera shows black frames | RealSense USB bandwidth saturated | Use fewer cameras or lower resolution |
| CAN bus timeout | Damiao adapter not powered or wrong baud rate | Check USB cable; verify `dm_serial_baud: 921600` |

---

## 7. Make it permanent (optional)

The `/dev/serial/by-path/` symlinks are created by udev automatically and
survive reboots.  No additional configuration is needed — as long as cables
stay in the same physical USB ports, the paths will not change.

If you need to move cables (e.g., after maintenance), re-run Step 2 and update
the station config.
