const logo = document.getElementById('logo');

// Centrar el logo
setTimeout(() => {
    logo.classList.add('centered');
}, 100);

// Mover a la esquina superior izquierda
setTimeout(() => {
    logo.classList.remove('centered');
    logo.classList.add('moved');
}, 1500);
