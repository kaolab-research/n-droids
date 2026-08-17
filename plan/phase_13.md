# Phase 13: LeRobot v0.6.0 Bump ✅

**Goal**: Bump the vendored LeRobot source in r2d2 from v0.5.1 to v0.6.0.
v0.6.0 adds native ReBot support (enabling Phase 14), fixes Feetech position
overflow bugs, standardizes bimanual robot patterns, and splits dependencies
into finer-grained extras.

**Key finding**: ``torch`` remains a core dependency (not moved to an extra),
so the ``types-no-torch.patch`` is still required — regenerated against the
new ``types.py`` line offsets.

Import paths for ``SOFollowerRobotConfig``, ``SOLeaderTeleopConfig``,
``OpenCVCameraConfig``, ``make_robot_from_config``, and
``make_teleoperator_from_config`` are all **unchanged**.  The bump is mostly
a tag change in the Dockerfile.

#### Task 13.1: Regenerate torch-optional patches ✅

**Files**: ``r2d2/patches/types-no-torch.patch``, ``r2d2/patches/device-utils-no-torch.patch``

- Regenerated ``types-no-torch.patch`` against v0.6.0's ``types.py``.  Same logic,
  updated line offsets (v0.6.0 added ``from __future__ import annotations``
  shifting everything by 1 line; the ``try/except`` block adds 4 more).
- **New**: ``device-utils-no-torch.patch`` for ``lerobot/utils/device_utils.py``.
  v0.6.0's hardware import chain (``robots.utils`` → ``motors`` →
  ``utils.__init__`` → ``device_utils``) hits a second bare ``import torch``
  that our original patch didn't cover.  The patch adds ``from __future__
  import annotations`` (so ``-> torch.device`` type annotations are lazily
  evaluated) and wraps ``import torch`` in a ``try/except`` guard.
- Verified both patches apply cleanly against the v0.6.0 source tree.

#### Task 13.2: Update r2d2 Dockerfile ✅

**Files**: ``r2d2/Dockerfile``

- Changed ``git clone --branch v0.5.1`` → ``git clone --branch v0.6.0``.
- No new pip packages needed: hardware-only code path does not import
  ``gymnasium``, ``einops``, ``safetensors``, or other training deps.
  Existing package list is sufficient.

#### Task 13.3: Register ReBot config in r2d2 ✅

**Files**: ``r2d2/src/r2d2/_config.py``

- Added ``RebotB601FollowerRobotConfig`` import and ``_ROBOT_REGISTRY["rebot_b601"]``
  entry.  Since v0.6.0 natively supports ReBot, this is just a registry entry —
  no custom driver needed.  LeRobot's ``make_robot_from_config`` handles the rest.

#### Task 13.4: Verify test suite ✅

- ``test_config.py`` uses ``pytest.importorskip("lerobot")`` — safely skipped
  when lerobot is not importable.  No test changes needed.
- Full r2d2 test suite (79 tests) and c3po test suite (132 tests) pass.

---
