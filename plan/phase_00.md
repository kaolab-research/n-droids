# Phase 00: (recovered from git history)

> **Provenance**: this file was recovered from commit `cab8424e`
> (2026-07-01 11:58:40 -0700) — the planning record at that point in the project's
> history.  It is kept for its notes and learning points; the
> current status line below reflects today's plan.

**Current status**: `Phase 0: Foundation ✅`

---

# Phase 00: (historical plan) Foundation (pre-coding) ✅

**Task 0.1: Set up LeRobot**

- Clone LeRobot v0.5.1 via `git clone --branch v0.5.1 --depth 1`
- Create and apply `patches/types-no-torch.patch` (only one patch needed — v0.5.1 has no `utils/__init__.py`)
- Verify: `from lerobot.motors.feetech import FeetechMotorsBus` imports without torch

**Task 0.2: Prune dead code**

- DELETE all ROS 2 nodes, launch files, `c3po_msgs/`, vendored LeRobot code, DHCP script, old config files, custom adapters, old c3po recorder/lerobot modules
- ADAPT: `__init__.py` files to remove deleted exports
- Verify: `grep -r "rclpy\|rosbridge\|c3po_msgs"` returns nothing
