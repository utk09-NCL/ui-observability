// src/transport/compression.ts
//
// Compresses payloads using the native CompressionStream API when available.
// Returns null rather than raw text. A non-gzip body under Content-Encoding: gzip
// is a 400 the server cannot explain.

import { ENCODING_GZIP } from "../constants";

/**
 * Compresses a string into a gzip-encoded byte array using CompressionStream.
 * Returns non-shared ArrayBuffer backed Uint8Array compatible with fetch BodyInit.
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
