# Network Setup Guide

This guide explains how to connect your **inference machine** (laptop/desktop)
to the **NUC** (robot station computer) so c3po can talk to r2d2.  No prior
networking knowledge is assumed.

---

## 1. Background

Every computer on a network has an **IP address** — like a phone number.  c3po
needs to know r2d2's IP address to connect.  We use **10.42.0.1** for the NUC
and **10.42.0.2** for the inference machine.  These are private addresses that
only work between directly-connected computers — they don't conflict with your
Wi‑Fi or lab network.

The physical connection is a standard Ethernet cable between the two machines.
If your NUC has only one Ethernet port, both your lab network and the
inference machine share that port (the switch handles routing).  This is fine.

---

## 2. Find your Ethernet interfaces

Run this on **both** machines and save the output:

```bash
ip addr show
```

You'll see several entries.  Ignore `lo` (loopback), `docker`, `tailscale`,
and anything starting with `wl` (Wi‑Fi).  Look for entries that start with
`en` (Ethernet) and have a `link/ether` line followed by an `inet` line with
a `192.168.x.x` or similar address.  That's your Ethernet port.

**Example — NUC:**
```
2: eno1: <...> state UP ...
    link/ether 3c:52:82:76:e9:12 ...
    inet 192.168.2.2/24 ...
```
→ The interface is `eno1`.

**Example — inference machine:**
```
12: enx606d3c637c36: <...> state UP ...
    link/ether 60:6d:3c:63:7c:36 ...
    inet 192.168.2.100/24 ...
```
→ The interface is `enx606d3c637c36` (a USB Ethernet adapter).

> **How do I know which one connects to the NUC?**  Look at the IP address.
> The NUC and the inference machine should be on the same subnet — e.g., both
> start with `192.168.2`.  If you're unsure, physically unplug the cable and
> run `ip addr show` again — the interface that disappears is the one.

---

## 3. Assign static IPs

Run these commands **once** (they take effect immediately but don't survive
a reboot — see Section 5 for making them permanent).

### On the NUC

```bash
sudo ip addr add 10.42.0.1/24 dev <NUC-INTERFACE>
```

Replace `<NUC-INTERFACE>` with the name you found in Step 2 (e.g., `eno1`).

### On the inference machine

```bash
sudo ip addr add 10.42.0.2/24 dev <INFERENCE-INTERFACE>
```

Replace `<INFERENCE-INTERFACE>` with the name you found in Step 2
(e.g., `enx606d3c637c36`).

---

## 4. Verify the connection

From the **inference machine**:

```bash
ping 10.42.0.1
```

You should see replies like `64 bytes from 10.42.0.1: icmp_seq=1 ttl=64 time=0.5 ms`.
Press `Ctrl+C` to stop.

From the **NUC**:

```bash
ping 10.42.0.2
```

If both work, the network is configured.  c3po will now connect at the default
address — no environment variables needed:

```bash
python teleop.py
```

---

## 5. Make it permanent (optional)

The `ip addr add` command is temporary — it's lost on reboot.  To make it
permanent, add it to your network configuration.

### On Ubuntu / Debian (most NUCs)

Edit `/etc/netplan/01-netcfg.yaml` (create it if it doesn't exist):

```yaml
network:
  version: 2
  ethernets:
    eno1:                          # your NUC interface
      addresses:
        - 10.42.0.1/24
```

Then apply:

```bash
sudo netplan apply
```

### On macOS (inference machine)

System Preferences → Network → select the Ethernet adapter → Configure IPv4:
"Manually" → IP Address: `10.42.0.2`, Subnet Mask: `255.255.255.0`.

### On other Linux distributions

Add to `/etc/network/interfaces` or use NetworkManager:

```bash
nmcli con mod "Wired connection 1" +ipv4.addresses 10.42.0.2/24
nmcli con up "Wired connection 1"
```

---

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `ping` says "Destination Host Unreachable" | Wrong interface or cable unplugged | Double-check interface names from Step 2 |
| `ping` works but c3po can't connect | r2d2 not running or firewall blocking port 9090 | Check `docker ps` on NUC; verify r2d2 is running |
| `sudo: ip: command not found` | `iproute2` not installed | `sudo apt install iproute2` (Ubuntu) or use `ifconfig` |
| Both machines on Wi-Fi, no Ethernet | Connections share the router | This works but adds latency; use Ethernet for production |

---

## 7. Robot-Specific Setup

This guide covers only the network layer (IP configuration, Ethernet
cabling).  For robot-specific setup instructions, see:

- [Franka Panda Setup](./franka_setup.md) — PREEMPT_RT kernel, Franka Desk,
  Docker container with franky, per-session startup sequence.
