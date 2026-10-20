# Editor PDF con capas

## Usar en iPad

Abre [editor-pdf-capas en GitHub Pages](https://morgot32.github.io/editor-pdf-capas/) en Safari. Pulsa **Abrir PDFs** para seleccionar varios archivos desde Archivos. Puedes alternar entre ellos o usar **Vista dividida**. Los PDF originales y las marcas se guardan en el almacenamiento de ese navegador para recuperar la sesión al volver a abrir la página. Conviene exportar el PDF marcado o guardar el proyecto JSON como copia de seguridad.

En iPad, **Guardar PDF como…** y **Guardar todos como…** ofrecen el menú Compartir de iOS cuando está disponible. Desde allí puedes elegir **Guardar en Archivos** y seleccionar la ubicación. Si el navegador no ofrece Compartir, se descarga el archivo. Los PDF se procesan en el dispositivo; el sitio no envía los documentos a un servidor. Esta versión admite hasta 20 PDF de 80 MB cada uno; no abre PDF protegidos con contraseña.

Usa **Mano** para arrastrar con un dedo. Cuando la hoja cabe en el ancho del panel, desliza horizontalmente con un dedo para pasar a la hoja anterior o siguiente. Pellizca con dos dedos para ampliar o reducir y desliza ambos dedos para mover la página; los gestos funcionan también mientras está seleccionada una herramienta de marcado. Al acercar, la zona visible se vuelve a dibujar en alta resolución. Para marcar o dibujar con el dedo, selecciona primero la herramienta correspondiente. El control **Hoja _n_ de _total_** permite escribir el número de hoja para ir directamente a ella.

## Publicar actualizaciones en GitHub Pages

1. Ejecuta `npm install` y `npm run build` en esta carpeta.
2. Confirma y envía los cambios a la rama `main` del repositorio `morgot32/editor-pdf-capas`.
3. En GitHub, configura **Settings → Pages → Build and deployment → Deploy from a branch**, rama `main` y carpeta `/docs`.

La carpeta `docs/` es la versión estática lista para GitHub Pages. La versión de Windows, que usa `server.py`, sigue disponible por separado.

Aplicación local para abrir varios PDF, resaltar zonas, dibujar trazos suaves y añadir textos de revisión con flecha. Cada PDF conserva sus páginas, zoom, capas, marcas e historial. Los PDF exportados incluyen anotaciones y grupos de contenido opcional (capas PDF), que se pueden mostrar u ocultar en lectores compatibles.

## Abrir en Windows

1. Haz doble clic en `ABRIR_EDITOR.cmd`.
2. Si indica que falta PyMuPDF, ejecuta `python -m pip install -r requirements.txt` desde esta carpeta y vuelve a abrir el `.cmd`.
3. El navegador abrirá la dirección indicada en la consola, normalmente `http://127.0.0.1:8787/`. Si una versión anterior sigue usando ese puerto, se abrirá una sesión nueva en `8788` o el siguiente puerto libre. Mantén abierta la consola de la sesión que utilices. Guarda o exporta las marcas de la sesión anterior antes de cerrarla.

## Uso

- **Abrir PDFs** permite seleccionar varios archivos a la vez. Cada uno aparece en una pestaña. **Vista dividida** muestra dos PDF lado a lado; haz clic en un panel para activar sus capas y herramientas.
- El botón pequeño **☰** muestra todos los PDF abiertos. Puedes ordenarlos por nombre, fecha de modificación del archivo o fecha de apertura. La **×** contigua cierra el PDF activo.
- **Mano** arrastra la página. La rueda del ratón acerca o aleja centrando el zoom en el puntero. **Ajustar** encaja la página del panel correspondiente.
- Mantén pulsado el **botón central del ratón** para mover el PDF con la mano temporalmente, incluso si está seleccionada otra herramienta.
- **Vista limpia** oculta las barras y paneles del editor dentro de la pestaña. El control flotante permite cambiar de hoja, girar y salir; **Esc** también sale. No activa la pantalla completa del navegador.
- **⟳** gira el PDF mostrado en pasos de 90°. Las marcas giran con la hoja y mantienen su posición. El giro es sólo de visualización y no altera el PDF original ni el exportado.
- En un PDF de varias hojas, usa **‹ / ›** para cambiar de hoja o escribe el número en **Hoja _n_ de _total_**. Las marcas quedan asociadas a su hoja al guardar o exportar.
- **Marcar** dibuja un rectángulo resaltado en la capa seleccionada. Cambia su color, opacidad, nombre o visibilidad en el panel derecho.
- **Dibujar** permite hacer trazos libres suavizados, con extremos redondos. Elige el **color del lápiz** y el grosor junto al botón antes de dibujar. Cada color se guarda en una capa **Dibujo** propia del PDF, por lo que cambiar el color no modifica las notas anteriores. Puedes ajustar la opacidad o renombrar cada capa; **+** crea otra capa de dibujo cuando esta herramienta está activa. El color elegido se recuerda por PDF y en el proyecto guardado.
- **Texto**: arrastra desde el punto que quieres señalar hasta donde irá el cuadro de texto y escribe el comentario. Haz doble clic en un comentario para editarlo. La flecha y el texto pertenecen a la capa activa.
- **Elegir** selecciona una marca. **Borrar seleccionada** o Supr la elimina.
- El panel **Capas** muestra el nombre del PDF activo y sólo sus capas y marcas. Haz clic en otro PDF, o en su panel de la vista dividida, para ver sus capas independientes.
- **Borrar** (E) elimina con un clic cada marca de ese PDF. También puedes usar **Borrar seleccionada** tras elegir una marca, o **Borrar todas** para vaciar las marcas del PDF activo tras una confirmación. **Ctrl+Z** deshace cualquiera de estos borrados.
- **Ctrl+Z** deshace y **Ctrl+Y** rehace cambios del PDF activo. **Ctrl+W** intenta cerrar ese PDF; algunos navegadores reservan el atajo para cerrar la pestaña, por lo que también está la **×** visible. Puedes usar H, R, D, T y V para cambiar de herramienta y mantener Espacio para usar la Mano temporalmente.
- **Guardar proyecto** descarga un JSON del PDF activo para continuar después. Abre primero el mismo PDF y luego usa **Abrir proyecto**.
- **Guardar PDF como…** permite elegir la ubicación del PDF activo con sus marcas. **Guardar todos como…** permite elegir la ubicación de un ZIP con todos los PDF abiertos y marcados. Usa el selector del navegador cuando está disponible y, si no, un diálogo de Windows. Los originales no se modifican.

Se pueden mantener hasta 20 PDF abiertos por sesión, con un máximo total de 600 MB. La vista dividida muestra dos simultáneamente y las pestañas permiten cambiar entre los demás. Los cambios se conservan al cambiar de pestaña; mientras el servidor siga abierto, la pestaña del navegador también recupera las marcas si se recarga. Guarda un proyecto o exporta antes de cerrar el servidor. PDFs protegidos por contraseña no se admiten. El zoom afecta la vista; la resolución máxima de previsualización se limita para mantener fluida la aplicación.
