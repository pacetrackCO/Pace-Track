# Cronometraje de PaceTrack

## Uso

1. Elige Original, Loop, Sector o Móvil/PC.
2. Fija el dispositivo a un lado de la pista. El participante debe cruzar la franja central visible.
3. Pulsa **Preparar cámara**, permite el acceso y deja la línea libre durante la calibración de tres segundos.
4. Haz un paso de prueba. No se guarda como resultado.
5. Pulsa **Activar detección**. El siguiente paso inicia la medición.

También puedes elegir **Usar modo manual** sin solicitar acceso a la cámara. Original y Móvil/PC alternan inicio y parada; Loop registra una vuelta con cada pulsación posterior al inicio. Los resultados indican el método utilizado.

Los nombres y la importación de Excel son opcionales y están en **Ajustes y ayuda**. La calibración no sustituye un umbral que el usuario haya ajustado. Si el valor no es adecuado para el ruido de la escena, se avisa y se pide corregirlo.

### Sector

El modo local está identificado como local: no sustituye la medición entre dos estaciones.

Para dos dispositivos, salida crea una sala y llegada se une con el mismo código. Ambos preparan su cámara o modo manual. Llegada confirma que está lista después de comprobar la conexión y la referencia horaria. Salida no debe iniciar mientras falte esa confirmación.

Los relojes se comparan mediante varias muestras de ida y vuelta. Se estima el desfase y se convierte la marca de salida al reloj de llegada; no se utiliza únicamente la hora de recepción del mensaje. Los eventos tienen identidades de sesión, preparación e intento, confirmaciones, reintentos y rechazo de duplicados. Una confirmación perdida o una preparación interrumpida no debe convertirse en un nuevo paso válido.

El margen mostrado incluye media ida y vuelta y una provisión estimada de deriva por antigüedad. Es una estimación, **no una garantía de precisión**. Una medición incompleta o sin confirmación no se presenta como resultado fiable.

Si la llegada ya se ha registrado pero su confirmación está pendiente, se conserva ese resultado aunque se interrumpa la cámara. No se avanza al siguiente participante hasta reconciliarlo. Recupera la conexión y utiliza **Reintentar resultado pendiente**; no generes una nueva salida para intentar sustituirlo.

### Móvil/PC

Abre el cronómetro móvil desde el QR de la pantalla PC para vincular los resultados. Sin QR, funciona como una sesión local y lo indica.

Los resultados se guardan localmente antes de enviarse. Cada resultado tiene un ID estable; los reintentos no escriben una lista completa ni crean otro registro del mismo resultado. El estado de sincronización está separado del cronómetro. Los pendientes pueden reintentarse cuando vuelve la conexión.

La pantalla PC conserva su sesión y su copia de resultados al recargar. **Nueva sesión** genera otro vínculo y conserva los archivos locales anteriores para exportarlos. Borrar en el móvil no borra los resultados ya confirmados en PC; un envío que ya estaba en curso puede haber llegado al servidor.

## Límites y recuperación

- Se analiza una región central de 32 × 240 píxeles, a un máximo de 30 análisis por segundo. La región coincide con la franja visible y excluye la parte recortada del vídeo.
- La detección exige movimiento en dos imágenes consecutivas. Se fecha el evento en la primera imagen, no cuando termina la confirmación visual.
- Hay una separación mínima de 500 ms y se exige que la línea vuelva a estar libre durante 120 ms para rearmar. Una persona que permanece en la línea no debe producir vueltas repetidas.
- Los tiempos se calculan con un reloj monotónico, independientemente del número de imágenes o de la frecuencia con que cambia la pantalla.
- Al ocultar la página, perder o pausar la cámara, o detenerse el procesamiento, se descarta la medición incompleta. El historial terminado se conserva; hay que preparar de nuevo la sesión.
- Mantén la página visible y la pantalla encendida. No se promete funcionamiento automático en segundo plano.
- La cámara requiere HTTPS y permiso del navegador. En un visor incrustado, sus permisos también pueden restringirla; abre la web directamente si es necesario.
- Si falla el almacenamiento local, se avisa. Exporta los resultados antes de salir: no se promete recuperación en ese caso. No borres los datos del navegador si necesitas conservar el historial.
- Cámara fija, buena iluminación y un fondo sin movimiento son necesarios. Varias personas simultáneas, sombras, vibración, exposición automática y pasos demasiado rápidos pueden provocar errores.
- Mostrar milisegundos **no significa precisión de un milisegundo**. Este sistema no es cronometraje homologado de competición.
- Firebase, WebRTC, las bibliotecas de Excel/PDF y los permisos dependen del navegador y de la red. CSV y el cronometraje manual/local siguen siendo alternativas cuando esos servicios no están disponibles.

## Validación y compatibilidad

Estado comprobado el **1 de octubre de 2026**.

| Navegador o dispositivo | Qué se comprobó | Qué sigue pendiente |
| --- | --- | --- |
| Chromium 152.0.7977.64, Linux | Pruebas automatizadas del navegador, controles y recorridos completos; vistas de escritorio y 390 × 844 | Cámara física y enlace externo real entre dos dispositivos |
| Chrome en Android | Vista móvil comprobada en Chromium de escritorio; alternativa manual y gestión de permisos simulados | Android físico, cámara trasera/frontal, bloqueo y cambios de aplicación |
| Safari en iPhone/iPad | Código con vídeo silenciado y `playsinline`, activación explícita y recuperación manual | Safari/WebKit no ejecutado; permisos, reproducción, orientación, suspensión y cámara físicos |
| Chrome/Edge en Windows o macOS | Comparten familia de motor con Chromium, sin certificar esos sistemas | Pruebas físicas en esos sistemas y sus cámaras |
| Safari en macOS / Firefox | No ejecutados en esta validación | Pruebas por motor y dispositivos reales |

La vista móvil de Chromium **no es una prueba de Android ni de iOS**. Las cámaras, las respuestas de Firebase, el almacenamiento y los fallos de permisos usados en el banco de pruebas están simulados. No se han publicado estos cambios ni se han escrito resultados de prueba en Firebase real.

### Pruebas reproducibles

Con el flujo `PaceTrack` en ejecución:

```sh
node tests/verify-interface.mjs
node --test tests/*.test.cjs
python3 tests/run-browser-checks.py
```

El último comando utiliza Chromium y la biblioteca estándar de Python; no añade dependencias al sitio ni cambia su servidor. Se ejecuta en tiempo real, no con el reloj virtual del navegador.

Cobertura:

- Calibración insuficiente, ruido, luz inadecuada, doble detección, rearme y región visible.
- Original: participantes, rondas, método, historial recuperado, exportación y errores de almacenamiento.
- Loop: vueltas sucesivas, interrupción, migración de datos y reinicio sin resucitar historial borrado.
- Preparación explícita, prueba sin guardar, cámara simulada, permiso rechazado, reproducción bloqueada, permiso tardío/cancelado y pérdida de pista.
- Controles móviles, nombres, recorrido de importación de Excel, PDF/CSV y recuperación tras recarga.
- Relojes con desfase y retraso, mensajes duplicados o ajenos a la sesión, confirmaciones, referencias caducadas y eventos obsoletos.
- Cola móvil pendiente/confirmada, reintentos acotados, reconciliación de resultados locales, reinicio con envío en curso y separación de sesiones.
- Recuperación de la sesión PC, archivos anteriores, SDK no disponible y almacenamiento corrupto/bloqueado.

**Antes de confiar en el cronometraje sobre una pista real**, deben probarse cámaras físicas Android/iOS y el emparejamiento real entre estaciones, con permisos, cambios de aplicación, bloqueo, mala iluminación, pérdida de red y confirmaciones tardías. Anota dispositivo, sistema, navegador, escena, método y diferencia observada frente a una referencia independiente; no extrapoles una prueba a todos los dispositivos.