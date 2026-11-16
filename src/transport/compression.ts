// src/transport/compression.ts
//
// Compresses payloads with the native CompressionStream API. Returns null when the API is
// absent, never the raw text, because the server answers a non-gzip body that carries a
// "Content-Encoding: gzip" header with a 400 status.

import { ENCODING_GZIP } from "../constants";

/**
 * Compresses a string to gzip bytes with CompressionStream. The result is a
 * Uint8Array on a non-shared ArrayBuffer, which fetch accepts as BodyInit.
 * @param text Raw serialized payload to compress.
 * @returns Promise that resolves to the gzip bytes, or null when there is no CompressionStream.
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
