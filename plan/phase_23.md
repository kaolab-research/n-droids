# Phase 23: Remote Lab Server as Inference Machine (design tabled)

**Goal**: Support running c3po on a lab server (not physically cabled to the
NUC) for large policy inference that doesn't fit on a laptop.  The protocol is
TCP/WebSocket over IP — it's network-agnostic by design, so no code changes
are needed.  The decision is purely operational.

**Latency analysis.**  On a same-rack lab network, RTT is 1–2 ms — negligible
at 50 Hz (2.5–10% of a 20 ms cycle).  The NUC's control loop runs
independently; network latency only affects when c3po's ``step()`` returns.
For cross-campus or WAN links (>20 ms RTT), direct teleop becomes unusable,
but policy rollouts with buffered actions could still work.

**Three options documented (decision deferred):**

| | Option A: Single-homed | Option B: Dual-homed (rec.) | Option C: Multi-IP |
|---|---|---|---|
| NUC config | One Ethernet port on lab network (static IP e.g. ``192.168.1.50``) | Primary port on lab network + USB Ethernet adapter for direct-connect (``10.42.0.1``) | Same as A, but also assign ``10.42.0.1`` as a secondary IP on the same interface |
| Direct cable access | ❌ (lab network required) | ✅ (both paths available) | ✅ (temporary, assign ``10.42.0.2`` on researcher's machine) |
| Setup effort | Minimal | Moderate (USB adapter + netplan) | Low (``ip addr add``, same as current) |
| Best for | Pure remote use, no walk-up researchers | Mixed-use lab (some remote, some direct) | Quick remote access with direct fallback |

**Future additions (when selected):**

- WebSocket keepalive (ping/pong at 5 s intervals) — prevents silent TCP
  drops on shared networks.  ``websockets`` library supports this natively.
- Auto-reconnection in c3po with exponential backoff (1s → 2s → 4s → max 30s).
  On reconnect, re-send ``DescribeRequest`` and resume recording state.
- Firewall guidance: restrict port 9090 to lab server IP range.  Never expose
  to the internet.

---
