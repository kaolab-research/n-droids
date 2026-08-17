# Phase 20: Lightweight LeRobot v3.0 Dataset Parser (c3po)

**Goal**: Let researchers read LeRobot v3.0 datasets (parquet + MP4) without
installing the full ``lerobot`` package.  This directly supports n-droids'
core value prop: minimal dependencies on the researcher's machine.

**Design**.  A new ``c3po.data`` submodule that reads the on-disk format
produced by r2d2's ``DatasetRecorder``.  Dependencies: ``pyarrow`` (already a
c3po dependency), ``av`` or ``opencv-python-headless`` for MP4 decoding.

#### Task 20.1: Episode reader — parquet + video (5 tests)

**Files**: NEW ``c3po/src/c3po/data/__init__.py``, ``c3po/src/c3po/data/_reader.py``

- ``EpisodeReader`` class: opens a chunk directory, reads parquet files in
  episode order, decodes MP4 videos lazily.
- Handle depth frames stored as PNG sequences.
- **Tests**: read single-episode dataset, video frame count matches parquet
  frame count, depth PNG sequence, missing video directory handled gracefully.

#### Task 20.2: Dataset metadata — info.json + stats.json (2 tests)

**Files**: ADAPT ``c3po/src/c3po/data/_reader.py``

- Parse ``meta/info.json`` and ``meta/stats.json`` into typed dicts.
- Expose ``fps``, ``robot_type``, ``total_episodes``, ``total_frames``.
- **Tests**: info fields match, stats contain all expected features.

#### Task 20.3: Public API — ``open_dataset`` context manager (2 tests)

**Files**: ADAPT ``c3po/src/c3po/data/__init__.py``

- ``open_dataset(path)`` returns a ``Dataset`` object with ``info``, ``stats``,
  ``episodes()`` iterator, ``__len__()``.
- Each frame is a dict with string keys and numpy array values.
- **Tests**: context manager clean lifecycle, iteration, frame dict keys, len.

---
