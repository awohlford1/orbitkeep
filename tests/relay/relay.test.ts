import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import type { SiloCredentialProvider } from "../../src/silo/index.ts";
import { createSignedRelayEnvelope, InMemoryRelayTransport, relayEnvelopeSchema, verifyRelayEnvelope } from "../../src/relay/index.ts";
import { validateJsonSchema } from "../../src/validation/schema/index.ts";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const credentials = { async sign(_keyId: string, payload: Uint8Array) { return sign(null, payload, privateKey); } } as unknown as SiloCredentialProvider;
const sender = { siloId: "silo-origin", siloInstanceId: "sinst-local", keyId: "key-active" };
const envelope = (sequence: number, messageId = `msg-${sequence}`) => createSignedRelayEnvelope({
  messageId, streamId: "stream-mission", sequence, kind: "event", sentAt: `2026-09-15T15:00:0${sequence}.000Z`,
  sender, payload: { event: `event-${sequence}` }, credentials,
});

test("signed Relay envelopes bind identity, payload, ordering metadata, and signature", async () => {
  const signed = await envelope(1);
  assert.equal(verifyRelayEnvelope(signed, publicPem), true);
  assert.equal(validateJsonSchema("relay-envelope", "1.0", relayEnvelopeSchema, signed).valid, true);
  assert.match(signed.payloadDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(verifyRelayEnvelope({ ...signed, sequence: 2 }, publicPem), false);
  assert.throws(() => verifyRelayEnvelope({ ...signed, payload: { event: "tampered" } }, publicPem), /RELAY_PAYLOAD_DIGEST_MISMATCH/);
  assert.throws(() => verifyRelayEnvelope({ ...signed, unexpected: true } as never, publicPem), /unknown properties/);
});

test("in-memory Relay enforces authentication, strict ordering, and idempotency", async () => {
  const relay = new InMemoryRelayTransport((candidate) => candidate.keyId === sender.keyId ? publicPem : undefined);
  const first = await envelope(1);
  assert.deepEqual(await relay.publish(first), { accepted: true, duplicate: false, sequence: 1 });
  assert.deepEqual(await relay.publish(first), { accepted: false, duplicate: true, sequence: 1 });
  await assert.rejects(relay.publish(await envelope(3)), /RELAY_SEQUENCE_OUT_OF_ORDER: expected 2/);
  await assert.rejects(relay.publish({ ...await envelope(2), sender: { ...sender, keyId: "key-untrusted" } }), /RELAY_AUTHENTICATION_FAILED/);
  assert.deepEqual((await relay.replay({ streamId: "stream-mission" })).map((item) => item.sequence), [1]);
});

test("bounded Relay replay reports when a consumer falls outside retention", async () => {
  const relay = new InMemoryRelayTransport(() => publicPem, 2);
  await relay.publish(await envelope(1));
  await relay.publish(await envelope(2));
  await relay.publish(await envelope(3));
  await assert.rejects(relay.replay({ streamId: "stream-mission", afterSequence: 0 }), /RELAY_REPLAY_WINDOW_EXCEEDED/);
  assert.deepEqual((await relay.replay({ streamId: "stream-mission", afterSequence: 1 })).map((item) => item.sequence), [2, 3]);
});
