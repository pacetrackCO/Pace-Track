/* Shared camera preparation and detection. Business timing stays in each mode. */
(function (root) {
  'use strict';
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const modeNames = { original: 'Original · salida y llegada', loop: 'Loop · vueltas continuas', sector: 'Sector · dos estaciones', mobilepc: 'Móvil · resultados en PC' };
  function calibration(samples) {
    const usable = samples.filter(s => Number.isFinite(s.score) && Number.isFinite(s.light));
    if (usable.length < 25) return { ok: false, message: 'No hay suficientes imágenes. Espera a que la cámara se estabilice y vuelve a calibrar.' };
    const scores = usable.map(s => s.score).sort((a, b) => a - b);
    const light = usable.reduce((sum, s) => sum + s.light, 0) / usable.length;
    const median = scores[Math.floor(scores.length / 2)];
    const p90 = scores[Math.floor(scores.length * .9)];
    if (light < 12 || light > 245) return { ok: false, message: 'La imagen está demasiado oscura o sobreexpuesta. Mejora la luz y vuelve a calibrar.' };
    if (p90 > 35 || p90 - median > 25) return { ok: false, message: 'Hay demasiado movimiento. Fija el móvil y deja la línea libre durante la calibración.' };
    return { ok: true, threshold: clamp(p90 * 2 + 8, 8, 80), light, samples: usable.length };
  }
  function frameDifference(current, previous) {
    let difference = 0, light = 0, changed = 0;
    const count = Math.floor(current.length / 4);
    if (!count || (previous && previous.length !== current.length)) return { score: 0, light: 0, fraction: 0 };
    for (let i = 0; i < current.length; i += 4) {
      light += (current[i] + current[i + 1] + current[i + 2]) / 3;
      if (previous) {
        const delta = (Math.abs(current[i] - previous[i]) + Math.abs(current[i + 1] - previous[i + 1]) + Math.abs(current[i + 2] - previous[i + 2])) / 3;
        difference += delta;
        if (delta > 12) changed++;
      }
    }
    return { score: difference / count, light: light / count, fraction: changed / count };
  }
  function detectionRegion(sourceWidth, sourceHeight, viewWidth, viewHeight) {
    const scale = Math.max((viewWidth || sourceWidth) / sourceWidth, (viewHeight || sourceHeight) / sourceHeight);
    const visibleWidth = Math.min(sourceWidth, (viewWidth || sourceWidth) / scale);
    const height = Math.min(sourceHeight, (viewHeight || sourceHeight) / scale);
    const width = Math.max(1, visibleWidth * .05);
    return { x: (sourceWidth - width) / 2, y: (sourceHeight - height) / 2, width, height };
  }
  class MotionGate {
    constructor(options = {}) {
      this.threshold = options.threshold || 16;
      this.interval = options.interval || 500;
      this.quietMs = options.quietMs || 120;
      this.reset();
    }
    reset() { this.latched = false; this.last = -Infinity; this.high = 0; this.firstHigh = 0; this.quietSince = null; }
    update(score, now, fraction = 1) {
      if (!Number.isFinite(score) || !Number.isFinite(now)) return null;
      if (score < this.threshold * .55) {
        this.high = 0;
        if (this.quietSince === null) this.quietSince = now;
        if (now - this.quietSince >= this.quietMs && now - this.last >= this.interval) this.latched = false;
        return null;
      }
      this.quietSince = null;
      if (score <= this.threshold || fraction < .08) { this.high = 0; return null; }
      if (this.latched || now - this.last < this.interval) return null;
      if (!this.high || now - this.firstHigh > 150) { this.firstHigh = now; this.high = 1; return null; }
      this.high++;
      this.latched = true;
      this.last = this.firstHigh;
      return { at: this.firstHigh };
    }
  }
  function cameraError(error, secure = true) {
    if (!secure) return 'La cámara necesita una conexión HTTPS. Abre la web segura o usa el modo manual.';
    const messages = {
      NotAllowedError: 'No has permitido la cámara. Activa el permiso en tu navegador y pulsa Reintentar, o usa el modo manual.',
      SecurityError: 'El navegador ha bloqueado la cámara. Abre la página directamente con HTTPS o usa el modo manual.',
      NotFoundError: 'No encontramos una cámara. Conecta una o usa el modo manual.',
      NotReadableError: 'Otra aplicación puede estar usando la cámara. Ciérrala y reintenta.',
      OverconstrainedError: 'Esta cámara no admite la configuración. Prueba otra cámara o el modo manual.',
      PlaybackError: 'No se puede reproducir la cámara. Pulsa Reintentar para activar el vídeo.',
      TimeoutError: 'La cámara no respondió a tiempo. Comprueba los permisos y vuelve a intentarlo.',
      UnsupportedError: 'Este navegador no ofrece acceso a la cámara. Prueba un navegador actualizado o el modo manual.'
    };
    return messages[error && error.name] || 'No se pudo activar la cámara. Reintenta o continúa en modo manual.';
  }
  function element(tag, attrs = {}, text = '') {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    node.textContent = text;
    return node;
  }
  class Runtime {
    constructor(options) {
      this.options = options;
      this.state = 'setup'; this.method = 'automatic'; this.armed = false;
      this.gate = new MotionGate(); this.stream = null; this.token = 0; this.raf = null;
      this.pending = false; this.lastFrame = 0; this.lastVideoTime = -1; this.previous = null;
      this.customThreshold = false; this.facing = 'environment';
      this.sampleCanvas = document.createElement('canvas');
      this.sampleCanvas.width = 32; this.sampleCanvas.height = 240;
      this.ctx = this.sampleCanvas.getContext('2d', { willReadFrequently: true });
      this.overlay = options.canvas && options.canvas.getContext('2d');
      this._mount();
      this.visibility = () => { if (document.hidden && (this.stream || this.armed || this.pending)) this.interrupt('La detección se ha interrumpido al ocultar la página. Los resultados completados siguen guardados.'); };
      this.pagehide = () => this.interrupt('La sesión se ha interrumpido al salir. Prepara de nuevo la cámara para continuar.');
      this.beforeUnload = e => {
        const active = this.options.getActivity && this.options.getActivity();
        const unsaved = this.options.hasUnsavedData && this.options.hasUnsavedData();
        if (active || unsaved) { e.preventDefault(); e.returnValue = ''; }
      };
      document.addEventListener('visibilitychange', this.visibility);
      root.addEventListener('pagehide', this.pagehide);
      root.addEventListener('beforeunload', this.beforeUnload);
      this.prepare();
    }
    _mount() {
      document.body.classList.add('timing-enabled', 'timing-mode-' + this.options.mode);
      const { mount, slider } = this.options;
      this.guide = element('section', { id: 'timing-guide', 'aria-label': 'Preparación del cronómetro' });
      this.guide.append(element('span', { class: 'timing-mode' }, modeNames[this.options.mode] || 'Cronometraje'));
      this.heading = element('h2', {}, 'Prepara tu sesión');
      this.help = element('p', { id: 'timing-help' });
      this.progress = element('progress', { max: '3', value: '0', 'aria-label': 'Progreso de calibración' });
      const actions = element('div', { class: 'timing-actions' });
      const button = (id, label, action) => {
        const b = element('button', { id, type: 'button' }, label);
        b.addEventListener('click', action); actions.append(b); return b;
      };
      this.cameraButton = button('timing-camera-start', 'Preparar cámara', () => this.startCamera());
      this.manualButton = button('timing-manual-mode', 'Usar modo manual', () => this.useManual());
      this.retryButton = button('timing-camera-retry', 'Reintentar cámara', () => this.startCamera());
      this.armButton = button('timing-arm', 'Todo listo · activar detección', () => this.arm());
      this.recalibrateButton = button('timing-recalibrate', 'Volver a calibrar', () => this.recalibrate());
      this.guide.append(this.heading, this.help, this.progress, actions);
      this.sync = element('p', { id: 'timing-sync-status', role: 'status', 'aria-live': 'polite' }, 'Resultados en este dispositivo');
      this.manualTrigger = element('button', { id: 'timing-manual-trigger', type: 'button' }, 'Iniciar');
      this.manualTrigger.addEventListener('click', () => {
        if (!this.armed || this.method !== 'manual') return;
        this.manualTrigger.disabled = true;
        this.triggerTimer = setTimeout(() => { this.manualTrigger.disabled = false; }, 500);
        this.options.onTrigger({ now: performance.now(), method: 'manual' });
      });
      this.toolbar = element('details', { class: 'timing-tools', id: 'timing-tools' });
      this.toolbar.append(element('summary', {}, 'Ajustes y ayuda'));
      const details = element('div', { class: 'timing-tools-content' });
      details.append(element('p', {}, 'Fija el móvil a un lado de la pista. Cada paso debe cruzar la franja central. La espera mínima entre pasos es de 0,5 s; vuelve a dejar la línea libre para rearmar.'));
      if (slider) {
        slider.min = '8'; slider.max = '80'; slider.step = '1'; slider.value = String(this.gate.threshold);
        slider.setAttribute('aria-label', 'Umbral de movimiento: menor valor detecta movimientos más pequeños');
        const container = document.getElementById('sensitivity-slider-container');
        if (container) details.append(container);
        details.append(element('p', {}, 'Si detecta sin pasar nadie, aumenta el valor. Si no detecta el paso, redúcelo. Después pulsa Probar paso.'));
        slider.addEventListener('input', () => { this.gate.threshold = Number(slider.value); this.customThreshold = true; this.gate.reset(); });
      }
      this.testButton = element('button', { id: 'timing-test', type: 'button' }, 'Probar paso sin guardar');
      this.testButton.addEventListener('click', () => { if (this._allowChange() && this.stream) { this.armed = false; this.gate.reset(); this._state('testing'); } });
      this.switchButton = element('button', { id: 'timing-camera-switch', type: 'button' }, 'Cambiar cámara');
      this.switchButton.addEventListener('click', () => {
        const devices = this.devices || [];
        if (devices.length > 1) {
          const index = devices.findIndex(d => d.deviceId === this.deviceId);
          this.startCamera(devices[(index + 1) % devices.length].deviceId);
        } else {
          this.facing = this.facing === 'environment' ? 'user' : 'environment';
          this.startCamera();
        }
      });
      this.cameraInfo = element('p', { id: 'timing-camera-info' }, 'Todavía no se ha activado ninguna cámara.');
      const methodButton = element('button', { id: 'timing-change-method', type: 'button' }, 'Cambiar cámara / manual');
      methodButton.addEventListener('click', () => { if (this._allowChange()) { this.interrupt('Elige cámara o modo manual para continuar.'); this.prepare(); } });
      details.append(this.testButton, this.switchButton, this.cameraInfo, methodButton);
      details.append(element('p', {}, 'La pantalla muestra milisegundos, pero la precisión depende de la cámara, la luz y el dispositivo. No es un sistema homologado de competición.'));
      const controls = document.getElementById('controls');
      if (controls) details.append(controls);
      this.toolbar.append(details);
      mount.append(this.guide, this.sync, this.manualTrigger, this.toolbar);
      if (this.options.status) { this.options.status.setAttribute('role', 'status'); this.options.status.setAttribute('aria-live', 'polite'); }
    }
    setSync(text, kind = 'local') { this.sync.textContent = text; this.sync.dataset.kind = kind; }
    setTriggerLabel(text) { this.manualTrigger.textContent = text; }
    _state(state, message) {
      this.state = state; document.body.dataset.timingState = state;
      const content = {
        setup: ['Prepara tu sesión', '1. Fija el móvil y deja la franja central libre. 2. Prepara la cámara. 3. Haz un paso de prueba antes de activar el cronómetro.'],
        requesting: ['Activando cámara', 'Acepta el permiso del navegador. Si no aparece, revisa sus ajustes o usa el modo manual.'],
        calibrating: ['Calibrando · mantén la línea libre', 'Deja el móvil quieto durante 3 segundos. Todavía no se guardan tiempos.'],
        testing: ['Haz un paso de prueba', 'Cruza la franja central. Este paso no se guarda. Si no se detecta, revisa la colocación o ajusta la sensibilidad.'],
        tested: ['Paso detectado · cámara lista', 'Pulsa Activar detección cuando la pista esté libre. El siguiente paso iniciará el cronometraje.'],
        armed: ['Detección activada', 'Cada paso válido registra un evento. Mantén esta página visible y la pantalla encendida.'],
        manual: ['Modo manual listo', 'Pulsa el botón para iniciar y después para parar o registrar vuelta. Los resultados se marcarán como manuales.'],
        interrupted: ['Sesión interrumpida', 'La medición que estaba en curso no se guardará como válida. Los resultados completados se conservan.'],
        error: ['Revisa la cámara', 'Reintenta o utiliza el modo manual.'],
        stopped: ['Sesión detenida', 'Prepara de nuevo el cronómetro para continuar.']
      }[state];
      this.heading.textContent = content[0]; this.help.textContent = message || content[1];
      this.guide.hidden = state === 'armed' || state === 'manual';
      this.progress.hidden = state !== 'calibrating';
      this.cameraButton.hidden = !['setup', 'stopped'].includes(state);
      this.manualButton.hidden = ['manual', 'armed'].includes(state);
      this.retryButton.hidden = !['error', 'interrupted'].includes(state);
      this.recalibrateButton.hidden = !['testing', 'tested'].includes(state);
      this.armButton.hidden = state !== 'tested';
      this.manualTrigger.hidden = state !== 'manual';
      this.testButton.disabled = !this.stream || state === 'calibrating';
      this.switchButton.disabled = state === 'requesting';
      if (this.options.status) this.options.status.textContent = message || content[0];
    }
    prepare() { this._state('setup'); }
    _allowChange() {
      if (!this.options.getActivity || !this.options.getActivity()) return true;
      if (!root.confirm('Se descartará la medición en curso. Los tiempos completados se conservarán. ¿Continuar?')) return false;
      this.interrupt('Medición en curso descartada al cambiar la preparación.');
      return true;
    }
    _release() {
      this.token++; this.pending = false; this.armed = false;
      if (this.triggerTimer) clearTimeout(this.triggerTimer);
      this.manualTrigger.disabled = false;
      if (this.raf !== null) root.cancelAnimationFrame(this.raf);
      this.raf = null;
      const stream = this.stream; this.stream = null;
      if (stream) stream.getTracks().forEach(t => t.stop());
      this.options.video.srcObject = null;
      this.previous = null; this.lastVideoTime = -1;
    }
    stop() { this._release(); this._state('stopped'); }
    interrupt(reason) {
      const active = this.armed || this.stream || this.pending;
      this._release(); this._state('interrupted', reason);
      if (active && this.options.onInterrupt) this.options.onInterrupt(reason);
    }
    useManual() {
      if (!this._allowChange()) return;
      this._release(); this.method = 'manual'; this.armed = true;
      this._state('manual'); this._loop();
      if (this.options.onReady) this.options.onReady({ method: this.method });
    }
    async startCamera(deviceId) {
      if (this.pending || !this._allowChange()) return;
      this._release(); this.method = 'automatic'; this.pending = true;
      const token = this.token;
      this._state('requesting');
      let candidate = null;
      try {
        if (!root.isSecureContext) throw { name: 'SecurityError' };
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw { name: 'UnsupportedError' };
        const constraints = { audio: false, video: { facingMode: { ideal: this.facing }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } } };
        if (deviceId) { delete constraints.video.facingMode; constraints.video.deviceId = { exact: deviceId }; }
        try { candidate = await navigator.mediaDevices.getUserMedia(constraints); }
        catch (error) {
          if (error.name !== 'OverconstrainedError') throw error;
          if (token !== this.token) return;
          candidate = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
        }
        if (token !== this.token) { candidate.getTracks().forEach(t => t.stop()); return; }
        this.stream = candidate;
        const video = this.options.video;
        video.muted = true; video.playsInline = true; video.srcObject = candidate;
        await new Promise((resolve, reject) => {
          if (video.readyState >= 1 && video.videoWidth) { resolve(); return; }
          const complete = () => { clearTimeout(timeout); video.removeEventListener('loadedmetadata', complete); resolve(); };
          const timeout = setTimeout(() => { video.removeEventListener('loadedmetadata', complete); reject({ name: 'TimeoutError' }); }, 8000);
          video.addEventListener('loadedmetadata', complete, { once: true });
        });
        if (token !== this.token) return;
        try { await video.play(); } catch (_) { throw { name: 'PlaybackError' }; }
        if (token !== this.token) return;
        candidate.getVideoTracks().forEach(track => track.addEventListener('ended', () => { if (token === this.token) this.interrupt('La cámara se ha desconectado. Reintenta para continuar; la medición incompleta se descarta.'); }, { once: true }));
        candidate.getVideoTracks().forEach(track => track.addEventListener('mute', () => {
          if (token === this.token) this.interrupt('El sistema ha pausado la cámara. Prepara de nuevo la detección; la medición incompleta se descarta.');
        }, { once: true }));
        const track = candidate.getVideoTracks()[0];
        const settings = track && track.getSettings ? track.getSettings() : {};
        this.deviceId = settings.deviceId;
        this.cameraInfo.textContent = track && track.label ? `Cámara: ${track.label}` : 'Cámara activada. El navegador no informa de su nombre.';
        if (navigator.mediaDevices.enumerateDevices) {
          navigator.mediaDevices.enumerateDevices().then(devices => {
            if (token === this.token) this.devices = devices.filter(d => d.kind === 'videoinput' && d.deviceId);
          }).catch(() => { if (token === this.token) this.cameraInfo.textContent += ' No se pudo consultar la lista de cámaras; puedes intentar alternar frontal y trasera.'; });
        }
        this.pending = false; this.lastFrame = performance.now();
        this.recalibrate(); this._loop();
      } catch (error) {
        if (token !== this.token) return;
        this._release(); this._state('error', cameraError(error, root.isSecureContext));
      }
    }
    recalibrate() {
      if (!this.stream || !this._allowChange()) return;
      this.armed = false; this.samples = []; this.previous = null;
      this.calibrationStart = performance.now(); this.gate.reset();
      this._state('calibrating'); this.progress.value = 0;
    }
    arm() {
      if (this.state !== 'tested' || !this.stream) return;
      this.gate.reset(); this.armed = true; this._state('armed');
      if (this.options.onReady) this.options.onReady({ method: this.method });
    }
    _sample(now) {
      const video = this.options.video;
      if (!video.videoWidth || video.readyState < 2 || video.currentTime === this.lastVideoTime) return;
      this.lastVideoTime = video.currentTime; this.lastFrame = now;
      const box = video.getBoundingClientRect();
      const region = detectionRegion(video.videoWidth, video.videoHeight, box.width, box.height);
      this.ctx.drawImage(video, region.x, region.y, region.width, region.height, 0, 0, 32, 240);
      const data = this.ctx.getImageData(0, 0, 32, 240).data;
      const sample = frameDifference(data, this.previous);
      if (this.state === 'calibrating' && this.previous) this.samples.push(sample);
      if ((this.state === 'testing' || this.armed) && this.previous) {
        const hit = this.gate.update(sample.score, now, sample.fraction);
        if (hit) {
          this.flashUntil = now + 180;
          if (this.state === 'testing') this._state('tested');
          else if (this.armed) this.options.onTrigger({ now: hit.at, method: 'automatic' });
        }
      }
      this.previous = data;
      if (this.overlay) {
        const canvas = this.options.canvas;
        const scale = Math.min(1, 640 / video.videoWidth, 480 / video.videoHeight);
        const width = Math.max(1, Math.round(video.videoWidth * scale));
        const height = Math.max(1, Math.round(video.videoHeight * scale));
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
        this.overlay.clearRect(0, 0, canvas.width, canvas.height);
        this.overlay.strokeStyle = now < this.flashUntil ? '#67e8f9' : this.state === 'calibrating' ? '#ffae42' : '#ff8c00';
        this.overlay.lineWidth = Math.max(2, canvas.width / 160);
        this.overlay.strokeRect(canvas.width * .475, 0, canvas.width * .05, canvas.height);
      }
    }
    _loop() {
      if (this.raf !== null) return;
      let processed = -Infinity;
      let previousTick = performance.now();
      const tick = now => {
        this.raf = null;
        if (!this.stream && !this.armed) return;
        if (this.stream && now - previousTick > 1500) {
          this.interrupt('El procesamiento de cámara se ha detenido. La medición incompleta se descarta; prepara de nuevo la detección.');
          return;
        }
        previousTick = now;
        if (this.options.onFrame && (this.state === 'armed' || this.state === 'manual')) this.options.onFrame(now);
        if (this.stream && now - processed >= 1000 / 30) {
          processed = now;
          try { this._sample(now); }
          catch (_) { this.interrupt('No se puede leer la imagen de la cámara. Reintenta o usa el modo manual.'); return; }
          if (now - this.lastFrame > 2500) { this.interrupt('La imagen de la cámara se ha detenido. La medición incompleta se descarta.'); return; }
          if (this.state === 'calibrating') {
            this.progress.value = Math.min(3, (now - this.calibrationStart) / 1000);
            if (now - this.calibrationStart >= 3000) {
              const result = calibration(this.samples);
              if (!result.ok) { this._release(); this._state('error', result.message); return; }
              if (this.customThreshold && this.gate.threshold < result.threshold / 2) {
                this._release(); this._state('error', 'El valor elegido es demasiado bajo para el ruido de esta escena. Aumenta el umbral en Ajustes y reintenta. Tu ajuste no se ha cambiado.');
                return;
              }
              if (!this.customThreshold) { this.gate.threshold = result.threshold; if (this.options.slider) this.options.slider.value = String(Math.round(result.threshold)); }
              this.gate.reset(); this._state('testing');
            }
          }
        }
        this.raf = root.requestAnimationFrame(tick);
      };
      this.raf = root.requestAnimationFrame(tick);
    }
    dispose() {
      this._release();
      document.removeEventListener('visibilitychange', this.visibility);
      root.removeEventListener('pagehide', this.pagehide);
      root.removeEventListener('beforeunload', this.beforeUnload);
    }
  }
  root.PaceTrackTiming = { create: options => new Runtime(options), MotionGate, calibration, frameDifference, detectionRegion, cameraError };
})(typeof window !== 'undefined' ? window : globalThis);