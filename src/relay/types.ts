import type { JsonValue } from "../storage/index.ts";

export type RelayMessageKind = "command" | "event" | "status" | "handover";

export interface RelaySender {
  siloId: string;
  siloInstanceId: string;
  keyId: string;
}

export interface RelayEnvelope {
  protocolVersion: "1.0";
  messageId: string;
  streamId: string;
  sequence: number;
  kind: RelayMessageKind;
  sentAt: string;
  sender: RelaySender;
  payload: JsonValue;
  payloadDigest: string;
  correlationId?: string;
  causationId?: string;
  signature: string;
}

export interface RelayPublishResult { accepted: boolean; duplicate: boolean; sequence: number }
export interface RelayReplayRequest { streamId: string; afterSequence?: number; limit?: number }
export interface RelayTransport {
  publish(envelope: RelayEnvelope): Promise<RelayPublishResult>;
  replay(request: RelayReplayRequest): Promise<RelayEnvelope[]>;
}

export type RelayPublicKeyResolver = (sender: RelaySender) => Promise<string | undefined> | string | undefined;
