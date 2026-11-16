import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT/'scripts'/name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

check = load('check-public.py')
setup = load('setup.py')

class PublicTests(unittest.TestCase):
    def test_exact_allowlist(self):
        self.assertEqual(check.validate([('100644', 'safe')], {'safe'}), [])
        self.assertTrue(check.validate([('100644', 'auth.json')], {'safe'}))

    def test_symlinks_and_submodules_rejected(self):
        for mode in ('120000', '160000'):
            self.assertTrue(check.validate([(mode, 'safe')], {'safe'}))

    def test_traversal_rejected(self):
        self.assertTrue(check.validate([('100644', '../safe')], {'../safe'}))

    def test_resources_are_explicit_and_present(self):
        approved = set(json.loads((ROOT/'public-files.json').read_text()))
        for kind, names in json.loads((ROOT/'resources.json').read_text()).items():
            for name in names:
                self.assertTrue((ROOT/name).exists(), name)
                if (ROOT/name).is_file():
                    self.assertIn(name, approved)

    def run_setup(self, directory, *args):
        # Do not change the real checkout's hooks during tests.
        with patch.object(sys, 'argv', ['setup.py', '--agent-dir', str(directory), *args]), patch.object(setup.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, stdout='')):
            setup.main()

    def test_setup_preview_and_apply_and_idempotence(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent = Path(tmp)/'agent'
            agent.mkdir()
            settings = {'hideThinkingBlock': False, 'privateValue': 'local-only'}
            (agent/'settings.json').write_text(json.dumps(settings))
            self.run_setup(agent)
            self.assertFalse((agent/'prompts').exists())
            self.run_setup(agent, '--apply')
            self.assertTrue((agent/'prompts/report.md').is_symlink())
            current = json.loads((agent/'settings.json').read_text())
            self.assertFalse(current['hideThinkingBlock'])
            self.assertEqual(current['privateValue'], 'local-only')
            self.run_setup(agent, '--apply')

    def test_conflict_does_not_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent = Path(tmp)
            (agent/'prompts').mkdir()
            prompt = agent/'prompts/report.md'
            prompt.write_text('private prompt')
            with self.assertRaises(SystemExit):
                self.run_setup(agent, '--apply')
            self.assertEqual(prompt.read_text(), 'private prompt')

    def test_adopt_identical_backed_up(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent = Path(tmp)
            (agent/'prompts').mkdir()
            prompt = agent/'prompts/report.md'
            prompt.write_bytes((ROOT/'prompts/report.md').read_bytes())
            self.run_setup(agent, '--apply', '--adopt-identical')
            self.assertTrue(prompt.is_symlink())
            self.assertEqual(len(list((agent/'setup-backups').rglob('report.md'))), 1)

if __name__ == '__main__':
    unittest.main()
