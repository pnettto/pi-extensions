#!/usr/bin/env python3
"""Connect public resources without replacing private configuration."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--agent-dir', type=Path, default=Path(os.environ.get('PI_CODING_AGENT_DIR', str(Path.home()/'.pi/agent'))))
    p.add_argument('--apply', action='store_true', help='apply changes (default: preview)')
    p.add_argument('--adopt-identical', action='store_true', help='back up identical existing files outside repo, then link them')
    args = p.parse_args()
    agent = args.agent_dir.expanduser().resolve()
    if agent == ROOT or ROOT in agent.parents:
        raise SystemExit('Agent directory must be outside the public checkout.')
    resources = json.loads((ROOT/'resources.json').read_text())
    links = []
    conflicts = []
    backups = []
    for kind, names in resources.items():
        for name in names:
            source = ROOT/name
            if not source.exists() or ROOT not in source.resolve().parents:
                raise SystemExit(f'Invalid public resource: {name}')
            target = agent/Path(name).name if kind == 'files' else agent/kind/Path(name).name
            if target.resolve() == source.resolve():
                continue
            if target.exists() or target.is_symlink():
                if args.adopt_identical and not target.is_symlink() and source.is_file() and target.is_file() and source.read_bytes() == target.read_bytes():
                    backup = agent/'setup-backups'/str(time.time_ns())/target.relative_to(agent)
                    backups.append((target, backup))
                    links.append((source, target))
                else:
                    conflicts.append(str(target))
            else:
                links.append((source, target))
    if conflicts:
        raise SystemExit('Refusing to overwrite existing files. Move/review them yourself first:\n'+'\n'.join(conflicts))
    for target, backup in backups:
        print(f'BACKUP {target} -> {backup}')
    for source, target in links:
        print(f'LINK {target} -> {source}')
    settings_path = agent/'settings.json'
    current = json.loads(settings_path.read_text()) if settings_path.exists() else {}
    defaults = json.loads((ROOT/'defaults/settings.json').read_text())
    def fill(dest, defaults):
        for key, value in defaults.items():
            if key not in dest:
                dest[key] = value
            elif isinstance(value, dict) and isinstance(dest[key], dict):
                fill(dest[key], value)
    before = json.dumps(current, sort_keys=True)
    fill(current, defaults)
    changed = before != json.dumps(current, sort_keys=True)
    print('Settings: add missing safe defaults only' if changed else 'Settings: unchanged')
    old_hooks = subprocess.run(['git', '-C', str(ROOT), 'config', '--local', '--get', 'core.hooksPath'], capture_output=True, text=True).stdout.strip()
    if old_hooks and old_hooks != '.githooks':
        raise SystemExit(f'Refusing to replace existing hooks path: {old_hooks}')
    for hook in ('pre-commit', 'pre-push'):
        existing = ROOT/'.git/hooks'/hook
        if not old_hooks and existing.exists():
            raise SystemExit(f'Refusing to bypass existing hook: {existing}')
    if not args.apply:
        print('Preview only. Run again with --apply. Hooks will require Gitleaks to commit/push.')
        return
    agent.mkdir(parents=True, exist_ok=True)
    for target, backup in backups:
        backup.parent.mkdir(parents=True, exist_ok=True)
        target.rename(backup)
    for source, target in links:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.symlink_to(source, target_is_directory=source.is_dir())
    if changed:
        # Never store live settings or backups in the public checkout.
        temp = agent/'settings.setup.tmp'
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as f:
            f.write(json.dumps(current, indent=2)+'\n')
        temp.replace(settings_path)
    subprocess.run(['git', '-C', str(ROOT), 'config', '--local', 'core.hooksPath', '.githooks'], check=True)
    print('Connected. Run /reload in Pi. Install Gitleaks before committing; see SHARING.md.')

if __name__ == '__main__':
    main()
