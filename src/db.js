// D1 data access helpers for clients, physicians, and collaborations.

export async function createClient(db, { fullName, email, phone }) {
  const res = await db
    .prepare('INSERT INTO clients (full_name, email, phone) VALUES (?, ?, ?) RETURNING *')
    .bind(fullName, email, phone || null)
    .first();
  return res;
}

export async function getClientByEmail(db, email) {
  return db.prepare('SELECT * FROM clients WHERE email = ?').bind(email).first();
}

export async function getClient(db, id) {
  return db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
}

export async function listClients(db) {
  const res = await db.prepare('SELECT * FROM clients ORDER BY created_at DESC').all();
  return res.results;
}

export async function setClientStripeCustomerId(db, id, stripeCustomerId) {
  await db.prepare('UPDATE clients SET stripe_customer_id = ? WHERE id = ?').bind(stripeCustomerId, id).run();
}

export async function createPhysician(db, { fullName, email, phone }) {
  const res = await db
    .prepare('INSERT INTO physicians (full_name, email, phone) VALUES (?, ?, ?) RETURNING *')
    .bind(fullName, email, phone || null)
    .first();
  return res;
}

export async function getPhysicianByEmail(db, email) {
  return db.prepare('SELECT * FROM physicians WHERE email = ?').bind(email).first();
}

export async function getPhysician(db, id) {
  return db.prepare('SELECT * FROM physicians WHERE id = ?').bind(id).first();
}

export async function getPhysicianByStripeAccountId(db, accountId) {
  return db.prepare('SELECT * FROM physicians WHERE stripe_account_id = ?').bind(accountId).first();
}

export async function listPhysicians(db) {
  const res = await db.prepare('SELECT * FROM physicians ORDER BY created_at DESC').all();
  return res.results;
}

export async function setPhysicianStripeAccountId(db, id, stripeAccountId) {
  await db.prepare('UPDATE physicians SET stripe_account_id = ?, onboarding_status = ? WHERE id = ?')
    .bind(stripeAccountId, 'started', id)
    .run();
}

export async function setPhysicianTransfersActive(db, stripeAccountId, active) {
  await db
    .prepare('UPDATE physicians SET transfers_active = ?, onboarding_status = ? WHERE stripe_account_id = ?')
    .bind(active ? 1 : 0, active ? 'complete' : 'started', stripeAccountId)
    .run();
}

export async function createCollaboration(db, {
  clientId, physicianId, totalAmountCents, platformFeeCents, applicationFeePercent, startDate, notes,
}) {
  const res = await db
    .prepare(
      `INSERT INTO collaborations
        (client_id, physician_id, total_amount_cents, platform_fee_cents, application_fee_percent, start_date, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`
    )
    .bind(clientId, physicianId, totalAmountCents, platformFeeCents, applicationFeePercent, startDate, notes || null)
    .first();
  return res;
}

export async function getCollaboration(db, id) {
  return db.prepare('SELECT * FROM collaborations WHERE id = ?').bind(id).first();
}

export async function listCollaborations(db) {
  const res = await db
    .prepare(
      `SELECT c.*, cl.full_name AS client_name, cl.email AS client_email,
              p.full_name AS physician_name, p.email AS physician_email, p.transfers_active
       FROM collaborations c
       JOIN clients cl ON cl.id = c.client_id
       JOIN physicians p ON p.id = c.physician_id
       ORDER BY c.created_at DESC`
    )
    .all();
  return res.results;
}

export async function setCollaborationClientPaymentReady(db, id, ready) {
  await db
    .prepare("UPDATE collaborations SET client_payment_method_ready = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(ready ? 1 : 0, id)
    .run();
}

export async function activateCollaboration(db, id, stripeSubscriptionId) {
  await db
    .prepare("UPDATE collaborations SET status = 'active', stripe_subscription_id = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(stripeSubscriptionId, id)
    .run();
}

export async function setCollaborationStatus(db, id, status) {
  await db
    .prepare("UPDATE collaborations SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(status, id)
    .run();
}

export async function getCollaborationBySubscriptionId(db, subscriptionId) {
  return db.prepare('SELECT * FROM collaborations WHERE stripe_subscription_id = ?').bind(subscriptionId).first();
}
