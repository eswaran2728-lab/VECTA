// Shared fixtures for the signature-bucket authorization model (migration 20261113000001).
// A checkpoint row may only reference a signature path that is bound to its parent and actor AND that exists in Storage, owned by that
// actor and fresh. Verifiers that exercise a successful workflow therefore store the object first (as the trusted superuser/service role,
// standing in for the caller's own authorised upload) and pass the bound path to the RPC.
import crypto from 'node:crypto';

export const rid = () => crypto.randomUUID();

export const sigPaths = {
  partA: (actorId) => `part-a/${actorId}/${rid()}.png`,
  partB: (txId) => `part-b/${txId}-${rid()}.png`,
  receipt: (txId) => `receipt/${txId}/${rid()}.png`,
  vendorA: (actorId) => `vendor-signatures/${actorId}/${rid()}.png`,
  vendorB: (deliveryId) => `vendor-part-b/${deliveryId}/${rid()}.png`,
  vendorC: (deliveryId) => `vendor-part-c/${deliveryId}/${rid()}.png`,
};

/**
 * Stores the object the caller would have uploaded. `exec` must run SQL with enough privilege to write storage.objects
 * (superuser / service_role); the caller's own session is restored by the verifier afterwards.
 */
export async function putSignature(exec, path, ownerId) {
  await exec("insert into storage.objects (bucket_id, name, owner) values ('signatures', $1, $2) on conflict do nothing;", [path, ownerId]);
  return path;
}
