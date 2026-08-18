from __future__ import annotations
import pathlib, subprocess, sys

root=pathlib.Path(sys.argv[1])
p=root/'src/core/reviews.ts'
s=p.read_text()
if 'function reviewIdentityToken(' not in s:
    marker='\nexport async function currentQaAttestations('
    idx=s.index(marker)
    helpers=r'''

function reviewIdentityToken(snapshot: EvaluationSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot.identity), "utf8").digest("hex").slice(0, 16);
}

function reviewAuthorityScope(snapshot: EvaluationSnapshot, role: QaRole): string {
  return `review/${snapshot.identity.prNumber}/${role}/${reviewIdentityToken(snapshot)}`;
}

function reviewAuthorityOrder(value: ReviewStart | QaAttestation): string {
  return `review-v1:${value.kind === "qa" ? "1" : "0"}:${value.created_at}`;
}

async function publishReviewAuthority(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
  value: ReviewStart | QaAttestation,
): Promise<void> {
  await publishDurableProtocolRecord(github, {
    storageSha: snapshot.identity.headSha,
    publisherSha: snapshot.identity.baseSha,
    scope: reviewAuthorityScope(snapshot, value.role),
    unsignedBody: `${serializeAttestation(value)}\n\nFUGUE REVIEW EVIDENCE — CANONICAL`,
    publicationTimestamp: Date.parse(value.created_at),
    authorityOrder: reviewAuthorityOrder(value),
  });
}

async function recoverReviewAuthority(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
  role: QaRole,
): Promise<ReviewStart | QaAttestation | undefined> {
  const recovered = await recoverDurableProtocolRecord(github, {
    storageSha: snapshot.identity.headSha,
    publisherSha: snapshot.identity.baseSha,
    scope: reviewAuthorityScope(snapshot, role),
    issueNumber: snapshot.pr.number,
    parse: (body) => {
      const value = parseAttestation(body);
      return value?.kind === "review_start" || value?.kind === "qa" ? value : null;
    },
    timestamp: (value) => Date.parse(value.created_at),
    order: reviewAuthorityOrder,
    validate: (value) => value.role === role && sameEvaluationIdentity(value.identity, snapshot.identity),
  });
  return recovered.record?.value;
}
'''
    s=s[:idx]+helpers+s[idx:]
old='''    if (!value || !sameEvaluationIdentity(value.identity, snapshot.identity) || !unresolved.includes(value.role)) continue;
    if (value.kind === "review_start") sessions.get(value.role)?.push(value);
    if (value.kind === "qa") attestations.get(value.role)?.push(value);'''
new='''    if (!value || !sameEvaluationIdentity(value.identity, snapshot.identity)) continue;
    if (value.kind !== "review_start" && value.kind !== "qa") continue;
    if (!unresolved.includes(value.role)) continue;
    if (value.kind === "review_start") sessions.get(value.role)?.push(value);
    if (value.kind === "qa") attestations.get(value.role)?.push(value);'''
if old not in s: raise SystemExit('review activity narrowing anchor missing')
s=s.replace(old,new,1)
p.write_text(s)
subprocess.check_call([sys.executable, str(pathlib.Path(__file__).with_name('work18-worker-fix4.py')), str(root)])
print('fixed durable review helpers and guard lifecycle')
