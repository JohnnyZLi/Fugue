from pathlib import Path
p = Path('work/tests/integration-plan.test.ts')
s = p.read_text()
replacements = [
    (
        'it("keeps a stranded may-have-dispatched fence unresolved without fabricating terminal authority or retry", () => {',
        'it("terminalizes a stranded may-have-dispatched fence as identity_lost without fabricating run authority or retry", () => {'
    ),
    ('expect(result).toEqual({ kind: "unresolved" });', 'expect(result).toEqual({ kind: "identity_lost" });'),
    (
        '// L nor A is trusted input now; attacker-writable Deployment/Status/history cannot fill that gap.',
        '// L nor A is trusted input now; attacker-writable Deployment/Status/history cannot fill that gap.\n    // The revised exact-identity exception therefore terminalizes the request as identity_lost.'
    ),
]
for old, new in replacements:
    count = s.count(old)
    if old.startswith('expect(result)'):
        if count != 2: raise SystemExit(f'expected two unresolved assertions, got {count}')
        s = s.replace(old, new)
    else:
        if count != 1: raise SystemExit(f'expected one match for {old[:40]!r}, got {count}')
        s = s.replace(old, new, 1)
p.write_text(s)
print('revised identity_lost legacy regressions updated')
