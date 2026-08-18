from __future__ import annotations
import pathlib, sys
root = pathlib.Path(sys.argv[1])
p = root / 'tests/state-authority-blockers.test.ts'
s = p.read_text()
def once(old,new,label):
    global s
    c=s.count(old)
    if c != 1: raise SystemExit(f'{label}: {c} matches')
    s=s.replace(old,new,1)
once('''    for (let index = 0; index < 8; index += 1) {
      renameVariables.set(`FUGUE_D3R_${String(index).padStart(2, "0")}`, "reserved-for-fugue-recovery-compaction");
    }
    fillAuthorityCapacity(renameRace, "UNRELATED_FINAL_RACE_");''','''    for (let index = 0; index < 8; index += 1) {
      renameVariables.set(`FUGUE_D3R_${String(index).padStart(2, "0")}`, "reserved-for-fugue-recovery-compaction");
    }
    renameVariables.set("FUGUE_D3GI_00", "reserved-for-fugue-recovery-mutation-guard");
    fillAuthorityCapacity(renameRace, "UNRELATED_FINAL_RACE_");''','rename race guard idle')
once('''      if (raced || ![...github.__authorityVariables.keys()].some((name) => name.startsWith("FUGUE_D3G_"))) return;''','''      if (raced || ![...github.__authorityVariables.keys()].some((name) => name.startsWith("FUGUE_D3GT_"))) return;''','guard race active prefix')
once('''    expect([...github.__authorityVariables.keys()].some((name) => name.startsWith("FUGUE_D3G_"))).toBe(false);
    expect(github.__authorityVariables.get("FUGUE_D3R_00")).toBe("reserved-for-fugue-recovery-compaction");''','''    expect([...github.__authorityVariables.keys()].some((name) => name.startsWith("FUGUE_D3GT_"))).toBe(false);
    expect(github.__authorityVariables.get("FUGUE_D3GI_00")).toBe("reserved-for-fugue-recovery-mutation-guard");
    expect(github.__authorityVariables.get("FUGUE_D3R_00")).toBe("reserved-for-fugue-recovery-compaction");''','guard race restored idle')
p.write_text(s)
print('retargeted mandatory guard race regressions')
