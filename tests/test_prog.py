"""Tests for the prog parser and the prog-hook wrapping rules (stdlib only)."""
import importlib.machinery
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(ROOT, "bin")


def load(name):
    loader = importlib.machinery.SourceFileLoader(name.replace("-", "_"), os.path.join(BIN, name))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


prog = load("prog")


class ParseTests(unittest.TestCase):
    def test_tqdm(self):
        p = prog.parse(" 45%|████▌     | 450/1000 [00:12<00:15, 36.1it/s]")
        self.assertEqual(p["pct"], 45.0)
        self.assertEqual((p["cur"], p["total"]), ("450", "1000"))
        self.assertEqual(p["eta"], "00:15")
        self.assertEqual(p["rate"], "36.1it/s")

    def test_percent_and_rate(self):
        p = prog.parse("Downloading model.bin 70% 12.3MB/s")
        self.assertEqual(p["pct"], 70.0)
        self.assertEqual(p["rate"], "12.3MB/s")

    def test_fraction_with_keyword(self):
        p = prog.parse("Epoch 3/10 loss=0.42")
        self.assertEqual((p["cur"], p["total"]), ("3", "10"))
        self.assertAlmostEqual(p["pct"], 30.0)

    def test_no_progress(self):
        self.assertIsNone(prog.parse("compiling src/main.rs"))
        self.assertIsNone(prog.parse("see docs/2024/01 for details"))

    def test_rejects_over_100_percent(self):
        self.assertIsNone(prog.parse("used 250% cpu"))

    def test_generic_label_fraction(self):
        p = prog.parse("  competitions: 250/6889")
        self.assertEqual((p["cur"], p["total"]), ("250", "6889"))
        self.assertAlmostEqual(p["pct"], 3.6)
        self.assertEqual(prog.parse("scraped matches 12 / 300")["total"], "300")

    def test_generic_fraction_ignores_dates_paths_and_overflows(self):
        self.assertIsNone(prog.parse("saved on 2024/01/05"))
        self.assertIsNone(prog.parse("wrote out/12/34"))
        self.assertIsNone(prog.parse("ratio 9/4 achieved"))
        self.assertIsNone(prog.parse("started at 12:30/45"))


class HookTests(unittest.TestCase):
    def run_hook(self, tool_input, mode=None):
        env = dict(os.environ, HOME=tempfile.mkdtemp())  # no user config file
        env.pop("PROG_WRAP", None)
        if mode:
            env["PROG_WRAP"] = mode
        out = subprocess.run([sys.executable, os.path.join(BIN, "prog-hook")], env=env,
                             input=json.dumps({"tool_name": "Bash", "tool_input": tool_input}),
                             capture_output=True, text=True, check=True).stdout
        return json.loads(out)["hookSpecificOutput"]["updatedInput"] if out else None

    def test_default_leaves_foreground_alone(self):
        self.assertIsNone(self.run_hook({"command": "pip install torch"}))

    def test_default_wraps_background(self):
        r = self.run_hook({"command": "python train.py", "run_in_background": True, "timeout": 5})
        self.assertIn("-c 'python train.py'", r["command"])
        self.assertTrue(r["run_in_background"])
        self.assertEqual(r["timeout"], 5)

    def test_auto_mode_wraps_long_commands(self):
        self.assertIsNotNone(self.run_hook({"command": "pip install torch"}, mode="auto"))
        self.assertIsNone(self.run_hook({"command": "ls -la"}, mode="auto"))

    def test_off(self):
        self.assertIsNone(self.run_hook({"command": "x", "run_in_background": True}, mode="off"))

    def test_quoting_round_trips(self):
        cmd = "echo \"it's\" && printf '%s\\n' a"
        r = self.run_hook({"command": cmd, "run_in_background": True})
        import shlex
        self.assertEqual(shlex.split(r["command"])[-1], cmd)


hook = load("prog-hook")


class RedirectTests(unittest.TestCase):
    def test_finds_stdout_redirects(self):
        f = hook.find_log_files
        self.assertEqual(f("python -u crawl.py > logs/crawl.log 2>&1"), [("logs/crawl.log", False)])
        self.assertEqual(f("job >> run.log"), [("run.log", True)])
        self.assertEqual(f("job &> 'my log.txt'"), [("my log.txt", False)])
        self.assertEqual(f("job 1>out.txt 2>err.txt"), [("out.txt", False)])

    def test_ignores_non_files(self):
        f = hook.find_log_files
        self.assertEqual(f("job 2>&1 | tee x.log"), [])
        self.assertEqual(f("job > /dev/null 2>&1"), [])
        self.assertEqual(f("echo hi >&2"), [])
        self.assertEqual(f("job 2> err.log"), [])

    def test_leading_cd(self):
        self.assertEqual(hook.find_log_files("cd ~/Cricket && python x.py > logs/a.log"),
                         [("~/Cricket/logs/a.log", False)])

    def test_hook_adds_tail(self):
        out = subprocess.run([sys.executable, os.path.join(BIN, "prog-hook")],
                             env=dict(os.environ, HOME=tempfile.mkdtemp()), capture_output=True, text=True,
                             input=json.dumps({"tool_name": "Bash", "tool_input": {
                                 "command": "python crawl.py > logs/c.log 2>&1", "run_in_background": True}})).stdout
        cmd = json.loads(out)["hookSpecificOutput"]["updatedInput"]["command"]
        self.assertIn("--tail logs/c.log -c", cmd)


class FollowTests(unittest.TestCase):
    def test_follow_reads_progress_and_handles_truncation(self):
        import threading
        path = os.path.join(tempfile.mkdtemp(), "run.log")
        with open(path, "w") as fh:
            fh.write("old content from a previous run 999/1000\n")
        seen, stop = [], threading.Event()
        t = threading.Thread(target=prog.follow, args=(path, False, seen.append, stop, 0.05))
        t.start()
        import time
        time.sleep(0.2)
        with open(path, "w") as fh:  # like the shell's `>`: truncate, then write
            fh.write("competitions: 25/100\n")
            fh.flush()
            time.sleep(0.2)
            fh.write("competitions: 50/100\npartial")
        time.sleep(0.2)
        stop.set()
        t.join()
        self.assertIn("competitions: 50/100", seen)
        self.assertEqual(seen[-1], "partial")


class WrapperTests(unittest.TestCase):
    def test_all_output_redirected_to_file_is_not_killed(self):
        # Regression: with nothing holding the pty, prog used to close it and SIGHUP the job.
        d = tempfile.mkdtemp()
        log = os.path.join(d, "run.log")
        env = dict(os.environ, PROGD_URL="http://127.0.0.1:9", HOME=tempfile.mkdtemp(), SHELL="/bin/sh")
        env.pop("PROG_ACTIVE", None)
        script = f"{sys.executable} -c 'import time; time.sleep(0.6); print(\"finished\")' > {log} 2>&1"
        r = subprocess.run([sys.executable, os.path.join(BIN, "prog"), "--tail", log, "-c", script],
                           env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        with open(log) as fh:
            self.assertEqual(fh.read().strip(), "finished")

    def test_exit_code_and_clean_output(self):
        env = dict(os.environ, PROGD_URL="http://127.0.0.1:9", HOME=tempfile.mkdtemp())
        env.pop("PROG_ACTIVE", None)
        script = "import sys\nfor i in (10,50,100): sys.stdout.write(f'\\r{i}%')\nprint()\nprint('bye')\nsys.exit(4)"
        r = subprocess.run([sys.executable, os.path.join(BIN, "prog"), "--", sys.executable, "-c", script],
                           env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 4)
        self.assertEqual(r.stdout, "100%\nbye\n")


class WidgetTests(unittest.TestCase):
    GEN = os.path.join(ROOT, "widget", "generate.sh")

    def gen(self, *args, home=None):
        out = os.path.join(tempfile.mkdtemp(), "w.js")
        env = dict(os.environ, HOME=home or tempfile.mkdtemp())
        r = subprocess.run(["bash", self.GEN, "-o", out, *args], env=env, capture_output=True, text=True)
        return r, (open(out).read() if os.path.exists(out) else None)

    def test_explicit_hosts(self):
        r, js = self.gen("http://a:7777,b:7777", "http://a:7777/")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('const HOSTS = [\n  "http://a:7777",\n  "http://b:7777",\n];', js)
        self.assertNotIn("PROGBAR_HOSTS", js)
        self.assertNotIn("TEMPLATE:", js)

    def test_hosts_from_env_file(self):
        home = tempfile.mkdtemp()
        os.makedirs(os.path.join(home, ".config", "progbar"))
        with open(os.path.join(home, ".config", "progbar", "env"), "w") as f:
            f.write("PROGD_PUBLIC_URL=http://me:7777\nPROGD_PEERS=http://p1:7777,http://p2:7777\n")
        r, js = self.gen(home=home)
        self.assertEqual(r.returncode, 0, r.stderr)
        for h in ("http://me:7777", "http://p1:7777", "http://p2:7777"):
            self.assertIn(f'"{h}"', js)

    def test_primary_goes_first_without_duplicates(self):
        r, js = self.gen("--primary", "http://b:7777", "http://a:7777", "http://b:7777")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('const HOSTS = [\n  "http://b:7777",\n  "http://a:7777",\n];', js)

    def test_rejects_bad_host(self):
        r, js = self.gen('http://a:7777"];alert(1);//')
        self.assertNotEqual(r.returncode, 0)
        self.assertIsNone(js)


if __name__ == "__main__":
    unittest.main()
