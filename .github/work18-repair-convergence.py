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
old='''export async function getCurrentIntegrationRecord(
  github: FugueGitHub,
  identity: EvaluationIdentity,
): Promise<IntegrationRecord | undefined> {
  const recovered = await recoverDurableProtocolRecord(github, {
    storageSha: identity.baseSha,
    publisherSha: identity.baseSha,
    scope: integrationScope(identity.prNumber),
    issueNumber: identity.prNumber,
    parse: parseIntegrationRecord,
    timestamp: (record) => Date.parse(record.created_at),
    order: integrationAuthorityOrder,
    validate: (record) => sameEvaluationIdentity(record.identity, identity),
  });
  return recovered.record?.value;
}'''
new='''export async function getCurrentIntegrationRecord(
  github: FugueGitHub,
  identity: EvaluationIdentity,
): Promise<IntegrationRecord | undefined> {
  let lastPending: DurableProtocolRecoveryPendingError | undefined;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    try {
      const recovered = await recoverDurableProtocolRecord(github, {
        storageSha: identity.baseSha,
        publisherSha: identity.baseSha,
        scope: integrationScope(identity.prNumber),
        issueNumber: identity.prNumber,
        parse: parseIntegrationRecord,
        timestamp: (record) => Date.parse(record.created_at),
        order: integrationAuthorityOrder,
        validate: (record) => sameEvaluationIdentity(record.identity, identity),
      });
      return recovered.record?.value;
    } catch (error) {
      if (!(error instanceof DurableProtocolRecoveryPendingError)) throw error;
      lastPending = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastPending ?? new DurableProtocolRecoveryPendingError("Protected Integration authority remained busy.");
}'''
s=once(s,old,new,'stable integration durable read')
# ensure the error class is imported from state in this file's existing state import.
if 'DurableProtocolRecoveryPendingError' not in s.split('\n',40)[0:40]:
    pass
# Direct string injection into the state import list.
s=once(s,
'''  deleteFugueAuthorityVariable,
  getFugueAuthorityVariable,''',
'''  deleteFugueAuthorityVariable,
  DurableProtocolRecoveryPendingError,
  getFugueAuthorityVariable,''','pending import')
p.write_text(s)
print('added contention convergence without weakening read epochs')
