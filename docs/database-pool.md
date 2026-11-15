# Database pool

Hub keeps a pool of connections to PostgreSQL. When many runs start at once, each one asks the pool
for connections. If none is free within the wait time, the request fails with
`timeout exceeded when trying to connect`. Use these settings to give a busy Hub more room.

They apply when `DATABASE_URL` is set. The embedded database ignores them.

## Settings

Set these on the Hub process:

| Variable                                | Meaning                                                             | Range         | Default |
| --------------------------------------- | ------------------------------------------------------------------- | ------------- | ------- |
| `PASEO_HUB_DATABASE_POOL_MAX`           | Most connections the pool opens.                                    | 1 to 100      | `10`    |
| `PASEO_HUB_DATABASE_ACQUIRE_TIMEOUT_MS` | Milliseconds a request waits for a free connection before it fails. | 1000 to 60000 | `3000`  |

Leave a variable unset to keep the default. The defaults are the values Hub used before these
settings existed.

A value that is not a whole number, or is outside the range, stops startup with a message that
names the variable, the range and the value, for example:

```
PASEO_HUB_DATABASE_POOL_MAX must be a whole number from 1 to 100, got "ten".
```

The acquire timeout only covers the wait for a connection. Each query still has its own limit of
3 seconds, and that limit is not configurable.

## Choosing values

- Raise `PASEO_HUB_DATABASE_POOL_MAX` first. A burst of runs, such as a replay of old
  notifications, needs more connections than 10.
- Check the PostgreSQL `max_connections` limit before you raise it. Every Hub process opens its own
  pool, so the total is the pool size times the number of processes.
- Raise `PASEO_HUB_DATABASE_ACQUIRE_TIMEOUT_MS` when requests queue for a short time and then
  succeed on the next attempt. A longer wait does not help when the pool is stuck at its maximum.

## Retries

A failed connection request does not fail a run. Hub retries the workflow wakeup and the agent
launch when the error is one of these:

- The pool had no free connection in time.
- The connection was reset or terminated.
- PostgreSQL reported a serialization failure or a deadlock.

Hub waits a random time before each retry. The longest possible wait starts at 250 ms and doubles
each time, up to 5 seconds. It makes at most 6 attempts. When the attempts run out, Hub reports
the failure once, with the attempt count, for example
`timeout exceeded when trying to connect (gave up after 6 attempts)`.

Any other error is not retried and fails as before.

Hub does not retry once it has started to send the prompt to the agent, because it cannot tell
whether the daemon received it. A database error after that point fails the run as before.
