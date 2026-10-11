// src/transport/compression.ts
//
// This module compresses payloads with the native CompressionStream API. It returns null
// when the API is absent. It does not return raw text. The server rejects a non-gzip body
// that has a "Content-Encoding: gzip" header with a 400 status.

import { ENCODING_GZIP } from "../constants";

/**
 * Compresses a string to gzip bytes with CompressionStream. The result is a
 * Uint8Array on a non-shared ArrayBuffer. fetch accepts this result as BodyInit.
 * @param text Raw serialized payload to compress.
 * @returns Promise resolving to compressed Uint8Array, or null if CompressionStream is unsupported.
 */
export async function gzip(text: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const CS = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (CS === undefined) {
    return null;
  }

  const stream = new Blob([text]).stream().pipeThrough(new CS(ENCODING_GZIP));
  const buffer = await new Response(stream).arrayBuffer();

  return new Uint8Array(buffer);
}
