// ── SecureChat Voice Manager ───────────────────────────────
// WebRTC mesh — one RTCPeerConnection per peer pair.
// Audio playback uses HTMLAudioElement only.
// VU meter uses a separate AnalyserNode per stream.
// The two paths never share an AudioContext destination,
// which was the root cause of audio cutting out when
// the local mic was activated.

class VoiceManager {
  constructor() {
    this.vchatId    = null;
    this.peers      = new Map(); // userId → RTCPeerConnection
    this.stream     = null;      // local mic stream
    this.muted      = false;
    this.deafened   = false;
    this.myUserId   = null;
    this.myUsername = null;
    this.send       = null;
    this.onVU       = null;
    this.vuInterval = null;

    // Per-speaker state
    // userId → { username, audioEl, analyser,
    //            audioCtx, muted, deafened }
    this.speakers = new Map();

    // Keep audio elements alive (prevent GC)
    this._audioEls = new Set();
  }

  // ── Join ──────────────────────────────────────────────
  async join(vchatId, myUserId, myUsername, send) {
    this.vchatId    = vchatId;
    this.myUserId   = myUserId;
    this.myUsername = myUsername;
    this.send       = send;

    try {
      this.stream = await navigator.mediaDevices
        .getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl:  true
          },
          video: false
        });
    } catch (err) {
      console.error('[voice] Mic error:', err);
      throw err;
    }

    // Local VU — own AudioContext just for analysis
    const localCtx = new AudioContext();
    await localCtx.resume();
    const localSrc = localCtx
      .createMediaStreamSource(this.stream);
    const localAn  = localCtx.createAnalyser();
    localAn.fftSize = 256;
    localSrc.connect(localAn);
    // Do NOT connect to localCtx.destination
    // (we don't want to hear ourselves)

    this.speakers.set(myUserId, {
      username: myUsername,
      audioEl:  null,   // no playback for self
      analyser: localAn,
      audioCtx: localCtx,
      muted:    false,
      deafened: false
    });

    this.vuInterval = setInterval(
      () => this._pollVU(), 100);
  }

  // ── Create peer connection ────────────────────────────
  _createPC(userId) {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });

    // Add local tracks
    if (this.stream) {
      this.stream.getTracks().forEach(track =>
        pc.addTrack(track, this.stream));
    }

    // ICE candidates
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      this.send({
        type:    'vchat_signal',
        toId:    userId,
        vchatId: this.vchatId,
        signal:  { ice: ev.candidate.toJSON() }
      });
    };

    pc.onconnectionstatechange = () => {
      console.log(`[voice] ${userId}:`,
        pc.connectionState);
    };

    // ── Remote track arrives ──────────────────────────
    pc.ontrack = (ev) => {
      // Guard: ignore if we already set up audio
      // for this peer from a previous ontrack call
      const existing = this.speakers.get(userId);
      if (existing?.audioEl) return;

      console.log('[voice] Track from', userId);

      const remoteStream =
        ev.streams[0] ?? new MediaStream([ev.track]);

      // ── Playback via Audio element ─────────────────
      // This is the ONLY audio output path.
      // AudioContext is NOT used for output — only
      // for VU meter analysis below.
      const audio = new Audio();
      audio.srcObject = remoteStream;
      audio.autoplay  = true;
      audio.muted     = this.deafened;
      this._audioEls.add(audio);

      audio.play().catch(e =>
        console.warn('[voice] play():', e));

      // ── VU analysis via separate AudioContext ──────
      // Completely independent from playback —
      // no shared destination, no routing conflicts.
      const vuCtx = new AudioContext();
      vuCtx.resume().catch(() => {});

      const vuSrc = vuCtx
        .createMediaStreamSource(remoteStream);
      const vuAn  = vuCtx.createAnalyser();
      vuAn.fftSize = 256;
      vuSrc.connect(vuAn);
      // Do NOT connect vuSrc to vuCtx.destination —
      // audio plays via the Audio element above

      const spk = this.speakers.get(userId);
      this.speakers.set(userId, {
        username: spk?.username ?? String(userId),
        audioEl:  audio,
        analyser: vuAn,
        audioCtx: vuCtx,
        muted:    spk?.muted    ?? false,
        deafened: spk?.deafened ?? false
      });
    };

    this.peers.set(userId, pc);
    return pc;
  }

  // ── Connect to peer ───────────────────────────────────
  async connectToPeer(userId, username, isInitiator) {
    if (this.peers.has(userId)) return;

    console.log('[voice] Connect to', userId,
      isInitiator ? '(init)' : '(answer)');

    // Pre-populate speaker entry with username
    if (!this.speakers.has(userId)) {
      this.speakers.set(userId, {
        username,
        audioEl:  null,
        analyser: null,
        audioCtx: null,
        muted:    false,
        deafened: false
      });
    } else {
      // Update username in case it was missing
      const spk = this.speakers.get(userId);
      spk.username = username;
    }

    const pc = this._createPC(userId);

    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.send({
        type:    'vchat_signal',
        toId:    userId,
        vchatId: this.vchatId,
        signal:  { sdp: pc.localDescription }
      });
    }
  }

  // ── Handle incoming signal ────────────────────────────
  async handleSignal(fromId, fromUser, signal) {
    if (!this.peers.has(fromId)) {
      console.log('[voice] Signal from new peer',
        fromId);
      if (!this.speakers.has(fromId)) {
        this.speakers.set(fromId, {
          username: fromUser,
          audioEl:  null,
          analyser: null,
          audioCtx: null,
          muted:    false,
          deafened: false
        });
      }
      this._createPC(fromId);
    }

    const pc = this.peers.get(fromId);
    if (!pc) return;

    try {
      if (signal.sdp) {
        const sdp = new RTCSessionDescription(
          signal.sdp);
        await pc.setRemoteDescription(sdp);

        if (signal.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.send({
            type:    'vchat_signal',
            toId:    fromId,
            vchatId: this.vchatId,
            signal:  { sdp: pc.localDescription }
          });
        }
      } else if (signal.ice) {
        await pc.addIceCandidate(
          new RTCIceCandidate(signal.ice));
      }
    } catch (err) {
      console.error('[voice] Signal error:', err);
    }
  }

  // ── Disconnect a peer ─────────────────────────────────
  disconnectPeer(userId) {
    const pc = this.peers.get(userId);
    if (pc) {
      pc.close();
      this.peers.delete(userId);
    }

    const spk = this.speakers.get(userId);
    if (spk) {
      // Stop audio playback
      if (spk.audioEl) {
        spk.audioEl.srcObject = null;
        spk.audioEl.pause();
        this._audioEls.delete(spk.audioEl);
      }
      // Close VU AudioContext
      if (spk.audioCtx &&
          spk.audioCtx.state !== 'closed') {
        spk.audioCtx.close();
      }
      this.speakers.delete(userId);
    }
  }

  // ── Leave call ────────────────────────────────────────
  leave() {
    clearInterval(this.vuInterval);
    this.vuInterval = null;

    // Close all peer connections
    this.peers.forEach(pc => pc.close());
    this.peers.clear();

    // Stop all audio elements and close AudioContexts
    this.speakers.forEach((spk) => {
      if (spk.audioEl) {
        spk.audioEl.srcObject = null;
        spk.audioEl.pause();
      }
      if (spk.audioCtx &&
          spk.audioCtx.state !== 'closed')
        spk.audioCtx.close();
    });
    this.speakers.clear();
    this._audioEls.clear();

    // Stop local mic
    if (this.stream)
      this.stream.getTracks()
        .forEach(t => t.stop());

    this.stream     = null;
    this.vchatId    = null;
    this.myUserId   = null;
    this.muted      = false;
    this.deafened   = false;
  }

  // ── Mute / deafen ─────────────────────────────────────
  setMuted(muted) {
    this.muted = muted;
    if (this.stream)
      this.stream.getAudioTracks()
        .forEach(t => t.enabled = !muted);
    const spk = this.speakers.get(this.myUserId);
    if (spk) spk.muted = muted;
  }

  setDeafened(deafened) {
    this.deafened = deafened;
    const spk = this.speakers.get(this.myUserId);
    if (spk) spk.deafened = deafened;

    // Mute/unmute all remote audio elements
    // This is the clean way — no AudioContext
    // routing to undo
    this._audioEls.forEach(audio => {
      audio.muted = deafened;
    });
  }

  // ── Remote peer state update ──────────────────────────
  updatePeerState(userId, username, muted, deafened) {
    const existing = this.speakers.get(userId);
    this.speakers.set(userId, {
      ...(existing ?? {
        username,
        audioEl:  null,
        analyser: null,
        audioCtx: null
      }),
      username,
      muted:    !!muted,
      deafened: !!deafened
    });
  }

  // ── VU meter polling ──────────────────────────────────
  _pollVU() {
    if (!this.onVU) return;

    const arr = [];
    this.speakers.forEach((spk, uid) => {
      let amp = 0;
      if (spk.analyser && !spk.muted) {
        const data = new Uint8Array(
          spk.analyser.frequencyBinCount);
        spk.analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data)
          sum += Math.abs(v - 128);
        amp = Math.min(
          sum / data.length / 128, 1);
      }
      arr.push({
        userId:   uid,
        username: spk.username,
        amp,
        muted:    !!spk.muted,
        deafened: !!spk.deafened
      });
    });

    this.onVU(arr);
  }

  isActive() { return this.vchatId !== null; }
}

window.SC       = window.SC || {};
window.SC.voice = new VoiceManager();