from pathlib import Path
import sys
root=Path(sys.argv[1])
p=root/'tests/integration-plan.test.ts'; s=p.read_text()
old='''  it("does not use filtered workflow-run search as Integration binding authority", async () => {
    const source = await readFile("src/core/integration-status.ts", "utf8");
    expect(source).not.toContain("listWorkflowRuns");
    expect(source).toContain("getIntegrationRunStartEvidence");
  });'''
new='''  it("uses only unfiltered workflow-run enumeration for lost Integration binding recovery", async () => {
    const source = await readFile("src/core/integration-status.ts", "utf8");
    expect(source).toContain("listWorkflowRuns");
    expect(source).toContain('workflow_id: "fugue-integration.yml"');
    expect(source).toContain("per_page: 100");
    expect(source).not.toMatch(/listWorkflowRuns\\(\\{[\\s\\S]{0,500}?(?:actor|branch|created|event|head_sha|status):/);
    expect(source).toContain("getIntegrationRunStartEvidence");
  });'''
if s.count(old)!=1: raise SystemExit(f'integration search regression: expected 1 match, found {s.count(old)}')
p.write_text(s.replace(old,new,1))
print('updated no-filter Integration search regression')
