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
  const completedSessionIds = new Set(attestations.map((attestation) => attestation.session_id));
  const activeSessions = sessions.filter((session) => !completedSessionIds.has(session.session_id));
  const active = activeSessions.at(-1) ?? null;

  return {
    active,
    completed: attestations.at(-1) ?? null,
    superseded: active ? activeSessions.slice(0, -1) : activeSessions,
  };
}
