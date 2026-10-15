import { Buffer } from 'node:buffer';

export const NATIVE_BRIDGE_PROTOCOL_VERSION = 2;
export const NATIVE_BRIDGE_PROTOCOL = 'device-daemon/v2';
// Action results may carry bounded, user-requested screenshot data. Keep the
// frame bounded while allowing ordinary Retina PNG payloads to cross the
// supervised bridge without tearing down the owning run.
export const NATIVE_BRIDGE_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const NATIVE_BRIDGE_MAX_INBOUND_FRAMES = 128;
export const NATIVE_BRIDGE_MAX_OUTBOUND_FRAMES = 128;
export const NATIVE_BRIDGE_MAX_OUTBOUND_FRAMES_PER_RUN = 32;
export const NATIVE_BRIDGE_MAX_RETAINED_RUN_KEYS = 128;

export const NATIVE_BRIDGE_KINDS = [
  'hello',
  'hello_ack',
  'run',
  'cancel',
  'shutdown',
  'ping',
  'stream',
  'complete',
  'failed',
  'capabilities',
  'diagnostic',
  'activity',
] as const;

export type NativeBridgeKind = (typeof NATIVE_BRIDGE_KINDS)[number];

export interface NativeBridgeFrame {
  version: number;
  kind: NativeBridgeKind;
  request_id: string;
  run_id?: number;
  sequence?: number;
  payload: Record<string, unknown>;
}

export class NativeBridgeProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeBridgeProtocolError';
  }
}

export function encodeNativeBridgeFrame(frame: NativeBridgeFrame): Buffer {
  validateFrame(frame);
  const body = Buffer.from(JSON.stringify(frame, sortJsonKeys), 'utf8');
  if (body.byteLength > NATIVE_BRIDGE_MAX_FRAME_BYTES) {
    throw new NativeBridgeProtocolError(
      `native bridge frame exceeds ${NATIVE_BRIDGE_MAX_FRAME_BYTES}-byte limit`,
    );
  }
  const encoded = Buffer.allocUnsafe(4 + body.byteLength);
  encoded.writeUInt32LE(body.byteLength, 0);
  body.copy(encoded, 4);
  return encoded;
}

export function decodeNativeBridgeBody(body: Buffer): NativeBridgeFrame {
  if (body.byteLength > NATIVE_BRIDGE_MAX_FRAME_BYTES) {
    throw new NativeBridgeProtocolError(
      `native bridge frame exceeds ${NATIVE_BRIDGE_MAX_FRAME_BYTES}-byte limit`,
    );
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new NativeBridgeProtocolError('native bridge frame contains invalid UTF-8');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new NativeBridgeProtocolError('native bridge frame contains malformed JSON');
  }
  if (!isRecord(value)) throw new NativeBridgeProtocolError('native bridge frame must be a JSON object');
  const frame = value as Partial<NativeBridgeFrame>;
  validateFrame(frame);
  return frame as NativeBridgeFrame;
}

export class NativeBridgeFrameDecoder {
  private buffered = Buffer.alloc(0);

  append(chunk: Buffer): NativeBridgeFrame[] {
    if (chunk.byteLength === 0) return [];
    const frames: NativeBridgeFrame[] = [];
    let offset = 0;
    while (offset < chunk.byteLength || this.buffered.byteLength > 0) {
      if (this.buffered.byteLength === 0) {
        const remaining = chunk.byteLength - offset;
        if (remaining < 4) {
          this.buffered = Buffer.from(chunk.subarray(offset));
          break;
        }
        const bodyLength = chunk.readUInt32LE(offset);
        validateBodyLength(bodyLength);
        const frameLength = bodyLength + 4;
        if (remaining < frameLength) {
          this.buffered = Buffer.from(chunk.subarray(offset));
          break;
        }
        appendDecodedFrame(
          frames,
          decodeNativeBridgeBody(chunk.subarray(offset + 4, offset + frameLength)),
        );
        offset += frameLength;
        continue;
      }

      if (this.buffered.byteLength < 4) {
        const take = Math.min(4 - this.buffered.byteLength, chunk.byteLength - offset);
        this.buffered = Buffer.concat([this.buffered, chunk.subarray(offset, offset + take)]);
        offset += take;
        if (this.buffered.byteLength < 4) break;
      }

      const bodyLength = this.buffered.readUInt32LE(0);
      validateBodyLength(bodyLength);
      const frameLength = bodyLength + 4;
      const take = Math.min(frameLength - this.buffered.byteLength, chunk.byteLength - offset);
      if (take > 0) {
        this.buffered = Buffer.concat([this.buffered, chunk.subarray(offset, offset + take)]);
        offset += take;
      }
      if (this.buffered.byteLength < frameLength) break;

      appendDecodedFrame(
        frames,
        decodeNativeBridgeBody(this.buffered.subarray(4, frameLength)),
      );
      this.buffered = Buffer.alloc(0);
    }
    return frames;
  }

  finish(): void {
    if (this.buffered.byteLength !== 0) {
      throw new NativeBridgeProtocolError('native bridge EOF in the middle of a frame');
    }
  }

  get bufferedByteLength(): number {
    return this.buffered.byteLength;
  }
}

function validateBodyLength(bodyLength: number): void {
  if (bodyLength > NATIVE_BRIDGE_MAX_FRAME_BYTES) {
    throw new NativeBridgeProtocolError(
      `native bridge frame exceeds ${NATIVE_BRIDGE_MAX_FRAME_BYTES}-byte limit`,
    );
  }
}

function appendDecodedFrame(frames: NativeBridgeFrame[], frame: NativeBridgeFrame): void {
  if (frames.length >= NATIVE_BRIDGE_MAX_INBOUND_FRAMES) {
    throw new NativeBridgeProtocolError('native bridge inbound queue exceeded its bound');
  }
  frames.push(frame);
}

function validateFrame(frame: Partial<NativeBridgeFrame>): void {
  if (frame.version !== NATIVE_BRIDGE_PROTOCOL_VERSION) {
    throw new NativeBridgeProtocolError(
      `unsupported native bridge protocol version '${String(frame.version)}'`,
    );
  }
  if (typeof frame.kind !== 'string' || !NATIVE_BRIDGE_KINDS.includes(frame.kind as NativeBridgeKind)) {
    throw new NativeBridgeProtocolError(`unsupported native bridge frame kind '${String(frame.kind)}'`);
  }
  if (typeof frame.request_id !== 'string' || frame.request_id.length === 0) {
    throw new NativeBridgeProtocolError('native bridge frame is missing request_id');
  }
  if (frame.run_id !== undefined && (!Number.isSafeInteger(frame.run_id) || frame.run_id < 1)) {
    throw new NativeBridgeProtocolError('native bridge run_id must be a positive integer');
  }
  if (frame.sequence !== undefined && (!Number.isSafeInteger(frame.sequence) || frame.sequence < 0)) {
    throw new NativeBridgeProtocolError('native bridge sequence must be a non-negative integer');
  }
  if (!isRecord(frame.payload)) throw new NativeBridgeProtocolError('native bridge payload must be an object');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortJsonKeys(_key: string, value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}
