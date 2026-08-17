# Phase 11: Status protocol & runtime introspection ✅

**Goal**: Full-duplex status channel + `spec` request/response for live debugging.

#### Task 11.1: Protocol — add SpecRequest / SpecResponse (3 tests)

**Files**: ADAPT both `_protocol.py` files

```python
@dataclass
class SpecRequest:
    type: str = field(default="spec_request", init=False)

@dataclass
class SpecResponse:
    effective_control_rate: float
    uptime_seconds: float
    cameras: list[dict[str, Any]]
    recording: dict[str, Any] | None
    watchdog_trigger_count: int
    type: str = field(default="spec_response", init=False)
```

#### Task 11.2: r2d2 — serve spec requests with live metrics (4 tests)

- Track per-camera frame send count and drop count.
- Track effective control rate (rolling average over last 100 cycles).
- Respond to `SpecRequest` with current metrics.
- **Tests**: spec includes camera stats, spec includes recording state,
  effective rate is measured, uptime increments.

#### Task 11.3: c3po — Robot.spec() convenience method (2 tests)

- `robot.spec()` sends `SpecRequest`, returns parsed `SpecResponse`.
- Expose as a property-like method for one-shot debugging.
- **Tests**: spec returns expected keys, spec works mid-session.

---
