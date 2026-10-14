import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskRegistry } from "../src/task-runner/tasks.ts";

function setup(): { dir: string; tasks: TaskRegistry } {
  const dir = mkdtempSync(join(tmpdir(), "taskd-test-"));
  return { dir, tasks: new TaskRegistry(dir) };
}

const NODE = process.execPath;

test("start runs detached, captures stdout/stderr to log", async () => {
  const { dir, tasks } = setup();
  try {
    const t = tasks.start({ argv: [NODE, "-e", 'console.log("hello"); console.error("oops")'] });
    assert.equal(t.status, "running");
    assert.ok(t.pid > 0);
    assert.ok(t.logPath.endsWith(`${t.id}.log`));
    const done = await tasks.wait(t.id, 10);
    assert.equal(done.status, "exited");
    assert.equal(done.exitCode, 0);
    const log = tasks.log(t.id);
    assert.match(log.tail, /hello/);
    assert.match(log.tail, /oops/);
    assert.ok(existsSync(log.path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kill terminates a sleeper and its process group", async () => {
  const { dir, tasks } = setup();
  try {
    const t = tasks.start({ argv: [NODE, "-e", "setInterval(()=>{},1000)"] });
    const killed = await tasks.kill(t.id);
    assert.equal(killed.status, "killed");
    assert.equal(killed.exitSignal, "SIGTERM");
    assert.ok(killed.finishedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wait returns early on exit, times out on a sleeper", async () => {
  const { dir, tasks } = setup();
  try {
    const quick = tasks.start({ argv: [NODE, "-e", "setTimeout(()=>{},300)"] });
    const t0 = Date.now();
    const done = await tasks.wait(quick.id, 10);
    assert.equal(done.status, "exited");
    assert.ok(Date.now() - t0 < 5000, "should return early");

    const slow = tasks.start({ argv: [NODE, "-e", "setInterval(()=>{},1000)"] });
    const timed = await tasks.wait(slow.id, 1);
    assert.equal(timed.status, "running");
    await tasks.kill(slow.id, "SIGKILL", 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fresh registry reattaches to a running task by pid", async () => {
  const { dir } = setup();
  try {
    const first = new TaskRegistry(dir);
    const t = first.start({ argv: [NODE, "-e", "setInterval(()=>{},1000)"] });
    // Simulate a server restart: new registry over the same state dir.
    const second = new TaskRegistry(dir);
    const reattached = second.get(t.id)!;
    assert.equal(reattached.status, "running");
    assert.equal(reattached.pid, t.pid);
    // kill works on reattached tasks (pid-group signal, no proc handle needed).
    const killed = await second.kill(t.id, "SIGKILL", 0);
    await second.wait(t.id, 5);
    assert.notEqual(second.get(t.id)!.status, "running");
    assert.ok(killed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a dead task is marked lost on reload", async () => {
  const { dir } = setup();
  try {
    const first = new TaskRegistry(dir);
    const t = first.start({ argv: [NODE, "-e", "setInterval(()=>{},1000)"] });
    await first.kill(t.id, "SIGKILL", 0);
    await first.wait(t.id, 5);
    // Rewrite the registry as if the server died mid-run (status running, pid dead).
    const regPath = join(dir, "tasks.json");
    const metas = JSON.parse((await import("node:fs")).readFileSync(regPath, "utf-8"));
    metas[0].status = "running";
    (await import("node:fs")).writeFileSync(regPath, JSON.stringify(metas));
    const second = new TaskRegistry(dir);
    assert.equal(second.get(t.id)!.status, "lost");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stdin writes reach the child when enabled", async () => {
  const { dir, tasks } = setup();
  try {
    const t = tasks.start({
      argv: [NODE, "-e", "process.stdin.on('data', d => console.log('GOT:' + d.toString().trim()))"],
      stdin: true,
    });
    tasks.stdin(t.id, "ping\n");
    await new Promise((r) => setTimeout(r, 500));
    assert.match(tasks.log(t.id).tail, /GOT:ping/);
    await tasks.kill(t.id, "SIGKILL", 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stdin rejected when not enabled", async () => {
  const { dir, tasks } = setup();
  try {
    const t = tasks.start({ argv: [NODE, "-e", "setInterval(()=>{},1000)"] });
    assert.throws(() => tasks.stdin(t.id, "x"), /stdin/);
    await tasks.kill(t.id, "SIGKILL", 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
