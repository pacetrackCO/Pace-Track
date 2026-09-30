# Pruebas físicas de cronometraje

**Estado: validación formal pendiente.** Hay una confirmación de uso en iOS comunicada por el usuario; no se han documentado mediciones de cámaras físicas, enlaces reales ni diferencias frente a una referencia independiente. No hay certificación Android/iOS. La matriz de `README.md` sigue vigente.

## Alcance de esta entrega

Con la confirmación del usuario, se cierra la entrega con alcance reducido a preparar este protocolo, comprobar la regresión automatizada y registrar su confirmación informal en iOS. Pasaron las verificaciones de interfaz, 43 pruebas Node y 77 comprobaciones Chromium con cámara y servicios simulados. Este cierre no significa que se haya completado la validación física original: Android, los enlaces reales Sector/Móvil-PC y la precisión frente a una referencia independiente siguen pendientes.

## Confirmación recibida

El 1 de octubre de 2026, el usuario confirmó que funciona en iOS. No indicó modelo, versiones de sistema/navegador, modo utilizado, método automático/manual ni resultados de los recorridos de este protocolo. Se registra como confirmación informal de funcionamiento, no como prueba ejecutada u observada por el agente. Android, los enlaces Sector y Móvil/PC reales y la comparación de precisión siguen pendientes.

## Preparación y aislamiento

El aislamiento acordado consiste en perfiles de navegador separados y sesiones nuevas exclusivamente de prueba:

- En PC, utilizar un perfil de navegador de pruebas. En móviles, usar un perfil separado si el navegador lo admite o un navegador dedicado que no contenga historiales de PaceTrack. Si no se puede separar el almacenamiento, detenerse y acordar otra opción; no borrar datos existentes.
- Abrir el sitio directamente por HTTPS, no dentro de un visor incrustado. No publicar una nueva versión para estas pruebas sin autorización aparte.
- Configurar participantes ficticios antes de emparejar. No usar nombres personales.
- Crear una sala Sector nueva y un vínculo Móvil/PC nuevo desde el perfil de pruebas. No usar salas, QR ni sesiones de uso habitual.
- Anotar los identificadores solo en el registro privado de la prueba; no compartir enlaces de acceso ni guardarlos en este repositorio.
- Exportar los resultados de prueba antes de cerrar. No borrar historiales existentes ni realizar una limpieza general de Firebase.

Preparar un iPhone y un PC permite comprobar sus recorridos disponibles, pero no validar Android. Sector automático entre dos estaciones exige dos equipos con cámaras utilizables. Una estación manual no certifica su cámara.

## Ficha de ejecución

Copiar esta ficha por combinación de equipo, cámara, navegador y modo. Dejar «pendiente» donde no se haya ejecutado, no «correcto».

| Campo | Registro |
| --- | --- |
| Fecha y versión probada | Pendiente |
| Modelo de dispositivo y sistema, con versiones | Pendiente |
| Navegador y versión | Pendiente |
| Modo: Original / Loop / Sector / Móvil-PC | Pendiente |
| Cámara: frontal / trasera / externa; resolución efectiva si se conoce | Pendiente |
| Orientación, distancia y fijación del dispositivo | Pendiente |
| Iluminación, sombras y movimiento del fondo | Pendiente |
| Método automático o manual | Pendiente |
| Permisos: permitir, rechazar, cancelar y volver a preparar | Pendiente |
| Bloqueo y cambio de aplicación; fase en que se interrumpió | Pendiente |
| Red y pérdida/recuperación de conexión | Pendiente |
| Confirmaciones tardías y estado pendiente/confirmado | Pendiente |
| Referencia independiente y su incertidumbre | Pendiente |
| Exportación CSV/PDF, recarga y recuperación | Pendiente |
| Resultado: correcto / fallo reproducible / inconcluso | Pendiente |
| Pasos para reproducir, observaciones y evidencia | Pendiente |

## Recorridos

Realizar primero las pruebas con buena luz y cámara fija. Repetir con ambas cámaras disponibles, en vertical y horizontal, y con luz desfavorable. Anotar cada variante, incluso si la calibración la rechaza correctamente.

1. **Cámara y permisos:** permitir acceso, preparar con línea libre, realizar un paso de prueba y comprobar que no guarda un resultado. Repetir rechazando el permiso, cancelando la preparación y volviendo a solicitar acceso. Verificar la alternativa manual.
2. **Original:** registrar inicio y parada, avanzar participante/ronda y comprobar nombres, método y tiempos en historial y exportación. Mantenerse en la línea: no debe registrar pasos repetidos.
3. **Loop:** registrar varias vueltas separadas; comprobar que cada intervalo se conserva una sola vez. Interrumpir una vuelta mediante bloqueo o cambio de aplicación: conservar las vueltas terminadas y no guardar el tramo incompleto.
4. **Interrupciones:** en cada modo, ocultar la página, bloquear la pantalla y girar el dispositivo durante preparación y medición. Documentar qué hace realmente el navegador; no esperar funcionamiento en segundo plano. Tras una interrupción de cámara/procesamiento, preparar de nuevo y comprobar el historial.
5. **Sector real:** preparar dos estaciones en una sala de prueba nueva, salida y llegada. No iniciar antes de la confirmación de llegada. Registrar varios recorridos con una referencia común que observe ambos cruces. Repetir perdiendo red antes de salida, durante el intento y después de registrar llegada. Recuperar red y reintentar el resultado pendiente sin crear otra salida. Comprobar que no se duplica, no avanza dos veces y no aparece como fiable mientras esté incompleto.
6. **Confirmaciones tardías:** si es posible, ralentizar la conexión de pruebas de una estación con las herramientas del navegador. Anotar el momento de envío, confirmación e interrupción. Si no se puede producir una confirmación tardía real, registrar «pendiente», no extrapolar la simulación. No modificar Firebase/WebRTC para provocar el caso.
7. **Móvil/PC real:** abrir el QR de una sesión PC nueva en el móvil, completar resultados y compararlos en ambos equipos. Desconectar solo la red del móvil, completar otro resultado, recuperar red y reintentar. Verificar una sola copia confirmada y persistencia tras recarga en ambos equipos. Desde el perfil de pruebas, crear otra sesión PC y comprobar que el archivo anterior sigue exportable y los nuevos resultados no se mezclan.
8. **Exportaciones:** abrir CSV y PDF en los equipos disponibles y cotejar filas, método, participantes y tiempos con el historial. Documentar si falta una biblioteca o el navegador bloquea la descarga; no considerar exportación correcta solo porque se pulsa el botón.

No interrumpir una conexión utilizada por terceros ni reutilizar datos reales para estas pruebas.

## Comparación de tiempos

Usar una referencia independiente que observe los mismos cruces, por ejemplo vídeo externo con frecuencia de imágenes conocida o fotocélulas. Un cronómetro accionado a mano incorpora tiempo de reacción y no demuestra precisión de milisegundos.

Antes de medir, fijar la tolerancia necesaria para el uso previsto y registrar la incertidumbre de la referencia. Sin tolerancia e incertidumbre documentadas, la comparación es descriptiva, no una aprobación de precisión.

Registrar cada intento, incluidos pasos omitidos y falsos positivos:

| Intento | Modo y condición | PaceTrack (ms) | Referencia (ms) | Diferencia firmada (ms) | Margen Sector mostrado (ms) | Detecciones omitidas/extra | Estado de sincronización |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Pendiente | — | — | — | — | — | — | — |

La diferencia es `PaceTrack − referencia`. Resumir número de intentos, error absoluto máximo, error medio firmado e intentos fallidos. El margen de Sector es una estimación, no una garantía. No eliminar los fallos del resumen ni generalizar una combinación probada a otros equipos.

## Tratamiento de fallos

Conservar pasos y evidencia de una regresión reproducible antes de cambiar código. Añadir una prueba automatizada cuando el caso sea reproducible sin hardware; volver a probar en el dispositivo afectado para cerrar el fallo físico. No cambiar Firebase, WebRTC, Netlify ni el diseño aprobado como parte de esta validación.