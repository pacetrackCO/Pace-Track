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
let timerState = 'stopped'; // stopped, running, paused
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
// === NUEVO: Estado para cooldown entre corredores ===
let cooldownActive = false;
let cooldownEndTime = 0;
const cooldownDuration = 3000; // 3 segundos

// === NUEVO: Almacenar tiempos por ronda ===
let roundLaps = []; // Tiempos de la ronda actual

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
    localStorage.setItem('roundLaps', JSON.stringify(roundLaps)); // NUEVO: Guardar tiempos de ronda actual
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

// NUEVA FUNCIÓN: Mostrar lista de corredores (SOLO TIEMPOS DE RONDA ACTUAL)
function displayRunnersList() {
    lapsList.innerHTML = '';
    if (runners.length === 0) {
        lapsContainer.style.display = 'none';
        return;
    }
    lapsContainer.style.display = 'block';
    
    // Mostrar todos los corredores, incluso los que aún no han pasado
    runners.forEach((runner, index) => {
        const li = document.createElement('li');
        
        // Buscar si este corredor ya tiene un tiempo registrado EN LA RONDA ACTUAL
        const lapRecord = roundLaps.find(lap => 
            lap.runnerName === runner.name && 
            roundLaps.indexOf(lap) % runners.length === index
        );
        
        if (lapRecord) {
            // Ya pasó - mostrar tiempo
            li.innerHTML = `<span>${runner.name}:</span> <span>${formatTime(lapRecord.time)}</span>`;
            li.style.color = '#10b981'; // Verde para los que ya pasaron
            li.style.fontWeight = '600';
        } else if (index === currentRunnerIndex && timerState === 'running') {
            // Es el corredor actual y está corriendo
            li.innerHTML = `<span>${runner.name}:</span> <span>→ EN CURSO</span>`;
            li.style.color = '#3b82f6'; // Azul para el actual
            li.style.fontWeight = '700';
        } else {
            // Aún no ha pasado
            li.innerHTML = `<span>${runner.name}:</span> <span>--:--.---</span>`;
            li.style.color = '#9ca3af'; // Gris para pendientes
        }
        
        lapsList.appendChild(li);
    });
    lapsList.scrollTop = lapsList.scrollHeight;
}

// FUNCIÓN ACTUALIZADA: Reemplazar displayLaps
function displayLaps() {
    displayRunnersList(); // Ahora usamos la nueva función
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

// === NUEVA FUNCIÓN: Iniciar cooldown entre corredores ===
function startCooldown() {
    cooldownActive = true;
    cooldownEndTime = performance.now() + cooldownDuration;
    timerState = 'paused';
    statusMessage.textContent = `Esperando ${cooldownDuration/1000}s para siguiente corredor...`;
    timerDisplay.style.color = 'orange';
    
    // Actualizar la lista durante el cooldown
    displayRunnersList();
    
    // Actualizar el display durante el cooldown
    const updateCooldownDisplay = () => {
        if (cooldownActive) {
            const remaining = cooldownEndTime - performance.now();
            if (remaining > 0) {
                timerDisplay.textContent = formatTime(remaining);
                requestAnimationFrame(updateCooldownDisplay);
            } else {
                // Cooldown completado
                cooldownActive = false;
                timerState = 'stopped';
                const nextRunner = runners[currentRunnerIndex];
                statusMessage.textContent = `Listo: ${nextRunner.name}`;
                timerDisplay.textContent = '00:00.000';
                timerDisplay.style.color = '#e2e8f0'; // Color normal
                lastDisplayedTime = 0;
                // Actualizar lista para mostrar siguiente corredor como pendiente
                displayRunnersList();
            }
        }
    };
    updateCooldownDisplay();
}

// === NUEVA FUNCIÓN: Iniciar nueva ronda ===
function startNewRound() {
    // Guardar todos los tiempos en recordedLaps (para PDF)
    recordedLaps.push(...roundLaps);
    
    // Limpiar roundLaps para la nueva ronda
    roundLaps = [];
    
    // Reiniciar índice de corredor
    currentRunnerIndex = 0;
    
    // Actualizar estado
    timerState = 'stopped';
    statusMessage.textContent = `Ronda ${currentRound} - Listo: ${runners[0].name}`;
    timerDisplay.textContent = '00:00.000';
    timerDisplay.style.color = '#e2e8f0';
    
    // Guardar y mostrar lista actualizada
    saveLaps();
    displayRunnersList();
}

// === FUNCIONES PARA EXCEL ===
function setupWithExcel() {
    document.getElementById('setup-modal').style.display = 'none';
    document.getElementById('excel-modal').style.display = 'flex';
    
    // Limpiar preview anterior
    document.getElementById('excel-file').value = '';
    document.getElementById('excel-preview').style.display = 'none';
    document.getElementById('names-list').innerHTML = '';
}

function processExcelFile() {
    const fileInput = document.getElementById('excel-file');
    const preview = document.getElementById('excel-preview');
    const namesList = document.getElementById('names-list');
    
    if (!fileInput.files.length) {
        showMessageBox('Por favor seleccione un archivo Excel');
        return;
    }
    
    const file = fileInput.files[0];
    const reader = new FileReader();
    
    reader.onload = function(e) {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            
            // Tomar la primera hoja
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const jsonData = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
            
            // Extraer nombres (primera columna)
            const names = [];
            jsonData.forEach(row => {
                if (row.length > 0 && row[0] && String(row[0]).trim()) {
                    names.push(String(row[0]).trim());
                }
            });
            
            if (names.length === 0) {
                showMessageBox('No se encontraron nombres en el archivo');
                return;
            }
            
            // Mostrar preview
            namesList.innerHTML = '';
            names.forEach((name, index) => {
                const li = document.createElement('li');
                li.textContent = `${index + 1}. ${name}`;
                namesList.appendChild(li);
            });
            
            preview.style.display = 'block';
            
            // Guardar nombres temporalmente
            window.tempExcelNames = names;
            
        } catch (error) {
            console.error('Error procesando Excel:', error);
            showMessageBox('Error al procesar el archivo Excel');
        }
    };
    
    reader.onerror = function() {
        showMessageBox('Error al leer el archivo');
    };
    
    reader.readAsArrayBuffer(file);
}

function saveExcelNames() {
    if (!window.tempExcelNames || window.tempExcelNames.length === 0) {
        showMessageBox('No hay nombres para guardar');
        return;
    }
    
    runners = window.tempExcelNames.map((name, index) => ({
        id: index + 1,
        name: name
    }));
    
    currentRunnerIndex = 0;
    currentRound = 1;
    recordedLaps = [];
    roundLaps = [];
    
    document.getElementById('excel-modal').style.display = 'none';
    document.getElementById('app-container').style.display = 'flex';
    
    saveLaps();
    setupCamera();
    createButtons();
    statusMessage.textContent = `Ronda 1 - Listo: ${runners[0].name}`;
    displayRunnersList();
    
    // Limpiar datos temporales
    window.tempExcelNames = null;
}

// === SETUP ===
function setupWithNames() {
    document.getElementById('setup-modal').style.display = 'none';
    document.getElementById('names-modal').style.display = 'flex';
    document.getElementById('names-input-container').innerHTML = `
        <div class="name-input-group">
            <label>Corredor 1:</label>
            <input type="text" placeholder="Nombre" id="runner-0">
        </div>
        <button id="add-runner-btn" class="gradient-blue">+ Agregar</button>
    `;
    document.getElementById('add-runner-btn').onclick = () => {
        const count = document.querySelectorAll('.name-input-group').length;
        const div = document.createElement('div');
        div.className = 'name-input-group';
        div.innerHTML = `<label>Corredor ${count + 1}:</label><input type="text" placeholder="Nombre" id="runner-${count}">`;
        document.getElementById('add-runner-btn').before(div);
    };
}

function saveRunnerNames() {
    runners = [];
    document.querySelectorAll('#names-input-container input').forEach((inp, i) => {
        const name = inp.value.trim() || `Corredor ${i+1}`;
        runners.push({ id: i+1, name });
    });
    currentRunnerIndex = 0;
    currentRound = 1;
    recordedLaps = []; // Limpiar tiempos anteriores
    roundLaps = []; // NUEVO: Limpiar tiempos de ronda actual
    document.getElementById('names-modal').style.display = 'none';
    document.getElementById('app-container').style.display = 'flex';
    saveLaps();
    setupCamera();
    createButtons();
    statusMessage.textContent = `Ronda 1 - Listo: ${runners[0].name}`;
    // MOSTRAR LISTA INMEDIATAMENTE
    displayRunnersList();
}

function setupWithoutNames() {
    runners = [{ id: 1, name: 'Corredor 1' }];
    currentRunnerIndex = 0;
    currentRound = 1;
    recordedLaps = []; // Limpiar tiempos anteriores
    roundLaps = []; // NUEVO: Limpiar tiempos de ronda actual
    document.getElementById('setup-modal').style.display = 'none';
    document.getElementById('app-container').style.display = 'flex';
    saveLaps();
    setupCamera();
    createButtons();
    statusMessage.textContent = `Ronda 1 - Listo: ${runners[0].name}`;
    // MOSTRAR LISTA INMEDIATAMENTE
    displayRunnersList();
}

function createButtons() {
if (document.getElementById('download-pdf')) return;

const dl = document.createElement('button');
dl.id = 'download-pdf';
dl.textContent = 'Descargar PDF';
dl.className = 'gradient-purple';
dl.onclick = () => {
    if (recordedLaps.length === 0) return showMessageBox('No hay tiempos');
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    
    // Título principal
    doc.setFontSize(20);
    doc.text('REPORTE DE TIEMPOS POR RONDAS', 105, 20, { align: 'center' });
    
    // Fecha
    doc.setFontSize(10);
    doc.text(`Generado: ${new Date().toLocaleDateString()}`, 20, 30);
    
    // Calcular número de rondas completadas
    const lapsPerRound = runners.length;
    const totalRounds = Math.ceil(recordedLaps.length / lapsPerRound);
    
    let y = 45; // Posición vertical inicial
    
    // Generar contenido para cada ronda
    for (let round = 1; round <= totalRounds; round++) {
        // Calcular índices de los laps para esta ronda
        const startIndex = (round - 1) * lapsPerRound;
        const endIndex = Math.min(startIndex + lapsPerRound, recordedLaps.length);
        const roundLaps = recordedLaps.slice(startIndex, endIndex);
        
        // Encabezado de ronda
        doc.setFontSize(14);
        doc.setTextColor(0, 51, 153); // Azul para el encabezado
        doc.text(`Ronda ${round}`, 20, y);
        y += 8;
        
        // Tiempos de la ronda
        doc.setFontSize(10);
        doc.setTextColor(0, 0, 0); // Negro para los tiempos
        
        roundLaps.forEach((lap, index) => {
            const position = index + 1;
            doc.text(`${position}. ${lap.runnerName}: ${formatTime(lap.time)}`, 25, y);
            y += 6;
        });
        
        y += 8; // Espacio entre rondas
        
        // Si no queda espacio en la página, crear nueva página
        if (y > 270 && round < totalRounds) {
            doc.addPage();
            y = 20;
        }
    }
    
    // Estadísticas finales
    doc.setFontSize(12);
    doc.setTextColor(0, 0, 0);
    doc.text(`Total de rondas: ${totalRounds}`, 20, y + 5);
    doc.text(`Total de tiempos registrados: ${recordedLaps.length}`, 20, y + 12);
    
    doc.save(`reporte_rondas_${new Date().toISOString().split('T')[0]}.pdf`);
    showMessageBox('PDF descargado con tiempos agrupados por rondas');
};

    const add = document.createElement('button');
    add.textContent = '+ Corredor';
    add.className = 'gradient-green';
    add.onclick = () => {
        const n = runners.length + 1;
        runners.push({ id: n, name: `Corredor ${n}` });
        saveLaps();
        showMessageBox(`+ Corredor ${n}`);
        // Actualizar lista cuando se agrega nuevo corredor
        displayRunnersList();
    };

    resetButton.after(dl);
    dl.after(add);
}

// === CÁMARA ===
async function setupCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        video.srcObject = stream;
        await new Promise(r => video.onloadedmetadata = r);
        [hiddenCanvas, overlayCanvas].forEach(c => {
            c.width = video.videoWidth;
            c.height = video.videoHeight;
        });
        startCalibration();
        requestAnimationFrame(detectMovement);
    } catch (e) {
        showMessageBox('Error: Cámara no disponible');
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
        // Actualizar lista después de calibrar
        displayRunnersList();
    }, calibrationDuration);
}

function detectMovement() {
    if (!video.videoWidth) { requestAnimationFrame(detectMovement); return; }

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

        // === MODIFICADO: Verificar si el cooldown está activo ===
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
                timerDisplay.style.color = '#ff4444'; // Rojo al iniciar
                // Actualizar lista para mostrar "EN CURSO"
                displayRunnersList();
            } else {
                const elapsed = performance.now() - startTime;
                const runner = runners[currentRunnerIndex];

                if (elapsed < 3000) {
                    statusMessage.textContent = 'Vuelta muy rápida';
                    drawLine('yellow', true);
                } else {
                    // VUELTA VÁLIDA - Guardar en roundLaps (ronda actual)
                    roundLaps.push({ time: elapsed, runnerName: runner.name });
                    saveLaps();

                    // === AVANZAR CORREDOR ===
                    const wasLast = currentRunnerIndex === runners.length - 1;

                    if (wasLast) {
                        // RONDA COMPLETADA
                        currentRound++;
                        
                        showMessageBox(`¡RONDA ${currentRound-1} COMPLETADA!\n\nTodos los corredores han pasado.\n\nPulsa OK para la RONDA ${currentRound}`);

                        timerState = 'paused';
                        statusMessage.textContent = 'Esperando...';

                        messageBoxOkButton.onclick = () => {
                            messageBox.style.display = 'none';
                            // === NUEVO: Iniciar nueva ronda en lugar de cooldown ===
                            startNewRound();
                            messageBoxOkButton.onclick = () => messageBox.style.display = 'none';
                        };
                    } else {
                        // Siguiente corredor normal
                        currentRunnerIndex++;
                        const next = runners[currentRunnerIndex];
                        statusMessage.textContent = `${runner.name} → ${formatTime(elapsed)} | Siguiente: ${next.name}`;
                        
                        // === NUEVO: Iniciar cooldown entre corredores ===
                        startCooldown();
                    }

                    timerState = 'stopped';
                    lastDisplayedTime = elapsed;
                    timerDisplay.style.color = '#e2e8f0'; // Color normal al detener
                    
                    // ACTUALIZAR LISTA CON NUEVO TIEMPO
                    displayRunnersList();
                }
            }
        }
    }

    previousFrameData = new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height);

    // === MODIFICADO: Actualizar display considerando cooldown ===
    if (timerState === 'running') {
        const currentTime = performance.now() - startTime;
        timerDisplay.textContent = formatTime(currentTime);
        
        // === NUEVO: Cambiar a rojo durante los primeros 3 segundos ===
        if (currentTime < 3000) {
            timerDisplay.style.color = '#ff4444'; // Rojo cuando no puede parar
        } else {
            timerDisplay.style.color = '#00ffff'; // Cian normal cuando puede parar
        }
    } else if (!cooldownActive) {
        timerDisplay.textContent = formatTime(lastDisplayedTime);
    }
    // Nota: Durante el cooldown, el display se actualiza en la función startCooldown()

    requestAnimationFrame(detectMovement);
}

// === EVENTOS ===
resetButton.onclick = () => {
    // 1. Limpiar TODO el localStorage
    localStorage.clear();

    // 2. Recargar la página (es lo más limpio y seguro)
    location.reload();
};

sensitivitySlider.oninput = e => {
    detectionThreshold = +e.target.value;
    statusMessage.textContent = `Sensibilidad: ${detectionThreshold}`;
};

messageBoxOkButton.onclick = () => messageBox.style.display = 'none';

// === EVENTOS PARA CONFIGURACIÓN ===
document.getElementById('setup-with-names').onclick = setupWithNames;
document.getElementById('setup-without-names').onclick = setupWithoutNames;
document.getElementById('save-names').onclick = saveRunnerNames;
document.getElementById('cancel-names').onclick = () => {
    document.getElementById('names-modal').style.display = 'none';
    document.getElementById('setup-modal').style.display = 'flex';
};

// === EVENTOS PARA EXCEL ===
document.getElementById('setup-with-excel').onclick = setupWithExcel;
document.getElementById('process-excel').onclick = saveExcelNames;
document.getElementById('cancel-excel').onclick = () => {
    document.getElementById('excel-modal').style.display = 'none';
    document.getElementById('setup-modal').style.display = 'flex';
    window.tempExcelNames = null;
};

// Event listener para cuando se selecciona un archivo Excel
document.getElementById('excel-file').addEventListener('change', processExcelFile);

// === INICIO ===
window.onload = () => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    script.onload = () => {
        loadLaps();
        if (runners.length > 0) {
            document.getElementById('app-container').style.display = 'flex';
            setupCamera();
            createButtons();
            statusMessage.textContent = `Ronda ${currentRound} - Listo: ${runners[currentRunnerIndex].name}`;
            // MOSTRAR LISTA INMEDIATAMENTE AL CARGAR
            displayRunnersList();
        } else {
            document.getElementById('setup-modal').style.display = 'flex';
        }
    };
    document.head.appendChild(script);
};

window.onresize = () => {
    if (video.videoWidth) {
        [hiddenCanvas, overlayCanvas].forEach(c => {
            c.width = video.videoWidth;
            c.height = video.videoHeight;
        });
    }
};