const CHUNK_SIZE = 256 * 1024; // 256KB

class FileTransferManager {
  constructor() {
    this.incoming = new Map(); // transferId → state
    this.outgoing = new Map(); // transferId → state
    this.fileKeys = new Map(); // transferId → CryptoKey
  }

  // ── Sender ─────────────────────────────────────────
  async offerFile(file, recipients, send) {
    if (file.size > 1024 * 1024 * 1024)
      throw new Error('File exceeds 1GB limit');

    // Generate AES key for this transfer
    const key    = await SC.crypto.generateFileKey();
    const keyB64 = await SC.crypto.exportFileKey(key);

    // Encrypt key for each recipient
    const encKeys = await Promise.all(
      recipients.map(async r => ({
        userId: r.id,
        encKey: await this._encryptKey(keyB64, r.public_key)
      }))
    );

    // Store key locally — we send it to ourselves too
    // so we can display progress
    const localTid = 'pending_' + Date.now();
    this.fileKeys.set(localTid, { key, file });

    send({
      type: 'file_offer',
      filename:  file.name,
      fileSize:  file.size,
      encKeys
    });

    return localTid;
  }

  async _encryptKey(keyB64, recipientPubB64) {
    // Encrypt the raw AES key string as a message
    const bundle = await SC.crypto.encrypt(
      keyB64, recipientPubB64);
    return JSON.stringify(bundle);
  }

  onTransferAccepted(transferId, receiverId,
                      file, send, onProgress) {
    // Server confirmed recipient accepted — start sending chunks
    const existing = this.fileKeys.get(transferId);
    if (existing?.key) {
      this.fileKeys.set(transferId, {
        key: existing.key,
        file: file ?? existing.file
      });
    }
    this._sendChunks(transferId, receiverId,
                     file, send, onProgress);
  }

  async _sendChunks(transferId, receiverId,
                     file, send, onProgress) {
    const stored = this.fileKeys.get(transferId);
    if (!stored?.key) {
      throw new Error(
        `Missing encryption key for transfer ${transferId}`);
    }
    const key = stored.key;
    file = file ?? stored.file;
    if (!file) {
      throw new Error(
        `Missing file for transfer ${transferId}`);
      }

    const totalChunks =
      Math.ceil(file.size / CHUNK_SIZE);
    let chunkIdx = 0;

    const sendNext = async () => {
      if (chunkIdx >= totalChunks) return;
      const start = chunkIdx * CHUNK_SIZE;
      const end   = Math.min(start + CHUNK_SIZE,
                             file.size);
      const slice = file.slice(start, end);
      const buf   = await slice.arrayBuffer();
      const { data, nonce } =
        await SC.crypto.encryptChunk(
          new Uint8Array(buf), key);
      const isLast = chunkIdx === totalChunks - 1;

      send({
        type: 'file_chunk',
        transferId, receiverId, chunkIdx,
        data, nonce, isLast
      });

      if (onProgress)
        onProgress(end, file.size);

      chunkIdx++;

      // Wait for ack before next chunk
      this.outgoing.set(transferId,
        { waitingForAck: chunkIdx - 1,
          sendNext, key });
    };

    this.outgoing.set(transferId,
      { waitingForAck: -1, sendNext, key });
    await sendNext();
  }

  onChunkAck(transferId, chunkIdx) {
    const state = this.outgoing.get(transferId);
    if (!state) return;
    if (state.waitingForAck === chunkIdx)
      state.sendNext();
  }

  // ── Receiver ───────────────────────────────────────
  async acceptOffer(transferId, encKeyJson,
                    filename, privateKey) {
    // Decrypt AES key
    const bundle = JSON.parse(encKeyJson);
    const keyB64 = await SC.crypto.decrypt(
      bundle.ciphertext, bundle.nonce,
      bundle.ephemeralPub, privateKey);
    const key = await SC.crypto.importFileKey(keyB64);

    this.incoming.set(transferId, {
      filename, chunks: [], key,
      bytesReceived: 0
    });
  }

  async onChunk(transferId, dataB64, nonceB64,
                isLast, send, onProgress,
                onComplete) {
    const state = this.incoming.get(transferId);
    if (!state) return;

    const chunk = await SC.crypto.decryptChunk(
      dataB64, nonceB64, state.key);
    state.chunks.push(chunk);
    state.bytesReceived += chunk.byteLength;

    // Send ACK
    send({
      type: 'file_chunk_ack',
      transferId,
      chunkIdx: state.chunks.length - 1
    });

    if (onProgress)
      onProgress(state.bytesReceived);

    if (isLast) {
      // Assemble and download
      const blob = new Blob(state.chunks);
      this.incoming.delete(transferId);
      if (onComplete) onComplete(blob, state.filename);
    }
  }
}

window.SC = window.SC || {};
window.SC.ft = new FileTransferManager();