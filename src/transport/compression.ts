// src/transport/compression.ts
//
// gzip through the platform's own CompressionStream, which older Safari and
// some webviews do not have.

import { ENCODING_GZIP } from "../constants";

/**
 * The gzipped bytes, or null when this runtime has no CompressionStream.
 *
 * Null means the caller sends the plain body. A `Content-Encoding: gzip` on a
 * body that is not gzip is a 400 the server cannot explain.
 *
 * The buffer is spelled out as non-shared. A bare `Uint8Array` is backed by
 * `ArrayBufferLike`, which covers `SharedArrayBuffer`, and `fetch` takes
 * neither that nor a body typed as possibly holding one.
 *
 * @param text The serialized batch.
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
