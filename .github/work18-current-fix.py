from pathlib import Path
import sys
p = Path(sys.argv[1]) / 'tests/state-authority-blockers.test.ts'
s = p.read_text()
old = '''    const progressBodies = recoveryCheckpointBodies(github).filter((body) => body.includes("fugue-submission-rejection-progress"));
    expect(progressBodies.some((body) => body.includes("version: 2") && body.includes("bloom_b64:"))).toBe(true);
    expect(progressBodies.filter((body) => body.includes("version: 2")).every((body) => body.length < 6000)).toBe(true);
'''
new = '''    const progressBodies = vi.mocked(signProtocolBody).mock.calls
      .map(([, body]) => body)
      .filter((body) => body.includes("fugue-submission-rejection-progress"));
    expect(progressBodies.some((body) => body.includes("version: 2") && body.includes("bloom_b64:"))).toBe(true);
    expect(progressBodies.filter((body) => body.includes("version: 2")).every((body) => body.length < 6000)).toBe(true);
'''
if old not in s: raise SystemExit('missing bounded rejection assertion anchor')
p.write_text(s.replace(old, new))
print('refined bounded rejection regression')
