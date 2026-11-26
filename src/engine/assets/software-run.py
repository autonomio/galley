"""Measure one isolated command. The collector runs outside the command's sandbox."""
import hashlib
import json
import os
import resource
import signal
import subprocess
import sys
import tempfile
import time


def limits():
    resource.setrlimit(resource.RLIMIT_FSIZE, (16 << 20, 16 << 20))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def process_samples(root):
    output = subprocess.check_output(
        ["/bin/ps", "-ax", "-o", "pid=,ppid=,rss=,time=,comm="],
        text=True,
        errors="replace",
        timeout=1,
    )
    rows = [line.split(None, 4) for line in output.splitlines()]
    by_parent = {}
    for row in rows:
        if len(row) == 5 and row[2].isdigit():
            by_parent.setdefault(int(row[1]), []).append(row)
    descendants = [root]
    for parent in descendants:
        descendants.extend(int(row[0]) for row in by_parent.get(parent, []) if int(row[0]) > 0)
    return [
        {"pid": int(pid), "name": os.path.basename(name)[:80], "rssBytes": int(rss) * 1024, "cpu": cpu}
        for pid, _, rss, cpu, name in rows
        if pid.isdigit() and int(pid) in descendants and rss.isdigit()
    ][:24]


def output_record(stream):
    stream.seek(0)
    digest = hashlib.sha256()
    for block in iter(lambda: stream.read(65536), b""):
        digest.update(block)
    size = stream.tell()
    stream.seek(0)
    excerpt = stream.read(4096).decode("utf-8", "replace")
    return {"bytes": size, "sha256": digest.hexdigest(), "excerpt": excerpt}


def stop_descendants(marker):
    # The inherited marker survives setsid() and reparenting, unlike a process
    # group or a parent-tree snapshot. Rescan to include children forked during teardown.
    deadline = time.monotonic() + 3
    while True:
        output = subprocess.check_output(
            ["/bin/ps", "-Eww" if sys.platform == "darwin" else "eww", "-A", "-o", "pid=,command="],
            text=True, errors="replace", timeout=1,
        )
        pids = [int(line.split()[0]) for line in output.splitlines() if marker in line.split()]
        if not pids:
            return
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if time.monotonic() >= deadline:
            raise OSError("Workload descendants could not be terminated.")
        time.sleep(0.01)


def run(request):
    started = time.monotonic()
    timed_out = False
    samples = []
    run_id = os.urandom(16).hex()
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr, tempfile.TemporaryDirectory() as profiler:
        child = subprocess.Popen(
            request["command"], cwd=request["cwd"], env={**request["env"], "GALLEY_SOFTWARE_RUN": run_id},
            stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
            start_new_session=True, preexec_fn=limits,
        )
        def stop_child():
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

        def timeout_child(_signum, _frame):
            nonlocal timed_out
            timed_out = True
            stop_child()

        signal.signal(signal.SIGALRM, timeout_child)
        signal.setitimer(signal.ITIMER_REAL, request["timeout"])
        interval = 0.05 if request["profile"] else None
        stack_sample = None
        stack_path = os.path.join(profiler, "sample.txt")
        try:
            pid = 0
            if interval is not None:
                while not timed_out:
                    pid, status, usage = os.wait4(child.pid, os.WNOHANG)
                    if pid:
                        break
                    try:
                        processes = process_samples(child.pid)
                        if processes and len(samples) < 1200:
                            samples.append({"seconds": time.monotonic() - started, "processes": processes})
                        if len(samples) >= 3 and processes and stack_sample is None and sys.platform == "darwin" and os.path.isfile("/usr/bin/sample"):
                            # Prefer a workload descendant over its command wrapper.
                            selected = processes[-1]
                            stack_sample = subprocess.Popen(
                                ["/usr/bin/sample", str(selected["pid"]), "1", "10", "-mayDie", "-file", stack_path],
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            )
                    except (OSError, ValueError, subprocess.SubprocessError):
                        break
                    time.sleep(interval)
            if not pid:
                _, status, usage = os.wait4(child.pid, 0)
            elapsed = time.monotonic() - started
            child.returncode = os.waitstatus_to_exitcode(status)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            # Stop descendants left by command wrappers or by a timeout.
            stop_child()
            stop_descendants("GALLEY_SOFTWARE_RUN=" + run_id)
        stacks = None
        if stack_sample is not None:
            try:
                stack_sample.wait(timeout=2)
            except subprocess.TimeoutExpired:
                stack_sample.kill()
                stack_sample.wait()
            if os.path.isfile(stack_path):
                with open(stack_path, encoding="utf-8", errors="replace") as report:
                    excerpt = report.read(49152)
                if "Call graph:" in excerpt:
                    stacks = {"tool": "macOS sample", "intervalMilliseconds": 10, "excerpt": excerpt}
        return {
            "status": "timed-out" if timed_out else "completed" if child.returncode == 0 else "failed",
            "exitCode": child.returncode,
            "wallSeconds": elapsed,
            "userSeconds": usage.ru_utime,
            "systemSeconds": usage.ru_stime,
            "peakRssBytes": usage.ru_maxrss * (1 if sys.platform == "darwin" else 1024),
            "stdout": output_record(stdout),
            "stderr": output_record(stderr),
            **({"samples": samples, "sampleIntervalSeconds": interval, "stacks": stacks} if request["profile"] else {}),
        }


try:
    print(json.dumps(run(json.loads(sys.argv[1]))))
except (OSError, ValueError, subprocess.SubprocessError) as error:
    print(json.dumps({"status": "unavailable", "error": str(error)}))
