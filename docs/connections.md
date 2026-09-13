# Connections — is a connector actually going to work?

`vodou-core connections` answers one question per connector: **if Vodou reaches
for this right now, will it work?** — and says how it knows.

```
$ vodou-core connections
connector   state             expires              fail  last ok call         health     ledger   reason
airtable    alive             —                       0  2026-09-03 19:32:12  healthy    agrees   credential valid; last ok call 2026-09-03 19:32:12
asana       unconfigured      —                       0  —                    unhealthy  agrees   OAuth is configured but this connector was never signed in — a catalog entry, not a failure
zapier      idle-verified     —                       0  —                    healthy    agrees   no call in 30 days; the weekly probe answered ok

16 connector(s) · 0 need you to sign in again · 0 contradicted · 0 unknown · ledger rows: 16
```

## The states

A closed set of eight, spelled the same way by every reader:

| state | means | do you need to act? |
|---|---|---|
| `alive` | valid credential and a real call succeeded in the last 30 days | no |
| `idle` | valid credential, but no successful call in 30 days and nothing has verified it | not yet |
| `idle-verified` | no call in 30 days, but the weekly probe answered ok | no |
| `expired-refreshing` | the credential expired and a refresh is being attempted | no — wait |
| `expired-reconnect` | refresh failed 5 times in a row, or was refused | **yes — sign in again** |
| `unconfigured` | OAuth exists, nobody ever signed in | only if you want it |
| `unknown` | not enough evidence to grade | no — but it is not `ok` |
| `contradicted` | the recorded health disagrees with the evidence | **look at it** |

The distinction that matters most is **`idle-verified` vs `expired-reconnect`**.
Both look identical from the outside — nothing has called them — and treating
them the same is how a dead connector sits unnoticed for weeks while a healthy
unused one nags you.

`expired-refreshing` stops after five consecutive failures instead of retrying
forever. The reference install once spun through 31 refresh attempts on a
credential that could never recover; the ceiling is what ends that.

`critical` is **not** a state. It is a severity some other surfaces use when they
report an `expired-reconnect` connector — a test pins that the state parser
refuses it, so the two vocabularies cannot blur.

## Why there is a "ledger agrees" column

State is **derived** from three sources: the credential row (type, expiry, refresh
failures, last error), the OAuth config, and 30 days of real tool calls. The
previously recorded health word is read for exactly one purpose — to detect a
contradiction — and **never** to decide the state.

When it disagrees with the evidence, the row reads `contradicted` instead of
picking a winner. A health word that quietly overrides the evidence is how a
surface starts lying, and the summary line counts contradictions separately for
the same reason.

## Where it comes from

`connection_health` in `vodou-core.db` — one row per connector, carrying the
state and the reason **as a sentence**. Not a rotating log: a log answers "what
happened", and the question here is "what is true now".

`vodou-core flows` grades the same question continuously (Flow 19): *does every
connector's health word agree with its credential and its calls?*

## Related docs

- [mcp-server-installation.md](mcp-server-installation.md) — adding a connector
- [proactive-loops.md](proactive-loops.md) — how a broken connector reaches you without you looking
