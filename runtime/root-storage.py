"""Bounded root-only storage observation using descriptor-relative, no-link traversal."""
import json
import os
import stat
import sys
import time
from datetime import datetime, timezone


def scan(root, *, max_entries=100000, max_seconds=2):
    started = time.monotonic()
    result = {'processorDataBytes': 0, 'files': 0, 'entries': 0, 'complete': True,
              'symlinksSkipped': 0, 'observedAt': datetime.now(timezone.utc).isoformat(),
              'oldestFileAt': None, 'oldestResultAt': None, 'sealedResults': 0}
    oldest = oldest_result = None
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    def visit(fd, depth=0, components=()):
        nonlocal oldest, oldest_result
        with os.scandir(fd) as entries:
            for entry in entries:
                if result['entries'] >= max_entries or time.monotonic() - started >= max_seconds:
                    result['complete'] = False
                    return
                result['entries'] += 1
                try:
                    metadata = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
                    if stat.S_ISLNK(metadata.st_mode):
                        result['symlinksSkipped'] += 1
                        result['complete'] = False
                    elif stat.S_ISDIR(metadata.st_mode):
                        if depth >= 64:
                            result['complete'] = False
                            continue
                        child = os.open(entry.name, flags, dir_fd=fd)
                        try:
                            visit(child, depth + 1, (*components, entry.name))
                        finally:
                            os.close(child)
                    elif stat.S_ISREG(metadata.st_mode):
                        result['processorDataBytes'] += metadata.st_size
                        result['files'] += 1
                        oldest = min(oldest, metadata.st_mtime) if oldest is not None else metadata.st_mtime
                        if len(components) == 4 and components[:2] == ('.preprocessing', 'jobs') and components[3] == 'sealed' and entry.name == 'manifest.json':
                            result['sealedResults'] += 1
                            oldest_result = min(oldest_result, metadata.st_mtime) if oldest_result is not None else metadata.st_mtime
                    else:
                        result['complete'] = False
                except OSError:
                    result['complete'] = False
                if not result['complete'] and (result['entries'] >= max_entries or time.monotonic() - started >= max_seconds):
                    return
    fd = os.open(root, flags)
    try:
        visit(fd)
        volume = os.fstatvfs(fd)
        result['diskFreeBytes'] = volume.f_bavail * volume.f_frsize
    finally:
        os.close(fd)
    if oldest is not None:
        result['oldestFileAt'] = datetime.fromtimestamp(oldest, timezone.utc).isoformat()
    if oldest_result is not None:
        result['oldestResultAt'] = datetime.fromtimestamp(oldest_result, timezone.utc).isoformat()
    return result


if __name__ == '__main__':
    print(json.dumps(scan(sys.argv[1])))
