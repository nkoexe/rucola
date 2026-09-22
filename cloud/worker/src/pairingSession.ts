    session.expires_at <= Date.now() ||
    session.completed_at !== null ||
    session.responder_share === null ||
    session.handoff === null ||
    session.confirmation === null ||
    session.partner_credential_hash === null
  ) {
    return errorResponse("PAIRING_NOT_READY", "Pairing session is not ready", 409);
  }

  const partnerDeviceId = crypto.randomUUID();
  const now = Date.now();

  try {
    await env.DB.prepare(
      "INSERT INTO devices " +
      "(id, relationship_id, participant, credential_hash, created_at, last_seen_at) " +
      "SELECT ?1, ?2, 'PARTNER', ?3, ?4, ?4 " +
      "FROM pairing_sessions ps " +
      "JOIN invitations i ON i.id = ps.invitation_id " +
      "JOIN relationships r ON r.id = ps.relationship_id " +
      "WHERE ps.id = ?5 " +
      "AND ps.relationship_id = ?6 " +
      "AND ps.expires_at > ?4 " +
      "AND ps.completed_at IS NULL " +
      "AND ps.responder_share IS NOT NULL " +
      "AND ps.handoff IS NOT NULL " +
      "AND ps.confirmation IS NOT NULL " +
      "AND ps.partner_credential_hash IS NOT NULL " +
      "AND i.consumed_at IS NULL " +
      "AND i.expires_at > ?4 " +
      "AND r.status = 'PAIRING' " +
      "AND EXISTS (" +
      "  SELECT 1 FROM devices d " +
      "  WHERE d.id = ?7 AND d.relationship_id = ?6 " +
      "    AND d.participant = 'ME' AND d.revoked_at IS NULL" +
      ") " +
      "AND NOT EXISTS (" +
      "  SELECT 1 FROM devices d2 " +
      "  WHERE d2.relationship_id = ?6 AND d2.participant = 'PARTNER' AND d2.revoked_at IS NULL" +
      ")",
    ).bind(
      partnerDeviceId,
      session.relationship_id,
      session.partner_credential_hash,
      now,
      session.id,
      device.relationshipId,
      device.id,
    ).run();
  } catch {
    return errorResponse("PAIRING_CONFLICT", "Pairing session could not be completed", 409);
  }

  const partnerDevice = await env.DB.prepare(
    "SELECT id FROM devices " +
    "WHERE relationship_id = ?1 AND participant = 'PARTNER' " +
    "AND credential_hash = ?2 AND revoked_at IS NULL",
  ).bind(session.relationship_id, session.partner_credential_hash).first<{ id: string }>();

  const completion = await env.DB.prepare(
    "SELECT ps.completed_at, i.consumed_at, r.status " +
    "FROM pairing_sessions ps " +
    "JOIN invitations i ON i.id = ps.invitation_id " +
    "JOIN relationships r ON r.id = ps.relationship_id " +
    "WHERE ps.id = ?1",
  ).bind(session.id).first<{ completed_at: number | null; consumed_at: number | null; status: "PAIRING" | "ACTIVE" | "ENDED" }>();

  if (
    partnerDevice?.id !== partnerDeviceId ||
    completion?.completed_at === null ||
    completion?.consumed_at === null ||
    completion?.status !== "ACTIVE"
  ) {
    return errorResponse("PAIRING_CONFLICT", "Pairing session could not be completed", 409);
  }

  return json({
    completed: true,
    relationshipId: session.relationship_id,
    partnerDeviceId,
  });
}

async function pollSession(
  env: Env,
  body: SessionRequest,
  device: AuthenticatedDevice | null,
): Promise<Response> {
  if (!isSessionId(body.sessionId)) return invalidSession();