export function Current() {
  return (
    <iframe
      src="/__mockup/pacetrack-current/index.html"
      title="PaceTrack — sitio original (vista previa)"
      allow="camera; microphone"
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        border: 0,
        display: 'block',
      }}
    />
  );
}