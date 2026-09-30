window.addEventListener('load', () => {
    const splashContainer = document.getElementById('splash-container');
    splashContainer.addEventListener('animationend', (e) => {
        if (e.animationName === 'splashZoom') {
            splashContainer.style.display = 'none'; // Oculta el splash
        }
    });
});
