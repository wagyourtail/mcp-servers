import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
    // -1 = unbounded wait; resolves only when the task exits.
    const pending = tasks.wait(slow.id, -1);
    await new Promise((r) => setTimeout(r, 300));
    await tasks.kill(slow.id, "SIGKILL", 0);
    const { task: unbounded } = await pending;
    assert.equal(unbounded.status, "killed");
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

test("custom log path: resolves against cwd, created, survives restart, no prune flag", async () => {
  const { dir, tasks } = setup();
  try {
    const t = tasks.start({
      argv: [NODE, "-e", "console.log('custom-log-out')"],
      cwd: dir,
      log: "logs/dev.log",
    });
    assert.equal(t.logPath, join(dir, "logs", "dev.log"));
    assert.equal(t.customLog, true);
    await tasks.wait(t.id, 10);
    const log = tasks.log(t.id);
    assert.match(log.tail, /custom-log-out/);

    // restart appends to the same caller-chosen file
    const t2 = tasks.start({ argv: [NODE, "-e", "setInterval(()=>{},1000)"], log: t.logPath });
    await tasks.restart(t2.id);
    assert.equal(t2.logPath, t.logPath);
    await tasks.kill(t2.id, "SIGKILL", 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("top TUI renders the registry and quits on q (non-tty)", async () => {
  const { dir, tasks } = setup();
  try {
    tasks.start({ argv: [NODE, "-e", "console.log('top-test-line')" ] });
    const { execFile } = await import("node:child_process");
    const out = await new Promise<string>((resolve, reject) => {
      const p = execFile(
        process.execPath,
        ["src/index.ts", "task_runner_top"],
        { env: { ...process.env, TASKD_STATE_DIR: dir }, cwd: process.cwd() },
        (e, stdout) => (e ? reject(e) : resolve(stdout)),
      );
      setTimeout(() => p.stdin!.write("q"), 800);
    });
    assert.match(out, /tasktop/);
    assert.match(out, /running|exited/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retention caps stopped count and age, keeps custom logs and running tasks", async () => {
  const { dir, tasks } = setup();
  const oldKeep = process.env.TASKD_KEEP, oldDays = process.env.TASKD_KEEP_DAYS;
  try {
    const done = tasks.start({ argv: [NODE, "-e", "console.log('x')"] });
    const running = tasks.start({ argv: [NODE, "-e", "setInterval(()=>{},1000)"] });
    const custom = tasks.start({ argv: [NODE, "-e", "console.log('y')"], cwd: dir, log: "mine.log" });
    await tasks.wait(done.id, 10);
    await tasks.wait(custom.id, 10);

    // count cap: keep at most 1 stopped task → the older one (done) is dropped
    process.env.TASKD_KEEP = "1";
    tasks.start({ argv: [NODE, "-e", "0"] }); // any persist() enforces retention
    assert.equal(tasks.get(done.id), undefined);
    assert.ok(!existsSync(done.logPath), "state-dir log deleted");
    assert.ok(existsSync(join(dir, "mine.log")), "custom log kept");
    assert.equal(tasks.get(running.id)?.status, "running");

    // age limit: backdate the survivor's finishedAt → dropped on next persist
    process.env.TASKD_KEEP = "100";
    process.env.TASKD_KEEP_DAYS = "7";
    const metas = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf-8"));
    for (const m of metas) if (m.id === custom.id) m.finishedAt = "2000-01-01T00:00:00Z";
    writeFileSync(join(dir, "tasks.json"), JSON.stringify(metas));
    const second = new TaskRegistry(dir); // reload picks up old finishedAt → enforceRetention on load's persist
    assert.equal(second.get(custom.id), undefined);
    assert.ok(existsSync(join(dir, "mine.log")), "custom log still kept");

    await tasks.kill(running.id, "SIGKILL", 0);
  } finally {
    if (oldKeep === undefined) delete process.env.TASKD_KEEP; else process.env.TASKD_KEEP = oldKeep;
    if (oldDays === undefined) delete process.env.TASKD_KEEP_DAYS; else process.env.TASKD_KEEP_DAYS = oldDays;
    rmSync(dir, { recursive: true, force: true });
  }
});
