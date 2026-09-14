"""CRLF-safe exact-anchor patching. Usage: from patchlib import patch, write_new"""
import os
def _load(path):
    raw = open(path, 'rb').read()
    crlf = b'\r\n' in raw
    return raw.decode('utf-8').replace('\r\n', '\n'), crlf
def _save(path, text, crlf):
    open(path, 'wb').write((text.replace('\n', '\r\n') if crlf else text).encode('utf-8'))
def patch(path, pairs):
    s, crlf = _load(path)
    for old, new, *rest in pairs:
        count = rest[0] if rest else 1
        n = s.count(old)
        assert n == count, f"{path}: anchor count {n} != {count}: {old[:80]!r}"
        s = s.replace(old, new)
    _save(path, s, crlf)
    print('patched', path)
def write_new(path, text, crlf=True):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    _save(path, text, crlf)
    print('wrote', path)
