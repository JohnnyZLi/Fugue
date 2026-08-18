from __future__ import annotations
import pathlib, sys
root=pathlib.Path(sys.argv[1])

def once(s,old,new,label):
    n=s.count(old)
    if n!=1: raise SystemExit(f'{label}: expected 1 match, found {n}')
    return s.replace(old,new,1)

p=root/'src/core/state.ts'; s=p.read_text()
s=once(s,
'''      lastPending = error;
      await Promise.resolve();''',
'''      lastPending = error;
      // Yield a full event-loop turn so the protected writer currently holding the transaction slot
      // can finish its post-mutation revision proof and rotate the idle epoch before we retry.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));''','publisher contention yield')
p.write_text(s)

p=root/'src/core/integration-status.ts'; s=p.read_text()
start=s.index('export async function getCurrentIntegrationRecord(')
end=s.index('\nexport async function publishIntegrationRecord(', start)
new='''export async function getCurrentIntegrationRecord(
  github: FugueGitHub,
  identity: IntegrationRequest["identity"],
): Promise<IntegrationRecord | undefined> {
  let lastPending: DurableProtocolRecoveryPendingError | undefined;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    try {
      const recovered = await recoverDurableProtocolRecord(github, {
        storageSha: identity.headSha,
        publisherSha: identity.baseSha,
        scope: integrationScope(identity.prNumber),
        issueNumber: identity.prNumber,
        parse: parseIntegrationRecord,
        timestamp: (value) => Date.parse(value.created_at),
        order: (value) => value.created_at,
        validate: (value) => sameEvaluationIdentity(value.identity, identity),
      });
      if (recovered.record) {
        await replaceIntegrationLocator(github, recovered.record.value);
        return recovered.record.value;
      }
      if (recovered.exhausted) return undefined;
      throw new DurableProtocolRecoveryPendingError(
        `PR #${identity.prNumber} Integration authority recovery is progressing through bounded status history.`,
      );
    } catch (error) {
      if (!(error instanceof DurableProtocolRecoveryPendingError)) throw error;
      lastPending = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastPending ?? new DurableProtocolRecoveryPendingError("Protected Integration authority remained busy.");
}
'''
s=s[:start]+new+s[end:]
p.write_text(s)
print('added contention convergence without weakening raw d3 read epochs')
