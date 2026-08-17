# Phase 22: BOX Dataset Upload (r2d2)

**Goal**: After recording, r2d2 automatically uploads the finalized dataset
to the lab's BOX account (infinite storage via the advisor's account), then
deletes the local copy to free up space on the NUC.  The upload runs in the
background — the researcher can disconnect and walk away immediately after
pressing ``q``.  No upload logic on c3po.

**Key design decisions**:

- **Upload on r2d2, not c3po.**  The dataset already lives on the NUC;
  uploading directly avoids a download-then-upload round-trip.  A single
  BOX API token (shared lab credential) lives on the NUC — no token
  distribution to individual researchers.
- **Fire-and-forget.**  The upload runs in the same background asyncio task
  that handles ``end_episode()`` + ``finalize()`` (see Phase 10 fix).  The
  researcher can disconnect immediately; the upload continues.
- **Auto-cleanup.**  On successful upload, r2d2 deletes the local dataset
  directory.  The NUC is a control computer, not a storage server — disk
  space is reclaimed automatically.
- **Fallback.**  If upload fails, the local copy is preserved and the
  researcher can still download it via HTTP (Phase 12).
- **Zero new dependencies.**  Uses Python stdlib ``urllib`` for the BOX API.
  BOX's chunked upload is standard HTTP (session create → PUT parts → commit).

#### Task 22.1: BOX upload client (4 tests)

**Files**: NEW ``r2d2/src/r2d2/_box_upload.py``

- ``upload_dataset_to_box(dataset_path, box_token, folder_name=None)``:
  recursively uploads a directory tree to BOX, preserving structure.
- Authentication: ``Authorization: Bearer {token}`` header on every request.
- Small files (< 50 MB): single ``POST /files/content`` with multipart.
- Large files (>= 50 MB): BOX chunked upload session API:
  1. ``POST /files/upload_sessions`` — create session (folder_id, file_size, file_name)
  2. ``PUT /files/upload_sessions/{id}/parts`` — upload each chunk with
     ``Content-Range`` and ``Digest`` (SHA-1) headers in parallel
  3. ``POST /files/upload_sessions/{id}/commit`` — finalize, returns file metadata
- Returns the BOX shared link URL on success.
- Raises ``BoxUploadError`` with a clear message on failure (auth, network,
  quota, etc.).
- **Tests**: mock HTTP responses with ``unittest.mock.patch`` on
  ``urllib.request``, small file upload constructs correct multipart body,
  chunked upload splits file correctly, commit returns expected URL,
  auth failure raises BoxUploadError, network error retries once.

#### Task 22.2: r2d2 — wire upload into StopRecording flow (3 tests)

**Files**: ADAPT ``r2d2/src/r2d2/_server.py``

- Extend the ``_finalize_dataset`` background task (spawned in the
  ``StopRecording`` handler) with an optional upload step:
  ```python
  async def _finalize_dataset() -> None:
      # ... existing end_episode + finalize + status sends ...

      # Auto-upload to BOX if configured.
      if _box_token is not None:
          logger.info("Uploading %r to BOX ...", name)
          try:
              url = await rec_loop.run_in_executor(
                  None,
                  lambda: upload_dataset_to_box(
                      _path, _box_token, folder_name="n-droids"
                  ),
              )
              logger.info("Uploaded %r to BOX: %s", name, url)
              # Delete local copy to free NUC disk space.
              await rec_loop.run_in_executor(None, shutil.rmtree, _path)
              logger.info("Deleted local dataset %r", name)
              await self._send_status(
                  "dataset_uploaded",
                  f"{name} uploaded to BOX",
                  name=name,
                  url=url,
              )
          except Exception:
              logger.exception(
                  "BOX upload failed for %r — dataset preserved locally",
                  name,
              )
  ```
- The ``_box_token`` is captured from the server configuration at handler
  creation time (see Task 20.3).
- The upload runs in a thread-pool executor to avoid blocking the event loop.
- ``shutil.rmtree`` also runs in the executor since it's a potentially slow
  filesystem operation on large directory trees.
- **Tests**: upload skipped when token is None, upload called with correct
  path and folder, local dataset deleted after successful upload, local
  dataset preserved on upload failure, ``dataset_uploaded`` StatusMessage
  sent on success.

#### Task 22.3: Server config — BOX token from environment (2 tests)

**Files**: ADAPT ``r2d2/src/r2d2/_server.py``

- ``create_server()`` reads ``BOX_TOKEN`` from the environment.
- Pass the token (or ``None``) through to ``_ConnectionHandler`` so the
  background task can access it.
- Add a ``--box-token`` CLI flag to ``main()`` as an alternative to the
  env var (useful for Docker secrets).
- **Tests**: token read from env var, token passed through to handler,
  None when not configured.

---
