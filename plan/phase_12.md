# Phase 12: Dataset forwarding over Ethernet ✅

**Goal**: Get datasets off the NUC and onto the inference machine with zero
friction, using the existing Ethernet link.  No cloud services, no auth tokens.

HTTP is the right mechanism: simplest possible server (Python stdlib), no
extra dependencies, point-to-point trusted link.

#### Task 12.1: r2d2 — HTTP file server on port 9091 (3 tests) ✅

**Files**: ADAPT `r2d2/src/r2d2/_server.py`

- Start a background `http.server.HTTPServer` on port 9091 serving `/datasets`.
  Read-only, directory listing enabled, binds `0.0.0.0` (accessible from the
  inference machine at `http://10.42.0.1:9091/datasets/`).
- Runs in a daemon thread alongside the WebSocket server — no asyncio
  integration needed for a simple file server.
- Stops cleanly when the main server shuts down.
- **Tests**: server starts on port 9091, directory listing shows dataset
  directories, parquet file is downloadable via HTTP GET.

#### Task 12.2: r2d2 — DatasetReady notification with URL (2 tests) ✅

**Files**: ADAPT `r2d2/src/r2d2/_server.py`

- After `stop_recording` → `finalize()`, send a `dataset_ready` StatusMessage:
  ```json
  {
    "event": "dataset_ready",
    "message": "session_001 ready (5 episodes, 210 MB)",
    "data": {
      "name": "session_001",
      "episodes": 5,
      "frames": 1250,
      "size_bytes": 220200960,
      "url": "http://10.42.0.1:9091/session_001/"
    }
  }
  ```
- Compute dataset size with `du` or by walking the directory tree.
- **Tests**: status sent after stop_recording, URL is correct, size is
  non-zero for non-empty datasets.

#### Task 12.3: c3po — Robot.download_dataset() convenience method (5 tests) ✅

**Files**: ADAPT `c3po/src/c3po/robot.py`

- `robot.download_dataset(name, dest=".")` downloads the dataset from
  `http://10.42.0.1:9091/datasets/{name}/` to `dest/{name}/`.
- Uses `requests` (already available as a transitive dependency via
  `websocket-client`).
- Shows a progress bar via `tqdm` if available.
- **Tests**: download succeeds for small test dataset, files are written
  to correct destination.

---
