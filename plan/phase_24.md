# Phase 24: Operational Maturity Roadmap (tabled)

**Goal**: Transform N-Droids from a solo-developer research prototype into a
maintainable, collaborative-grade software project.  Items are prioritized by
impact-to-effort ratio.  Everything below is deferred — the immediate priority
Franka + ZED + Robotiq support for the DROID project.

#### 24.1: CI/CD Pipeline (GitHub Actions) — highest priority

**Why**: 257 tests with zero automation.  Every change is tested manually on
one machine.  A CI pipeline catches regressions before they reach hardware.

**How**: ``.github/workflows/ci.yml`` with three jobs:

1. **Lint** — ``uv run ruff check`` + ``uv run ruff format --check`` on both repos
2. **Test c3po** — ``uv run pytest tests/ -v`` (135 tests, ~30 s)
3. **Test r2d2** — ``uv run pytest tests/ -v`` (121 tests, ~30 s, skip LeRobot
   import tests in CI)
4. **Docker build** — ``docker build -t r2d2:ci .`` catches Dockerfile regressions

Uses ``astral-sh/setup-uv@v5`` for zero-config ``uv`` caching.  Estimated
setup time: 1–2 hours.

#### 24.2: Protocol de-duplication — high priority

**Why**: ``_protocol.py`` (344 lines) is manually duplicated in both repos.
Divergence causes silent incompatibility — a time bomb for a two-process
communication system.

**How**: Extract to a tiny ``n-droids-protocol`` package (zero dependencies,
stdlib only).  Both c3po and r2d2 depend on it via ``pip install``.  The
protocol can be versioned independently (bump 1.0 → 1.1 when adding a new
message type).  For local development, use ``uv``'s path dependency:

```toml
[tool.uv.sources]
n-droids-protocol = { path = "../n-droids-protocol", editable = true }
```

#### 24.3: Linting & Formatting (Ruff) — high priority

**Why**: Consistent style catches real bugs (unused imports, undefined names,
mutable defaults).  Ruff is fast (Rust) and replaces a dozen tools.

**How**: Add ``[tool.ruff]`` to each ``pyproject.toml`` with rules for
pycodestyle, pyflakes, isort, pyupgrade, bugbear, comprehensions, and
simplify.  Run ``uv run ruff check . --fix`` once, then enforce in CI.

#### 24.4: Pre-commit Hooks — medium priority

**Why**: Catches issues before they're committed (trailing whitespace, YAML
syntax errors, accidentally committed secrets).  Prevents the "CI is red →
fix → push again" loop.

**How**: ``.pre-commit-config.yaml`` with ruff, trailing-whitespace,
end-of-file-fixer, check-yaml, check-toml, detect-private-key.

#### 24.5: Type Checking (Mypy) — medium priority

**Why**: The protocol layer is a contract between two processes.  A type error
means garbled messages, not a clean exception.

**How**: Start gradual — strict mode on ``_protocol``, ``_safety``, ``_utils``,
and ``exceptions`` modules.  Loose mode on everything else.  Add
``[tool.mypy]`` to ``pyproject.toml``.

#### 24.6: Docker Image CI + Container Registry — medium priority

**Why**: The Dockerfile clones LeRobot from GitHub and applies patches.  If the
repo moves or patches stop applying cleanly, the image silently fails to build.

**How**: Add a Docker build job to CI (above).  Push built images to GitHub
Container Registry (GHCR) on main branch pushes.

#### 24.7: Dependency Update Automation — low priority

**Why**: Dependencies ship security patches.  Automated PRs let you review
and merge on your schedule.

**How**: Enable Dependabot on GitHub (Settings → Code security → Dependabot),
or add ``.github/dependabot.yml``.  Dependabot supports ``uv.lock`` natively.

#### 24.8: Conventional Commits + Auto-Changelog — low priority

**Why**: When c3po is published to PyPI, users need to know what changed.
Manual changelogs are always forgotten.

**How**: Adopt Conventional Commits (``feat:``, ``fix:``, ``docs:``) for commit
messages.  Use ``commitizen`` to auto-bump versions and generate
``CHANGELOG.md``.

---
