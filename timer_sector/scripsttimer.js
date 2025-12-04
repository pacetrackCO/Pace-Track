// === VARIABLES ===
const video = document.getElementById('video');
const overlayCanvas = document.getElementById('overlay-canvas');
const timerDisplay = document.getElementById('timer-display');
const statusMessage = document.getElementById('status-message');
const resetButton = document.getElementById('reset-button');
const sensitivitySlider = document.getElementById('sensitivity-slider');
const messageBox = document.getElementById('message-box');
const messageContent = document.getElementById('message-content');
const messageBoxOkButton = document.getElementById('message-box-ok');
const lapsContainer = document.getElementById('laps-container');
const lapsList = document.getElementById('laps-list');
const hiddenCanvas = document.createElement('canvas');
const hiddenCtx = hiddenCanvas.getContext('2d', { willReadFrequently: true });
const overlayCtx = overlayCanvas.getContext('2d');

const beep = new Audio('Beep.mp3');
beep.preload = 'auto';

// === ESTADO ===
let runners = [];
let currentRunnerIndex = 0;
let currentRound = 1;
let timerState = 'stopped';
let startTime = 0;
let lastDisplayedTime = 0;
let previousFrameData = null;
let detectionThreshold = 100;
let lastDetectionTime = 0;
const detectionCooldown = 500;
let isCalibrating = true;
let calibrationSamples = [];
const calibrationDuration = 3000;
let recordedLaps = [];
let cooldownActive = false;
let cooldownEndTime = 0;
const cooldownDuration = 3000;
let roundLaps = [];

// === WEBRTC VARIABLES ===
let webrtcHandler = null;
let isConnected = false;
let remoteId = '';

// === WEBRTC FUNCTIONS ===
class WebRTCHandler {
    constructor() {
        this.myId = this.generateId();
        this.targetId = '';
        this.pc = null;
        this.channel = null;
        this.pollInterval = null;
        this.isCaller = false;
        this.connectionAttempts = 0;
        
        this.initializeWebRTC();
        this.updateUI();
    }

    generateId() {
        return Math.random().toString(36).substring(2, 8).toUpperCase();
    }

    initializeWebRTC() {
        try {
            // Configurar PeerConnection
            this.pc = new RTCPeerConnection({
                iceServers: [
                    { urls: "stun:stun.l.google.com:19302" },
                    { urls: "stun:stun1.l.google.com:19302" },
                    { urls: "stun:stun2.l.google.com:19302" }
                ]
            });

            // Eventos ICE
            this.pc.onicecandidate = (event) => {
                if (event.candidate) {
                    this.sendSignal({ type: "ice", candidate: event.candidate });
                }
            };

            // Estado de conexión
            this.pc.onconnectionstatechange = () => {
                console.log("WebRTC Connection state:", this.pc.connectionState);
                this.updateConnectionStatus();
            };

            // Canal de datos
            this.pc.ondatachannel = (event) => {
                console.log("📡 Data channel received");
                this.channel = event.channel;
                this.configureChannel();
            };

            // Iniciar polling
            this.startPolling();
            
            // Actualizar UI
            document.getElementById('myWebRTCId').value = this.myId;
            document.getElementById('connectionStatus').className = 'status-dot';
            document.getElementById('connectionText').textContent = 'Desconectado';
            
        } catch (error) {
            console.error("Error initializing WebRTC:", error);
        }
    }

    configureChannel() {
        if (!this.channel) return;

        this.channel.onopen = () => {
            console.log("✅ Data channel open");
            isConnected = true;
            this.updateConnectionStatus();
            showMessageBox("✅ Conexión WebRTC establecida");
            document.getElementById('remoteControlSection').style.display = 'block';
        };

        this.channel.onclose = () => {
            console.log("❌ Data channel closed");
            isConnected = false;
            this.updateConnectionStatus();
            document.getElementById('remoteControlSection').style.display = 'none';
        };

        this.channel.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                console.log("📨 Message received:", message);
                
                switch (message.command) {
                    case "start":
                        if (timerState === 'stopped') {
                            startTime = performance.now();
                            timerState = 'running';
                            statusMessage.textContent = '¡CORRIENDO! (Remoto)';
                            timerDisplay.style.color = '#ff4444';
                            displayRunnersList();
                            beep.currentTime = 0;
                            beep.play();
                            vibrate(200);
                        }
                        break;
                        
                    case "stop":
                        if (timerState === 'running') {
                            const elapsed = performance.now() - startTime;
                            
                            if (elapsed < 3000) {
                                statusMessage.textContent = 'Vuelta muy rápida (Remoto)';
                            } else {
                                const runner = runners[currentRunnerIndex];
                                roundLaps.push({ time: elapsed, runnerName: runner.name });
                                saveLaps();
                                
                                const wasLast = currentRunnerIndex === runners.length - 1;
                                
                                if (wasLast) {
                                    currentRound++;
                                    showMessageBox(`¡RONDA ${currentRound-1} COMPLETADA! (Remoto)`);
                                    timerState = 'paused';
                                    statusMessage.textContent = 'Esperando... (Remoto)';
                                    
                                    messageBoxOkButton.onclick = () => {
                                        messageBox.style.display = 'none';
                                        startNewRound();
                                    };
                                } else {
                                    currentRunnerIndex++;
                                    const next = runners[currentRunnerIndex];
                                    statusMessage.textContent = `${runner.name} → ${formatTime(elapsed)} | Siguiente: ${next.name} (Remoto)`;
                                    startCooldown();
                                }
                                
                                timerState = 'stopped';
                                lastDisplayedTime = elapsed;
                                timerDisplay.style.color = '#e2e8f0';
                                displayRunnersList();
                            }
                        }
                        break;
                        
                    case "reset":
                        localStorage.clear();
                        location.reload();
                        break;
                }
            } catch (error) {
                console.error("Error processing message:", error);
            }
        };
    }
async sendSignal(data) {
    if (!this.targetId) {
        console.warn("⚠️ No targetId defined");
        return;
    }

    console.log(`📤 Enviando señal a ${this.targetId}:`, data.type);

    try {
        const response = await fetch("/.netlify/functions/signal", {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify({
                id: this.myId,
                target: this.targetId,
                data: data
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const result = await response.json();
        console.log("✅ Señal enviada:", result);

    } catch (error) {
        console.error("❌ Error enviando señal:", error);
        showMessageBox("Error de red. Revisa tu conexión.");
    }
}

async startPolling() {
    const poll = async () => {
        try {
            const url = `/.netlify/functions/poll?id=${this.myId}`;
            console.log("🔄 Polling:", url);
            
            const response = await fetch(url, {
                headers: { "Accept": "application/json" }
            });

            if (!response.ok) {
                throw new Error(`Polling error: ${response.status}`);
            }

            const messages = await response.json();
            
            if (messages.length > 0) {
                console.log(`📨 ${messages.length} mensaje(s) recibido(s)`);
                for (const msg of messages) {
                    await this.handleSignal(msg.from, msg.data);
                }
            }

        } catch (error) {
            console.error("❌ Error en polling:", error);
        }

        // Continuar polling
        if (this.pollInterval) clearTimeout(this.pollInterval);
        this.pollInterval = setTimeout(poll, 1000);
    };

    poll();
}
    async handleSignal(from, data) {
        if (!this.targetId) {
            this.targetId = from;
            remoteId = from;
            this.updateUI();
        }

        console.log("📞 Signal received:", data.type);

        try {
            switch (data.type) {
                case "offer":
                    if (!this.isCaller) {
                        await this.pc.setRemoteDescription(new RTCSessionDescription(data.offer));
                        const answer = await this.pc.createAnswer();
                        await this.pc.setLocalDescription(answer);
                        await this.sendSignal({ type: "answer", answer });
                        this.configureChannel();
                    }
                    break;

                case "answer":
                    if (this.isCaller) {
                        await this.pc.setRemoteDescription(new RTCSessionDescription(data.answer));
                    }
                    break;

                case "ice":
                    if (data.candidate) {
                        await this.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
                    }
                    break;
            }
        } catch (error) {
            console.error("Error handling signal:", error);
        }
    }

    async connectToRemote(id) {
        if (!id || id === this.myId) {
            showMessageBox("ID inválido o igual al propio");
            return;
        }

        this.targetId = id;
        this.isCaller = true;
        remoteId = id;
        
        this.updateUI();
        document.getElementById('connectionStatus').className = 'status-dot connecting';
        document.getElementById('connectionText').textContent = 'Conectando...';

        try {
            this.channel = this.pc.createDataChannel("control");
            this.configureChannel();

            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);
            await this.sendSignal({ type: "offer", offer });
            
            showMessageBox(`Conectando a ${id}...`);
            
        } catch (error) {
            console.error("Error creating connection:", error);
            showMessageBox("Error al conectar");
        }
    }

    sendCommand(command, data = null) {
        if (this.channel && this.channel.readyState === "open") {
            const message = { 
                command, 
                data,
                timestamp: Date.now(),
                sender: this.myId
            };
            this.channel.send(JSON.stringify(message));
            return true;
        } else {
            console.warn("Channel not available");
            return false;
        }
    }

    updateConnectionStatus() {
        const statusDot = document.getElementById('connectionStatus');
        const statusText = document.getElementById('connectionText');
        
        if (this.pc) {
            switch (this.pc.connectionState) {
                case 'connected':
                    statusDot.className = 'status-dot connected';
                    statusText.textContent = `Conectado a ${remoteId || this.targetId}`;
                    isConnected = true;
                    break;
                case 'connecting':
                case 'checking':
                    statusDot.className = 'status-dot connecting';
                    statusText.textContent = 'Conectando...';
                    break;
                case 'disconnected':
                case 'failed':
                case 'closed':
                    statusDot.className = 'status-dot';
                    statusText.textContent = 'Desconectado';
                    isConnected = false;
                    remoteId = '';
                    this.targetId = '';
                    document.getElementById('remoteControlSection').style.display = 'none';
                    break;
                default:
                    statusDot.className = 'status-dot';
                    statusText.textContent = 'Desconectado';
            }
        }
    }

    updateUI() {
        document.getElementById('myWebRTCId').value = this.myId;
        
        if (this.targetId && this.targetId !== this.myId) {
            document.getElementById('remoteIdInput').value = this.targetId;
        }
        
        this.updateConnectionStatus();
    }
}

// === FUNCIONES DE INTERFAZ WEBRTC ===
function toggleWebRTCPanel() {
    const panel = document.getElementById('webrtc-panel');
    panel.classList.toggle('active');
}

function copyWebRTCId() {
    const idInput = document.getElementById('myWebRTCId');
    idInput.select();
    idInput.setSelectionRange(0, 99999);
    navigator.clipboard.writeText(idInput.value)
        .then(() => {
            showMessageBox("ID copiado al portapapeles");
        })
        .catch(err => {
            console.error('Error copying: ', err);
        });
}

function shareWebRTCId() {
    const id = webrtcHandler ? webrtcHandler.myId : 'No disponible';
    showMessageBox(`Tu ID para conectar es:\n\n${id}\n\nComparte este código con el otro dispositivo.`);
}

function connectToRemote() {
    const remoteId = document.getElementById('remoteIdInput').value.trim();
    if (!remoteId) {
        showMessageBox("Por favor ingresa un ID válido");
        return;
    }
    
    if (!webrtcHandler) {
        webrtcHandler = new WebRTCHandler();
    }
    
    webrtcHandler.connectToRemote(remoteId);
}

function sendStartCommand() {
    if (!webrtcHandler || !isConnected) {
        showMessageBox("No hay conexión activa");
        return;
    }
    
    webrtcHandler.sendCommand("start");
    showMessageBox("Comando ENVIADO: Iniciar cronómetro");
}

function sendStopCommand() {
    if (!webrtcHandler || !isConnected) {
        showMessageBox("No hay conexión activa");
        return;
    }
    
    webrtcHandler.sendCommand("stop");
    showMessageBox("Comando ENVIADO: Detener cronómetro");
}

function sendResetCommand() {
    if (!webrtcHandler || !isConnected) {
        showMessageBox("No hay conexión activa");
        return;
    }
    
    if (confirm("¿Estás seguro de reiniciar TODO en ambos dispositivos?")) {
        webrtcHandler.sendCommand("reset");
        showMessageBox("Comando ENVIADO: Reiniciar todo");
    }
}

// === UTILIDADES ===
function formatTime(ms) {
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const c = Math.floor(ms % 1000);
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(c).padStart(3,'0')}`;
}

function showMessageBox(msg) {
    messageContent.textContent = msg;
    messageBox.style.display = 'block';
}

function saveLaps() {
    localStorage.setItem('recordedLaps', JSON.stringify(recordedLaps));
    localStorage.setItem('runners', JSON.stringify(runners));
    localStorage.setItem('currentRunnerIndex', currentRunnerIndex);
    localStorage.setItem('currentRound', currentRound);
    localStorage.setItem('roundLaps', JSON.stringify(roundLaps));
}

function loadLaps() {
    const data = localStorage.getItem('recordedLaps');
    if (data) recordedLaps = JSON.parse(data);
    const r = localStorage.getItem('runners');
    if (r) runners = JSON.parse(r);
    const i = localStorage.getItem('currentRunnerIndex');
    if (i) currentRunnerIndex = parseInt(i);
    const round = localStorage.getItem('currentRound');
    if (round) currentRound = parseInt(round);
    const rl = localStorage.getItem('roundLaps');
    if (rl) roundLaps = JSON.parse(rl);
    displayLaps();
}

function displayRunnersList() {
    lapsList.innerHTML = '';
    if (runners.length === 0) {
        lapsContainer.style.display = 'none';
        return;
    }
    lapsContainer.style.display = 'block';
    
    runners.forEach((runner, index) => {
        const li = document.createElement('li');
        
        const lapRecord = roundLaps.find(lap => 
            lap.runnerName === runner.name && 
            roundLaps.indexOf(lap) % runners.length === index
        );
        
        if (lapRecord) {
            li.innerHTML = `<span>${runner.name}:</span> <span>${formatTime(lapRecord.time)}</span>`;
            li.style.color = '#10b981';
            li.style.fontWeight = '600';
        } else if (index === currentRunnerIndex && timerState === 'running') {
            li.innerHTML = `<span>${runner.name}:</span> <span>→ EN CURSO</span>`;
            li.style.color = '#3b82f6';
            li.style.fontWeight = '700';
        } else {
            li.innerHTML = `<span>${runner.name}:</span> <span>--:--.---</span>`;
            li.style.color = '#9ca3af';
        }
        
        lapsList.appendChild(li);
    });
    lapsList.scrollTop = lapsList.scrollHeight;
}

function displayLaps() {
    displayRunnersList();
}

function drawLine(color = 'rgba(255,0,0,0.7)', flash = false) {
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    overlayCtx.drawImage(video, 0, 0);
    const x = overlayCanvas.width * 0.5;
    const w = overlayCanvas.width * 0.05;
    overlayCtx.strokeStyle = color;
    overlayCtx.lineWidth = 6;
    overlayCtx.beginPath();
    overlayCtx.moveTo(x - w/2, 0); overlayCtx.lineTo(x - w/2, overlayCanvas.height);
    overlayCtx.moveTo(x + w/2, 0); overlayCtx.lineTo(x + w/2, overlayCanvas.height);
    overlayCtx.stroke();
    if (flash) {
        overlayCanvas.style.filter = 'brightness(1.5)';
        setTimeout(() => overlayCanvas.style.filter = '', 200);
    }
}

function vibrate(p) { if (navigator.vibrate) navigator.vibrate(p); }

function startCooldown() {
    cooldownActive = true;
    cooldownEndTime = performance.now() + cooldownDuration;
    timerState = 'paused';
    statusMessage.textContent = `Esperando ${cooldownDuration/1000}s para siguiente corredor...`;
    timerDisplay.style.color = 'orange';
    
    displayRunnersList();
    
    const updateCooldownDisplay = () => {
        if (cooldownActive) {
            const remaining = cooldownEndTime - performance.now();
            if (remaining > 0) {
                timerDisplay.textContent = formatTime(remaining);
                requestAnimationFrame(updateCooldownDisplay);
            } else {
                cooldownActive = false;
                timerState = 'stopped';
                const nextRunner = runners[currentRunnerIndex];
                statusMessage.textContent = `Listo: ${nextRunner.name}`;
                timerDisplay.textContent = '00:00.000';
                timerDisplay.style.color = '#e2e8f0';
                lastDisplayedTime = 0;
                displayRunnersList();
            }
        }
    };
    updateCooldownDisplay();
}

function startNewRound() {
    recordedLaps.push(...roundLaps);
    roundLaps = [];
    currentRunnerIndex = 0;
    timerState = 'stopped';
    statusMessage.textContent = `Ronda ${currentRound} - Listo: ${runners[0].name}`;
    timerDisplay.textContent = '00:00.000';
    timerDisplay.style.color = '#e2e8f0';
    saveLaps();
    displayRunnersList();
}

// === CONFIGURACIÓN INICIAL ===
function initializeApp() {
    loadLaps();
    
    if (runners.length === 0) {
        runners = [{ id: 1, name: 'Corredor 1' }];
        currentRunnerIndex = 0;
        currentRound = 1;
        recordedLaps = [];
        roundLaps = [];
        saveLaps();
    }
    
    createButtons();
    setupCamera();
    statusMessage.textContent = `Ronda ${currentRound} - Listo: ${runners[currentRunnerIndex].name}`;
    displayRunnersList();
    initializeWebRTC();
}

function createButtons() {
    if (document.getElementById('download-pdf')) return;

    const dl = document.createElement('button');
    dl.id = 'download-pdf';
    dl.textContent = 'Descargar PDF';
    dl.style.background = 'linear-gradient(90deg, #8b5cf6, #7c3aed)';
    dl.style.color = 'white';
    dl.style.padding = '0.9rem 2rem';
    dl.style.borderRadius = '9999px';
    dl.style.border = 'none';
    dl.style.cursor = 'pointer';
    dl.style.margin = '0 5px';
    dl.style.flexGrow = '1';
    dl.style.maxWidth = '220px';
    dl.style.fontSize = '1rem';
    dl.style.textTransform = 'uppercase';
    dl.style.letterSpacing = '0.5px';
    dl.onclick = () => {
        if (recordedLaps.length === 0) return showMessageBox('No hay tiempos');
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        
        doc.setFontSize(20);
        doc.text('REPORTE DE TIEMPOS POR RONDAS', 105, 20, { align: 'center' });
        
        doc.setFontSize(10);
        doc.text(`Generado: ${new Date().toLocaleDateString()}`, 20, 30);
        
        const lapsPerRound = runners.length;
        const totalRounds = Math.ceil(recordedLaps.length / lapsPerRound);
        
        let y = 45;
        
        for (let round = 1; round <= totalRounds; round++) {
            const startIndex = (round - 1) * lapsPerRound;
            const endIndex = Math.min(startIndex + lapsPerRound, recordedLaps.length);
            const roundLaps = recordedLaps.slice(startIndex, endIndex);
            
            doc.setFontSize(14);
            doc.setTextColor(0, 51, 153);
            doc.text(`Ronda ${round}`, 20, y);
            y += 8;
            
            doc.setFontSize(10);
            doc.setTextColor(0, 0, 0);
            
            roundLaps.forEach((lap, index) => {
                const position = index + 1;
                doc.text(`${position}. ${lap.runnerName}: ${formatTime(lap.time)}`, 25, y);
                y += 6;
            });
            
            y += 8;
            
            if (y > 270 && round < totalRounds) {
                doc.addPage();
                y = 20;
            }
        }
        
        doc.setFontSize(12);
        doc.setTextColor(0, 0, 0);
        doc.text(`Total de rondas: ${totalRounds}`, 20, y + 5);
        doc.text(`Total de tiempos registrados: ${recordedLaps.length}`, 20, y + 12);
        
        doc.save(`reporte_rondas_${new Date().toISOString().split('T')[0]}.pdf`);
        showMessageBox('PDF descargado con tiempos agrupados por rondas');
    };

    const add = document.createElement('button');
    add.textContent = '+ Corredor';
    add.style.background = 'linear-gradient(90deg, #10b981, #059669)';
    add.style.color = 'white';
    add.style.padding = '0.9rem 2rem';
    add.style.borderRadius = '9999px';
    add.style.border = 'none';
    add.style.cursor = 'pointer';
    add.style.margin = '0 5px';
    add.style.flexGrow = '1';
    add.style.maxWidth = '220px';
    add.style.fontSize = '1rem';
    add.style.textTransform = 'uppercase';
    add.style.letterSpacing = '0.5px';
    add.onclick = () => {
        const n = runners.length + 1;
        runners.push({ id: n, name: `Corredor ${n}` });
        saveLaps();
        showMessageBox(`+ Corredor ${n}`);
        displayRunnersList();
    };

    resetButton.after(dl);
    dl.after(add);
}

// === WEBRTC INITIALIZATION ===
function initializeWebRTC() {
    if (!webrtcHandler) {
        webrtcHandler = new WebRTCHandler();
        console.log("WebRTC initialized with ID:", webrtcHandler.myId);
    }
    return webrtcHandler;
}

// === CÁMARA ===
async function setupCamera() {
    try {
        statusMessage.textContent = 'Solicitando permiso de cámara...';
        
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error('El navegador no soporta acceso a cámara');
        }
        
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ 
                video: { 
                    facingMode: 'environment',
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                } 
            });
        } catch (rearError) {
            console.log('Cámara trasera no disponible, intentando frontal...', rearError);
            stream = await navigator.mediaDevices.getUserMedia({ 
                video: { 
                    facingMode: 'user',
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                } 
            });
        }
        
        video.srcObject = stream;
        
        await new Promise((resolve, reject) => {
            video.onloadedmetadata = resolve;
            video.onerror = reject;
            setTimeout(() => reject(new Error('Tiempo de espera agotado para la cámara')), 10000);
        });
        
        [hiddenCanvas, overlayCanvas].forEach(c => {
            c.width = video.videoWidth;
            c.height = video.videoHeight;
        });
        
        startCalibration();
        requestAnimationFrame(detectMovement);
        
    } catch (e) {
        console.error('Error al acceder a la cámara:', e);
        
        let errorMessage = 'Error: Cámara no disponible';
        
        if (e.name === 'NotAllowedError') {
            errorMessage = 'Permiso de cámara denegado. Por favor, permite el acceso a la cámara en la configuración de tu navegador.';
        } else if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
            errorMessage = 'No se encontró ninguna cámara. Conecta una cámara e intenta de nuevo.';
        } else if (e.name === 'NotReadableError' || e.name === 'TrackStartError') {
            errorMessage = 'La cámara está en uso por otra aplicación. Cierra otras aplicaciones que usen la cámara.';
        } else if (e.name === 'OverconstrainedError') {
            errorMessage = 'La cámara no soporta los requisitos necesarios. Intenta con otra cámara.';
        } else if (e.message === 'Tiempo de espera agotado para la cámara') {
            errorMessage = 'La cámara tardó demasiado en responder. Intenta reiniciar la aplicación.';
        }
        
        showMessageBox(errorMessage);
        statusMessage.textContent = errorMessage;
    }
}

function startCalibration() {
    isCalibrating = true;
    calibrationSamples = [];
    timerDisplay.textContent = 'CALIBRANDO';
    timerDisplay.style.color = 'yellow';
    setTimeout(() => {
        const avg = calibrationSamples.length ? calibrationSamples.reduce((a,b)=>a+b)/calibrationSamples.length : 0;
        detectionThreshold = Math.max(60, Math.min(400, avg * 2 + 30));
        sensitivitySlider.value = detectionThreshold;
        isCalibrating = false;
        timerDisplay.textContent = '00:00.000';
        timerDisplay.style.color = '#e2e8f0';
        displayRunnersList();
    }, calibrationDuration);
}

function detectMovement() {
    if (!video.videoWidth) { 
        requestAnimationFrame(detectMovement); 
        return; 
    }

    try {
        hiddenCtx.drawImage(video, 0, 0);
        drawLine();

        const x1 = hiddenCanvas.width * 0.475;
        const w = hiddenCanvas.width * 0.05;
        const frame = hiddenCtx.getImageData(x1, 0, w, hiddenCanvas.height);

        if (previousFrameData && frame.data.length === previousFrameData.data.length) {
            let diff = 0;
            for (let i = 0; i < frame.data.length; i += 4) {
                diff += Math.abs(frame.data[i] - previousFrameData.data[i]);
                diff += Math.abs(frame.data[i+1] - previousFrameData.data[i+1]);
                diff += Math.abs(frame.data[i+2] - previousFrameData.data[i+2]);
            }
            const norm = diff / (frame.data.length / 4);

            if (isCalibrating) {
                calibrationSamples.push(norm);
            } else if (!cooldownActive && timerState !== 'paused' && norm > detectionThreshold && (performance.now() - lastDetectionTime) > detectionCooldown) {
                lastDetectionTime = performance.now();
                beep.currentTime = 0; beep.play();
                drawLine('lime', true);
                vibrate(200);

                if (timerState === 'stopped') {
                    startTime = performance.now();
                    timerState = 'running';
                    statusMessage.textContent = '¡CORRIENDO!';
                    timerDisplay.style.color = '#ff4444';
                    displayRunnersList();
                } else {
                    const elapsed = performance.now() - startTime;
                    const runner = runners[currentRunnerIndex];

                    if (elapsed < 3000) {
                        statusMessage.textContent = 'Vuelta muy rápida';
                        drawLine('yellow', true);
                    } else {
                        roundLaps.push({ time: elapsed, runnerName: runner.name });
                        saveLaps();

                        const wasLast = currentRunnerIndex === runners.length - 1;

                        if (wasLast) {
                            currentRound++;
                            
                            showMessageBox(`¡RONDA ${currentRound-1} COMPLETADA!\n\nTodos los corredores han pasado.\n\nPulsa OK para la RONDA ${currentRound}`);

                            timerState = 'paused';
                            statusMessage.textContent = 'Esperando...';

                            messageBoxOkButton.onclick = () => {
                                messageBox.style.display = 'none';
                                startNewRound();
                                messageBoxOkButton.onclick = () => messageBox.style.display = 'none';
                            };
                        } else {
                            currentRunnerIndex++;
                            const next = runners[currentRunnerIndex];
                            statusMessage.textContent = `${runner.name} → ${formatTime(elapsed)} | Siguiente: ${next.name}`;
                            startCooldown();
                        }

                        timerState = 'stopped';
                        lastDisplayedTime = elapsed;
                        timerDisplay.style.color = '#e2e8f0';
                        displayRunnersList();
                    }
                }
            }
        }

        previousFrameData = new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height);

        if (timerState === 'running') {
            const currentTime = performance.now() - startTime;
            timerDisplay.textContent = formatTime(currentTime);
            
            if (currentTime < 3000) {
                timerDisplay.style.color = '#ff4444';
            } else {
                timerDisplay.style.color = '#00ffff';
            }
        } else if (!cooldownActive) {
            timerDisplay.textContent = formatTime(lastDisplayedTime);
        }
    } catch (e) {
        console.error('Error en detección de movimiento:', e);
    }

    requestAnimationFrame(detectMovement);
}

// === EVENTOS ===
resetButton.onclick = () => {
    localStorage.clear();
    location.reload();
};

sensitivitySlider.oninput = e => {
    detectionThreshold = +e.target.value;
    statusMessage.textContent = `Sensibilidad: ${detectionThreshold}`;
};

messageBoxOkButton.onclick = () => messageBox.style.display = 'none';

// === INICIO ===
window.onload = () => {
    initializeApp();
};

window.onresize = () => {
    if (video.videoWidth) {
        [hiddenCanvas, overlayCanvas].forEach(c => {
            c.width = video.videoWidth;
            c.height = video.videoHeight;
        });
    }
};