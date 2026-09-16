import { canonicalJson } from "../config/index.ts";
import { validateRelayEnvelope, verifyRelayEnvelope } from "./envelopes.ts";
import type { RelayEnvelope, RelayPublicKeyResolver, RelayPublishResult, RelayReplayRequest, RelayTransport } from "./types.ts";

export class InMemoryRelayTransport implements RelayTransport {
  private readonly streams = new Map<string, RelayEnvelope[]>();
  private readonly resolvePublicKey: RelayPublicKeyResolver;
  private readonly retentionPerStream: number;
  constructor(resolvePublicKey: RelayPublicKeyResolver, retentionPerStream = 1000) {
    if (!Number.isSafeInteger(retentionPerStream) || retentionPerStream < 1) throw new Error("RELAY_RETENTION_INVALID");
    this.resolvePublicKey = resolvePublicKey;
    this.retentionPerStream = retentionPerStream;
  }

  async publish(envelope: RelayEnvelope): Promise<RelayPublishResult> {
    validateRelayEnvelope(envelope);
    const publicKey = await this.resolvePublicKey(envelope.sender);
    if (!publicKey || !verifyRelayEnvelope(envelope, publicKey)) throw new Error("RELAY_AUTHENTICATION_FAILED");
    const messages = this.streams.get(envelope.streamId) ?? [];
    const duplicate = messages.find((candidate) => candidate.messageId === envelope.messageId);
    if (duplicate) {
      if (canonicalJson(duplicate) !== canonicalJson(envelope)) throw new Error("RELAY_MESSAGE_CONFLICT");
      return { accepted: false, duplicate: true, sequence: duplicate.sequence };
    }
    const expected = (messages.at(-1)?.sequence ?? 0) + 1;
    if (envelope.sequence !== expected) throw new Error(`RELAY_SEQUENCE_OUT_OF_ORDER: expected ${expected}`);
    messages.push(structuredClone(envelope));
    if (messages.length > this.retentionPerStream) messages.splice(0, messages.length - this.retentionPerStream);
    this.streams.set(envelope.streamId, messages);
    return { accepted: true, duplicate: false, sequence: envelope.sequence };
  }

  async replay(request: RelayReplayRequest): Promise<RelayEnvelope[]> {
    const messages = this.streams.get(request.streamId) ?? [];
    const after = request.afterSequence ?? 0;
    const limit = request.limit ?? 100;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("RELAY_REPLAY_REQUEST_INVALID");
    const earliest = messages[0]?.sequence;
    if (earliest !== undefined && after < earliest - 1) throw new Error(`RELAY_REPLAY_WINDOW_EXCEEDED: earliest available sequence is ${earliest}`);
    return structuredClone(messages.filter((message) => message.sequence > after).slice(0, limit));
  }
}
