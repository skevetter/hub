import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const testSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
export const fullSuiteLockPath = process.env.HUB_TEST_FULLSUITE_LOCK || "/tmp/hub-fullsuite.lock";
const gracePeriod = 5000;
const exitGraceMs = 200;
const backgroundGraceMs = 2000;

export function watchTestSignals() {
  const controller = new AbortController();
  const interrupt = (signal) => controller.abort(signal);
  for (const signal of testSignals) process.on(signal, interrupt);
  return {
    signal: controller.signal,
    close() {
      for (const signal of testSignals) process.off(signal, interrupt);
    },
  };
}

function ps(args) {
  const result = spawnSync("ps", args, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  if (result.error) throw result.error;
  if (result.status === 1 && !result.stdout) return "";
  if (result.status !== 0) throw new Error("Could not inspect running test processes.");
  return result.stdout.trim();
}

function startTime(pid) {
  return ps(["-p", String(pid), "-o", "lstart="]) || null;
}

function groupAlive(pid) {
  return ps(["-axo", "pgid=,stat="])
    .split("\n")
    .some((line) => {
      const [group, state] = line.trim().split(/\s+/u);
      return Number(group) === pid && state && !state.startsWith("Z");
    });
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    return false;
  }
}

async function waitForGroup(pid, duration, signal) {
  const deadline = performance.now() + duration;
  while (groupAlive(pid)) {
    if (signal?.aborted || performance.now() >= deadline) return false;
    await delay(50);
  }
  return true;
}

export async function stopGroup(pid, signal, graceMs = gracePeriod) {
  if (!groupAlive(pid) || !signalGroup(pid, signal)) return false;
  if (await waitForGroup(pid, graceMs)) return true;
  signalGroup(pid, "SIGKILL");
  if (!(await waitForGroup(pid, gracePeriod))) {
    throw new Error(
      `Test process group ${pid} is still running after SIGKILL. The lock stays in place.`,
    );
  }
  return true;
}

function validOwner(owner, minPid) {
  return (
    Number.isSafeInteger(owner?.pid) &&
    owner.pid >= minPid &&
    Array.isArray(owner.groups) &&
    owner.groups.every(
      (group) =>
        Number.isSafeInteger(group?.pid) && group.pid > 1 && typeof group.startTime === "string",
    )
  );
}

function snapshot(path, minPid = 2) {
  let fd;
  try {
    if (!lstatSync(path).isFile()) return { owner: null };
    fd = openSync(path, "r");
    const { dev, ino } = fstatSync(fd);
    const raw = readFileSync(fd, "utf8").trim();
    const owner = /^\d+$/u.test(raw) ? { pid: Number(raw), groups: [] } : JSON.parse(raw);
    return validOwner(owner, minPid) ? { dev, ino, owner } : { owner: null };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) return { owner: null };
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function publish(path, owner, replace = false) {
  const pending = `${path}.${randomUUID()}.tmp`;
  writeFileSync(pending, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
  try {
    if (replace) renameSync(pending, path);
    else linkSync(pending, path);
  } finally {
    if (!replace || lstatSync(pending, { throwIfNoEntry: false })) unlinkSync(pending);
  }
}

function stale(owner) {
  const observed = startTime(owner.pid);
  return !observed || (owner.startTime && owner.startTime !== observed);
}

async function retireGroup(group) {
  const observed = startTime(group.pid);
  if (observed === group.startTime) {
    await stopGroup(group.pid, "SIGTERM");
  } else if (!observed && !(await waitForGroup(group.pid, gracePeriod * 2))) {
    throw new Error(
      `Unverified workers in test process group ${group.pid} are still running. The lock stays in place.`,
    );
  }
}

function fullSuiteSnapshot(path) {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return null;
  if (!entry.isDirectory()) return { nonDirectory: true };
  return snapshot(join(path, "pid"), 1) ?? { owner: null };
}

export function fullSuiteLockHeld(path = fullSuiteLockPath) {
  const current = fullSuiteSnapshot(path);
  if (!current) return false;
  if (!current.owner || !stale(current.owner)) return true;
  return current.owner.groups.some((group) => groupAlive(group.pid));
}

function fullSuiteBusy(path, current) {
  const message = `The full-suite lock is held at ${path}.`;
  if (current.nonDirectory) {
    return new Error(
      `${message} It is not a directory. Check its owner before removing it by hand.`,
    );
  }
  const detail = current.owner
    ? `Owner PID ${current.owner.pid}.`
    : "There is no pid file with a valid owner.";
  return new Error(`${message} ${detail}`);
}

function createOwner() {
  const owner = {
    pid: process.pid,
    startTime: startTime(process.pid),
    token: randomUUID(),
    groups: [],
  };
  if (!owner.startTime) throw new Error("Could not determine the test runner's start time.");
  return owner;
}

function makeLockDirectory(path) {
  try {
    mkdirSync(path);
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return false;
  }
}

function sameOwner(current, observed) {
  return (
    observed?.owner &&
    observed.dev === current.dev &&
    observed.ino === current.ino &&
    observed.owner.pid === current.owner.pid &&
    observed.owner.token === current.owner.token
  );
}

function canReclaim(path, current) {
  const observed = fullSuiteSnapshot(path);
  if (!observed) return false;
  if (!sameOwner(current, observed)) throw fullSuiteBusy(path, observed);
  return true;
}

function removeLockDirectory(path) {
  for (const name of readdirSync(path)) {
    if (/^pid\.[a-f0-9-]{36}\.tmp$/u.test(name)) unlinkSync(join(path, name));
  }
  unlinkSync(join(path, "pid"));
  rmdirSync(path);
}

async function reclaimFullSuiteLock(path, current, print) {
  // Keep the claim outside the directory so it survives removal of the stale pid file.
  const claim = await takeTestLock(
    `${path}.reclaim-${current.dev}-${current.ino}`,
    "full-suite",
    print,
  );
  try {
    if (!canReclaim(path, current)) return;
    await Promise.all(current.owner.groups.map(retireGroup));
    if (current.owner.groups.some((group) => groupAlive(group.pid))) {
      throw fullSuiteBusy(path, current);
    }
    if (!canReclaim(path, current)) return;
    print(`Reclaiming stale full-suite lock at ${path} from PID ${current.owner.pid}.`);
    if (canReclaim(path, current)) removeLockDirectory(path);
  } finally {
    claim.release();
  }
}

export async function takeFullSuiteLock(path = fullSuiteLockPath, print = console.log) {
  const owner = createOwner();
  while (!makeLockDirectory(path)) {
    const current = fullSuiteSnapshot(path);
    if (!current) continue;
    if (!current.owner || !stale(current.owner)) throw fullSuiteBusy(path, current);
    await reclaimFullSuiteLock(path, current, print);
  }
  const pidPath = join(path, "pid");
  try {
    publish(pidPath, owner, true);
  } catch (error) {
    rmdirSync(path);
    throw error;
  }
  return lockHandle(pidPath, owner, "full-suite", () => removeLockDirectory(path));
}

export async function takeTestLock(path, label, print = console.log) {
  const owner = createOwner();
  const busy = () => new Error(`The ${label} lock is held at ${path}.`);
  while (true) {
    try {
      publish(path, owner);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const current = snapshot(path);
    if (!current) continue;
    if (!current.owner || !stale(current.owner)) throw busy();

    // Serialize reclamation of this inode. A competing owner may publish after unlink.
    const claim = await takeTestLock(`${path}.reclaim-${current.dev}-${current.ino}`, label, print);
    try {
      const observed = snapshot(path);
      if (!observed || observed.dev !== current.dev || observed.ino !== current.ino) continue;
      await Promise.all(observed.owner.groups.map(retireGroup));
      print(`Reclaiming stale ${label} lock at ${path} from PID ${observed.owner.pid}.`);
      unlinkSync(path);
    } finally {
      claim.release();
    }
  }
  return lockHandle(path, owner, label, () => unlinkSync(path));
}

function lockHandle(path, owner, label, remove) {
  return {
    track(pid) {
      const started = startTime(pid);
      if (!started) throw new Error(`Could not identify test process group ${pid}.`);
      owner.groups.push({ pid, startTime: started });
      publish(path, owner, true);
    },
    forget(pid) {
      owner.groups = owner.groups.filter((group) => group.pid !== pid);
      publish(path, owner, true);
    },
    release() {
      if (owner.groups.length)
        throw new Error("Test process groups remain registered. The lock stays in place.");
      if (snapshot(path)?.owner?.token !== owner.token)
        throw new Error(`The ${label} lock changed owners.`);
      remove();
    },
  };
}

// Start the worker only after its group is registered. EOF also handles a killed runner.
const bootstrap = `
  const { spawn } = require("node:child_process");
  let started = false;
  let orphaned = false;
  process.stdin.once("data", () => {
    started = true;
    const child = spawn(process.execPath, process.argv.slice(1), { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", (error) => console.error(error.message));
    child.on("close", (code, signal) => {
      if (orphaned) return;
      process.stdin.destroy();
      if (signal) process.kill(process.pid, signal);
      else process.exitCode = code ?? 1;
    });
  });
  process.stdin.once("end", () => {
    if (!started) return;
    orphaned = true;
    process.on("SIGTERM", () => {});
    process.kill(-process.pid, "SIGTERM");
    setTimeout(() => process.kill(-process.pid, "SIGKILL"), ${gracePeriod});
  });
`;

export async function runWorkerGroup(args, { cwd, env, log, lock, signal, graceMs = gracePeriod }) {
  signal.throwIfAborted();
  const child = spawn(process.execPath, ["-e", bootstrap, "--", ...args], {
    cwd,
    env,
    detached: true,
    stdio: ["pipe", log.fd, log.fd],
  });
  child.stdin.on("error", () => {});
  try {
    const { exitCode, childSignal, error } = await waitForTestGroup(child, {
      signal,
      lock,
      graceMs,
      start: () => child.stdin.write("start\n"),
    });
    return { exitCode, processError: error ? (error.code ?? error.message) : childSignal };
  } finally {
    child.stdin.destroy();
  }
}

export async function waitForTestGroup(child, { signal, lock, graceMs = gracePeriod, start }) {
  const exited = new Promise((settle) => {
    child.once("error", (error) => settle({ exitCode: 1, childSignal: null, error }));
    child.once("exit", (code, childSignal) => settle({ exitCode: code ?? 1, childSignal }));
  });
  const closed = new Promise((settle) => child.once("close", settle));
  if (!child.pid) {
    await closed;
    return exited;
  }
  // Descendants can keep the output pipes open after the leader exits.
  const drainOutput = () => Promise.race([closed, delay(exitGraceMs, undefined, { ref: false })]);
  let stopping;
  const interrupted = Promise.withResolvers();
  const interrupt = () => {
    const reason = testSignals.includes(signal.reason) ? signal.reason : "SIGTERM";
    stopping ??= stopGroup(child.pid, reason, graceMs);
    interrupted.resolve(stopping.then(() => exited));
  };
  signal?.addEventListener("abort", interrupt, { once: true });
  let registered = false;
  let result;
  let stoppedBackground = false;
  let groupExited = false;
  try {
    if (signal?.aborted) interrupt();
    else {
      lock?.track(child.pid);
      registered = Boolean(lock);
      start?.();
    }
    result = await Promise.race([exited, interrupted.promise]);
    if (result.exitCode === 0 && !signal?.aborted) {
      groupExited = await waitForGroup(child.pid, backgroundGraceMs, signal);
    } else {
      await drainOutput();
    }
  } finally {
    try {
      if (stopping) await stopping;
      else if (!groupExited) {
        stopping = stopGroup(child.pid, "SIGTERM", exitGraceMs);
        stoppedBackground = await stopping;
      }
      await drainOutput();
      if (registered) lock.forget(child.pid);
    } finally {
      child.stdout?.destroy();
      child.stderr?.destroy();
      signal?.removeEventListener("abort", interrupt);
    }
  }
  if (result.exitCode === 0 && stoppedBackground) {
    return {
      ...result,
      exitCode: 1,
      error: new Error("Background children were still running after the command exited."),
    };
  }
  return result;
}
