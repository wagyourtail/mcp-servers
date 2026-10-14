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
    const { task: done } = await tasks.wait(t.id, 10);
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
    const { task: done } = await tasks.wait(quick.id, 10);
    assert.equal(done.status, "exited");
    assert.ok(Date.now() - t0 < 5000, "should return early");

    const slow = tasks.start({ argv: [NODE, "-e", "setInterval(()=>{},1000)"] });
    const { task: timed } = await tasks.wait(slow.id, 1);
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

test("wait(match) returns early when a log line matches", async () => {
  const { dir, tasks } = setup();
  try {
    const t = tasks.start({
      argv: [NODE, "-e", "setTimeout(()=>console.log('listening on :3000'),300); setInterval(()=>{},1000)"],
    });
    const t0 = Date.now();
    const r = await tasks.wait(t.id, 10, "listening on :\\d+");
    assert.equal(r.matched, true);
    assert.match(r.matchedLine!, /listening on :3000/);
    assert.ok(Date.now() - t0 < 5000, "should return before timeout");
    assert.equal(r.task.status, "running");
    await tasks.kill(t.id, "SIGKILL", 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wait(match) returns matched:false when task exits without matching", async () => {
  const { dir, tasks } = setup();
  try {
    const t = tasks.start({ argv: [NODE, "-e", "console.log('nope')"] });
    const r = await tasks.wait(t.id, 10, "never-appears");
    assert.equal(r.matched, false);
    assert.equal(r.task.status, "exited");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart respawns with the same id, argv and log", async () => {
  const { dir, tasks } = setup();
  try {
    const t = tasks.start({
      argv: [NODE, "-e", "console.log('gen ' + process.env.GEN); setInterval(()=>{},1000)"],
      env: { GEN: "1" },
    });
    await tasks.wait(t.id, 5, "gen 1"); // let gen-1 print before restarting
    const r = await tasks.restart(t.id);
    assert.equal(r.id, t.id);
    assert.equal(r.status, "running");
    assert.equal(r.logPath, t.logPath);
    // NB: the OS may reuse the pid — verify the respawn via the log instead.
    const deadline = Date.now() + 5000;
    let log = tasks.log(t.id);
    while (Date.now() < deadline && (log.tail.match(/gen 1/g) ?? []).length < 2) {
      await new Promise((res) => setTimeout(res, 200));
      log = tasks.log(t.id);
    }
    await tasks.kill(t.id, "SIGKILL", 0);
    log = tasks.log(t.id);
    assert.equal((log.tail.match(/gen 1/g) ?? []).length, 2, "both generations logged");
    assert.match(log.tail, /taskd restart/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
