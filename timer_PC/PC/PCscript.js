document.addEventListener("DOMContentLoaded", () => {

    // --------- Cronómetro ---------
    let time = 0;
    let running = false;
    let interval;
    const stopwatchEl = document.getElementById('stopwatch');
    const timeListEl = document.getElementById('timeList');

    function formatTime(ms) {
        const minutes = Math.floor(ms / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);
        const centiseconds = Math.floor((ms % 1000) / 10);
        return `${minutes.toString().padStart(2,'0')}:${seconds.toString().padStart(2,'0')}.${centiseconds.toString().padStart(2,'0')}`;
    }

    function updateStopwatch() {
        time += 10;
        stopwatchEl.textContent = formatTime(time);
    }

    // Iniciar cronómetro automáticamente
    running = true;
    interval = setInterval(updateStopwatch, 10);

    // Guardar tiempo cada 5 segundos como ejemplo
    setInterval(() => {
        if (running) {
            const li = document.createElement('li');
            li.textContent = formatTime(time);
            timeListEl.appendChild(li);
        }
    }, 5000);


    // --------- QR fijo ---------
    const qrCanvas = document.getElementById('qrcode');
    QRCode.toCanvas(qrCanvas, window.location.href, function (error) {
        if (error) console.error(error);
        console.log('QR generado!');
    });

    // --------- Firebase ---------
    const firebaseConfig = {
        apiKey: "TU_API_KEY",
        authDomain: "tu-proyecto.firebaseapp.com",
        databaseURL: "https://tu-proyecto.firebaseio.com",
        projectId: "tu-proyecto",
    };
    firebase.initializeApp(firebaseConfig);
    const db = firebase.database();

    // --------- Chat ---------
    const mensajeInput = document.getElementById('mensaje');
    const enviarBtn = document.getElementById('enviar');
    const mensajesDiv = document.getElementById('mensajes');

    enviarBtn.addEventListener('click', () => {
        const msg = mensajeInput.value.trim();
        if (msg) {
            db.ref('chat').push({ texto: msg });
            mensajeInput.value = '';
        }
    });

    db.ref('chat').on('child_added', snapshot => {
        const msg = snapshot.val().texto;
        const div = document.createElement('div');
        div.textContent = msg;
        mensajesDiv.appendChild(div);
        mensajesDiv.scrollTop = mensajesDiv.scrollHeight; // autoscroll
    });

});
