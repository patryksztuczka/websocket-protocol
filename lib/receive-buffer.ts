/**
 * Bytes received from the socket that haven't been read yet. Chunks are kept
 * as they arrive and only copied once, when a read spans more than one chunk.
 */
export class ReceiveBuffer {
  private chunks: Buffer[] = [];
  /** Number of bytes waiting to be read. */
  public length = 0;

  public push(chunk: Buffer) {
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  /** Removes and returns the next `n` bytes. Callers check `length` first. */
  public consume(n: number): Buffer {
    this.length -= n;

    const first = this.chunks[0];
    if (first && n <= first.length) {
      if (n === first.length) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      return first.subarray(0, n);
    }

    const result = Buffer.allocUnsafe(n);
    let offset = 0;
    let used = 0;
    while (offset < n) {
      const chunk = this.chunks[used];
      const size = Math.min(chunk.length, n - offset);
      chunk.copy(result, offset, 0, size);
      offset += size;
      if (size < chunk.length) {
        this.chunks[used] = chunk.subarray(size);
      } else {
        used++;
      }
    }
    this.chunks.splice(0, used);
    return result;
  }
}
