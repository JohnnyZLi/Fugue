import type { QaAttestation, ReviewStart } from "./attestations.js";

export interface ReviewActivity {
  active: ReviewStart | null;
  completed: QaAttestation | null;
  superseded: ReviewStart[];
}

export function resolveReviewActivity(
  sessions: readonly ReviewStart[],
  attestations: readonly QaAttestation[],
): ReviewActivity {
  const completed = attestations.at(-1) ?? null;
  const completedSessionIds = new Set(attestations.map((attestation) => attestation.session_id));
  const uncompleted = sessions.filter((session) => !completedSessionIds.has(session.session_id));

  const candidates = completed
    ? uncompleted.filter((session) => session.created_at > completed.created_at)
    : uncompleted;
  const active = candidates.at(-1) ?? null;

  const superseded = uncompleted.filter((session) => session.session_id !== active?.session_id);

  return {
    active,
    completed,
    superseded,
  };
}
