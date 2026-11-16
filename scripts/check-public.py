#!/usr/bin/env python3
"""Validate index/commit paths, then scan staged content and full Git history."""
import argparse
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
# Already-public former names, accepted ONLY in history, never in the current index.
HISTORICAL_PATHS = {'cpd.ts', 'hawk-footer.ts'}

def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args])

def validate(entries, allowed):
    errors = []
    for mode, name in entries:
        path = PurePosixPath(name)
        if name not in allowed:
            errors.append(f'Not approved for publication: {name}')
        if mode not in ('100644', '100755'):
            errors.append(f'Symlink/submodule forbidden: {name}')
        if path.is_absolute() or '..' in path.parts:
            errors.append(f'Unsafe path: {name}')
    return errors

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--paths-only', action='store_true', help='diagnostic only; NOT a complete publication check')
    p.add_argument('--history', action='store_true', help='also validate every commit reachable from refs')
    args = p.parse_args()
    # Use the staged policy, not an unstaged modification to it.
    allowed = set(json.loads(git('show', ':public-files.json')))
    records = git('ls-files', '--stage', '-z').decode().split('\0')
    entries = []
    errors = []
    for record in filter(None, records):
        meta, name = record.split('\t', 1)
        mode, _, stage = meta.split()
        entries.append((mode, name))
        if stage != '0':
            errors.append(f'Unmerged file: {name}')
    errors += validate(entries, allowed)
    if args.history:
        for commit in git('rev-list', '--all').decode().splitlines():
            historical = []
            for record in filter(None, git('ls-tree', '-r', '-z', commit).decode().split('\0')):
                meta, name = record.split('\t', 1)
                historical.append((meta.split()[0], name))
            errors += [f'{commit[:12]}: {e}' for e in validate(historical, allowed | HISTORICAL_PATHS)]
    if errors:
        raise SystemExit('\n'.join(errors))
    if args.paths_only:
        print('Path checks passed ONLY; secret scanning was not run.')
        return
    if not shutil.which('gitleaks'):
        raise SystemExit('BLOCKED: install Gitleaks (macOS: brew install gitleaks). No scan was performed.')
    with tempfile.TemporaryDirectory(prefix='pi-public-scan-') as tmp:
        # Materialize index blobs, never scan a different worktree version.
        for _, name in entries:
            dest = Path(tmp)/name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(git('show', ':'+name))
        subprocess.run(['gitleaks', 'dir', '--redact', tmp], check=True)
    subprocess.run(['gitleaks', 'git', '--redact', '--log-opts=--all', str(ROOT)], check=True)
    print('Public checks passed. Still review the diff for confidential prose and personal details.')

if __name__ == '__main__':
    main()
