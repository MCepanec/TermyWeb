class VoiceManager {
  constructor() {
    this.vchatId    = null;
    this.peers      = new Map(); // userId → pc
    this.stream     = null;
    this.muted      = false;
    this.deafened   = false;
    this.analyser   = null;
    this.audioCtx   = null;
    this.onVU       = null;
    this.send       = null;
    this.myUserId   = null;
    this.myUsername = null;
    this.vuInterval = null;
    this.speakers   = new Map();
    // Keep audio elements alive — prevent GC
    this._audioEls  = new Set();
  }

  async join(vchatId, myUserId, myUsername, send) {
    this.vchatId    = vchatId;
    this.myUserId   = myUserId;
    this.myUsername = myUsername;
    this.send       = send;

    // Get microphone
    try {
      this.stream = await navigator.mediaDevices
        .getUserMedia({ audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl:  true
        }, video: false });
    } catch (err) {
      console.error('[voice] Mic error:', err);
      throw err;
    }

    // AudioContext — resume if suspended
    this.audioCtx = new AudioContext();
    if (this.audioCtx.state === 'suspended')
      await this.audioCtx.resume();

    const src = this.audioCtx
      .createMediaStreamSource(this.stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 256;
    src.connect(this.analyser);
    // Don't connect to destination — avoids
    // hearing yourself

    this.speakers.set(myUserId, {
      username: myUsername,
      analyser: this.analyser,
      muted:    false,
      deafened: false
    });

    this.vuInterval = setInterval(
      () => this._pollVU(), 100);
  }

  _createPC(userId) {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });

    // Add local tracks
    if (this.stream) {
      this.stream.getTracks().forEach(track => {
        pc.addTrack(track, this.stream);
      });
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.send({
          type:    'vchat_signal',
          toId:    userId,
          vchatId: this.vchatId,
          signal:  { ice: ev.candidate.toJSON() }
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[voice] PC ${userId}:`,
        pc.connectionState);
    };

    pc.ontrack = (ev) => {
      console.log('[voice] Got track from', userId);
      const stream = ev.streams[0];
      if (!stream) return;

      // Create audio element and keep reference
      const audio = new Audio();
      audio.srcObject = stream;
      audio.autoplay  = true;
      // Mute if deafened
      audio.muted = this.deafened;
      this._audioEls.add(audio);
      audio.play().catch(e =>
        console.warn('[voice] play():', e));

      // VU analyser for this remote peer
      const srcNode = this.audioCtx
        .createMediaStreamSource(stream);
      const an = this.audioCtx.createAnalyser();
      an.fftSize = 256;
      srcNode.connect(an);
      if (!this.deafened)
        srcNode.connect(this.audioCtx.destination);

      // Update or create speaker entry
      const existing = this.speakers.get(userId);
      this.speakers.set(userId, {
        username: existing?.username ?? String(userId),
        analyser: an,
        srcNode,
        audioEl:  audio,
        muted:    existing?.muted    ?? false,
        deafened: existing?.deafened ?? false
      });
    };

    this.peers.set(userId, pc);
    return pc;
  }

  async connectToPeer(userId, username,
                       isInitiator) {
    if (this.peers.has(userId)) return;
    console.log('[voice] Connecting to', userId,
      isInitiator ? '(initiator)' : '(answerer)');

    // Pre-populate speakers map with username
    if (!this.speakers.has(userId)) {
      this.speakers.set(userId, {
        username,
        analyser: null,
        muted:    false,
        deafened: false
      });
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

  async handleSignal(fromId, fromUser, signal) {
    // Ensure peer connection exists
    if (!this.peers.has(fromId)) {
      console.log('[voice] Creating PC for',
        fromId, '(signal arrived first)');
      if (!this.speakers.has(fromId)) {
        this.speakers.set(fromId, {
          username: fromUser,
          analyser: null,
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

  disconnectPeer(userId) {
    const pc = this.peers.get(userId);
    if (pc) {
      pc.close();
      this.peers.delete(userId);
    }
    const spk = this.speakers.get(userId);
    if (spk?.audioEl) {
      spk.audioEl.srcObject = null;
      this._audioEls.delete(spk.audioEl);
    }
    this.speakers.delete(userId);
  }

  leave() {
    clearInterval(this.vuInterval);
    this.vuInterval = null;

    this.peers.forEach((pc, uid) => {
      pc.close();
    });
    this.peers.clear();

    this._audioEls.forEach(a => {
      a.srcObject = null;
    });
    this._audioEls.clear();
    this.speakers.clear();

    if (this.stream)
      this.stream.getTracks()
        .forEach(t => t.stop());

    if (this.audioCtx &&
        this.audioCtx.state !== 'closed')
      this.audioCtx.close();

    this.stream     = null;
    this.audioCtx   = null;
    this.analyser   = null;
    this.vchatId    = null;
    this.myUserId   = null;
    this.muted      = false;
    this.deafened   = false;
  }

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
    this._audioEls.forEach(a => {
      a.muted = deafened;
    });
  }

  updatePeerState(userId, username,
                   muted, deafened) {
    const existing = this.speakers.get(userId);
    this.speakers.set(userId, {
      ...(existing ?? { username, analyser: null }),
      muted,
      deafened
    });
  }

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

window.SC      = window.SC || {};
window.SC.voice = new VoiceManager();