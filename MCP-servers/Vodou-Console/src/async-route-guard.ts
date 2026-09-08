/**
 * CO-2 — make a rejected async route handler answer, instead of hanging.
 *
 * Express 4 does not await route handlers. A handler declared `async` that
 * throws returns a rejected promise nobody looks at: the rejection escapes to
 * `process.on('unhandledRejection')` and **the caller is never answered**. The
 * socket stays open until the client's own timeout fires.
 *
 * GW-11 added the terminal error middleware, and its comment says this is what
 * it fixes — but that middleware only runs when something calls `next(err)`.
 * For a bare `throw` inside an `async` handler, nothing does. Its own test
 * suite covers "async reject via next(e)", i.e. the case that was already
 * forwarded by hand. So the half that catches the rejection was still missing.
 *
 * What it cost, measured: a scheduled `skill_run` whose skill could not be
 * prepared burned the scheduler's ENTIRE client budget — 1800s, a valve slot
 * held for half an hour — and was then filed `unknown`. A deterministic,
 * instantly-knowable failure recorded as ignorance.
 *
 * This walks the router stack ONCE, after every route is mounted, and wraps
 * each handler so a rejection becomes `next(err)` — which is exactly the input
 * GW-11's middleware was built for. The two halves together are what "a route
 * fault answers 500 and the server stays up" actually requires.
 *
 * Why the whole stack rather than the handlers we know about: there are 154
 * async handlers across index.ts and twenty-odd routers, and none of them was
 * protected. Fixing the one lane that was measured would leave the other 153,
 * which is the shape of bug this codebase keeps re-finding — a guard in one
 * producer is not a rule.
 */

type AnyFn = ((...args: any[]) => any) & { stack?: unknown[] };
interface Layer { handle?: AnyFn; route?: { stack?: Layer[] } }

/** Already-wrapped handlers, so a second call cannot double-wrap. */
const WRAPPED = new WeakSet<AnyFn>();

function wrapHandler(fn: AnyFn): AnyFn {
  // Error middleware is identified by ARITY. Express reads `handle.length` to
  // decide whether a layer is `(err, req, res, next)`, so wrapping one — the
  // wrapper has three parameters — would silently demote it to an ordinary
  // handler that never runs on an error. Leave them alone.
  if (fn.length >= 4) return fn;

  const wrapped = function (this: unknown, req: any, res: any, next: any) {
    let out: any;
    try {
      out = fn.call(this, req, res, next);
    } catch (e) {
      // A synchronous throw already reaches the error middleware on its own,
      // but only because Express wraps the call in a try. Forwarding here too
      // keeps one path for both, and calling next twice is not possible: this
      // arm returns immediately.
      next(e);
      return;
    }
    if (out && typeof out.then === 'function') {
      // `next(err)` and nothing else. Answering here would duplicate GW-11 and
      // the two would drift; that middleware owns what a route fault looks
      // like to a caller, including the headers-already-sent case.
      Promise.resolve(out).catch(next);
    }
    return out;
  } as AnyFn;

  WRAPPED.add(wrapped);
  return wrapped;
}

function walk(stack: Layer[] | undefined, seen: Set<unknown>, count: { n: number }): void {
  if (!Array.isArray(stack)) return;
  for (const layer of stack) {
    if (!layer || typeof layer !== 'object') continue;

    // A route layer's own `handle` is Route.dispatch — sync, and it delegates
    // to the handlers in route.stack. Wrapping dispatch would catch nothing.
    if (layer.route?.stack) { walk(layer.route.stack, seen, count); continue; }

    const fn = layer.handle;
    if (typeof fn !== 'function') continue;

    // A mounted Router or sub-app is a function WITH a stack. Replacing it with
    // a plain wrapper would strip `.stack`, `.use` and everything else hanging
    // off it — recurse into it instead.
    if (Array.isArray(fn.stack)) {
      if (seen.has(fn)) continue;          // a router mounted at two paths
      seen.add(fn);
      walk(fn.stack as Layer[], seen, count);
      continue;
    }

    if (WRAPPED.has(fn)) continue;
    const wrapped = wrapHandler(fn);
    if (wrapped === fn) continue;          // error middleware, left as it was
    layer.handle = wrapped;
    count.n += 1;
  }
}

/**
 * Wrap every handler currently mounted on `app`.
 *
 * Call AFTER the last route and BEFORE the terminal error middleware — a
 * handler registered later is not covered, and the error middleware is skipped
 * by arity anyway. Returns how many handlers were wrapped, which is worth
 * logging: a sudden drop means routes moved after this call.
 */
export function catchAsyncRouteFaults(app: any): number {
  // Express 4 keeps the router at `_router` (lazily created on first mount);
  // Express 5 renamed it to `router`. Read both so an upgrade does not silently
  // turn this into a no-op that still returns a plausible-looking 0.
  const router = app?._router ?? app?.router;
  const count = { n: 0 };
  walk(router?.stack, new Set(), count);
  return count.n;
}
