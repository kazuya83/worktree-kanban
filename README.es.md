<div align="center">

<img src="docs/images/icon.png" alt="" width="96" />

# Worktree Kanban

<strong>Un tablero para combinar agentes de programación con IA en diagramas de flujo, donde las decisiones clave las toman las personas.</strong><br />
Implementa con Codex, revisa con Claude y devuelve el trabajo si hace falta. Tú decides si se fusiona.

[Sitio web](https://kazuya83.github.io/worktree-kanban/) · [Descargar](https://github.com/kazuya83/worktree-kanban/releases/latest)

[![Release](https://img.shields.io/github/v/release/kazuya83/worktree-kanban?label=release&color=3b5bfd)](https://github.com/kazuya83/worktree-kanban/releases/latest)
[![Platforms](https://img.shields.io/badge/platforms-Mac%20%7C%20Windows%20%7C%20Linux-52525B)](https://github.com/kazuya83/worktree-kanban/releases/latest)
[![Pipeline](https://img.shields.io/badge/pipeline-Codex%20%E2%86%92%20Claude%20%E2%86%92%20you-0891B2)](docs/images/en/feature-pipeline.gif)
[![Agents](https://img.shields.io/badge/agents-Claude%20Code%20%7C%20Codex%20%7C%20Antigravity%20%7C%20Gemini%20%7C%20Cursor%20%7C%20OpenCode%20%7C%20Copilot%20%7C%20Amp%20%7C%20Pi%20%7C%20Droid-7C3AED)](https://github.com/kazuya83/worktree-kanban#readme)
[![License](https://img.shields.io/badge/license-FSL--1.1--ALv2-52525B)](LICENSE)

[English](README.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [简体中文](README.zh-CN.md)

</div>

<div align="center">

![Demostración: describir un flujo en lenguaje natural, ver cómo Codex implementa y Claude revisa y devuelve el trabajo, aprobar un comando, revisar el diff y fusionar](docs/images/es/demo.gif)

</div>

Aplicación de escritorio (Electron, Mac / Windows / Linux) que ejecuta en paralelo las CLI de agentes de programación con IA (Claude Code / Codex CLI / Antigravity CLI / Gemini CLI / Cursor CLI / OpenCode / Copilot CLI / Amp / Pi / Droid), cada tarea en su propio git worktree, y las gestiona en un tablero kanban. **No solo ejecuta tareas dentro de un repositorio: también puede ejecutar a la vez tareas de varios repositorios.**

![Tablero: columnas Por hacer, En ejecución, Revisión y Hecho. Las tarjetas en ejecución muestran pregunta, espera de aprobación y en curso](docs/images/es/board.png)

## ¿Por qué Worktree Kanban?

- **Agentes en un diagrama de flujo** — describe un flujo en lenguaje natural o dibújalo, y los agentes se pasan el trabajo paso a paso, siguiendo ramas, bucles y pasos en paralelo.
- **El progreso, de un vistazo** — cada agente se convierte en un robot de pixel art que trabaja sobre su tarjeta. Editar, ejecutar comandos, esperar aprobación o esperar revisión se ve como movimiento, y en la pestaña Progreso el robot recorre un camino de banderas TODO y salta en la meta.
- **Tú decides** — revisa el diff antes de fusionar o abrir un PR. Con Claude Code, Codex y Cursor, también apruebas las acciones en la tarjeta.
- **Una tarea, un worktree** — cada tarea tiene su propio worktree de git y su rama, así que no chocan entre sí ni con tu árbol de trabajo.
- **Varios repositorios a la vez** — abre hasta 3 repositorios en pestañas; cambiar de pestaña no detiene nada.
- **Las CLI que ya usas** — Claude Code, Codex CLI, Antigravity CLI, Gemini CLI, Cursor CLI, OpenCode, Copilot CLI, Amp, Pi y Droid, con tu sesión y tu configuración actuales.
- **Control remoto Mac ⇄ Windows** — ejecuta los agentes en un PC y maneja el mismo tablero desde el otro: aprueba, responde preguntas, envía instrucciones y fusiona.
- **Todo en local** — el estado del tablero se queda en tu máquina. No hay un servidor externo. Con los servicios que conectes, tu máquina se comunica directamente.

## Cómo funciona

```mermaid
flowchart LR
    C["PC cliente"] -- "Túnel SSH" --> B
    subgraph H["PC host"]
        B["Tablero"] --> W1["worktree y rama 1"] --> A1["CLI del agente"]
        B --> W2["worktree y rama 2"] --> A2["CLI del agente"]
        A1 --> R["Tu repositorio"]
        A2 --> R
    end
    R -- "Fusión / PR" --> O(("main"))
```

- **1 tarea = 1 worktree = 1 rama.** Crea un worktree en `<repo>.worktrees/<id>`, junto al repositorio, y trabaja en una rama `agent/<resumen>-<id>`. Las tareas no chocan entre sí ni con el árbol de trabajo que tienes abierto
- **El agente es la CLI, arrancada tal cual.** Claude Code se ejecuta con `claude -p --input-format stream-json --output-format stream-json`, y su salida se muestra en la tarjeta como registro. El inicio de sesión, el modelo, `CLAUDE.md` y las skills son los mismos que usas en la terminal
- **La aprobación pasa por `--permission-prompt-tool` de Claude Code, `codex app-server` de Codex y ACP en Cursor, Gemini, OpenCode y Copilot (`cursor-agent acp`, etc.).** Solo las acciones que el modo de permisos o `--allowedTools` (el ajuste de herramientas permitidas de Worktree Kanban) no autoriza automáticamente aparecen en la tarjeta como espera de aprobación
- **Al terminar, incorporas el trabajo con un merge (`--no-ff`) o creando un PR / MR (`gh` en GitHub, la API en GitLab).** Puedes elegir la rama de destino y, después del merge, hacer push a origin
- El estado del tablero se guarda en `board.json`, en la carpeta userData de Electron. No hay un servidor externo

Fuera de Claude Code, las funciones disponibles dependen de la CLI. La aprobación en la tarjeta funciona en Codex, Cursor, Gemini, OpenCode y Copilot, y las preguntas de opción múltiple en Codex y Cursor. btw se entrega a Codex sin detener su trabajo, y las CLI con ACP (Cursor, Gemini, OpenCode, Copilot, y Amp o Pi con un adaptador) detienen el trabajo actual y continúan con el mensaje. El coste se muestra cuando una CLI con ACP lo informa. Nada de esto está disponible en Antigravity ni Droid (más detalles en [docs/agents.md](docs/agents.md) (English)).

## Funciones principales

### El progreso de un vistazo: un robot muestra cuánto ha avanzado cada tarea
Cada agente tiene un robot de pixel art que representa lo que está haciendo en ese momento. Con solo mirar el tablero sabes qué hace cada tarea y dónde se te necesita, sin leer los registros.

![El robot de cada tarjeta trabaja y, en la pestaña Progreso, recorre un camino de banderas TODO y salta en la meta cuando la tarea termina](docs/images/es/feature-progress.gif)

- **En la tarjeta**: el robot está sentado ante un escritorio y un bocadillo muestra lo que hace (editar archivos, ejecutar un comando, buscar en el código, consultar la web, etc.). Su antena parpadea mientras espera tu aprobación o tu respuesta, y una barra por segmentos muestra el avance de los TODO. Cada vez que termina un TODO, salen chispas de su segmento
- **En la pestaña Progreso**: el robot camina por un camino de banderas TODO hasta el TODO en el que está. Las banderas terminadas ondean en verde. Mientras la tarea espera tu revisión, el robot espera justo antes de la meta; cuando la tarea termina, salta en la meta bajo una lluvia de confeti. Si la ejecución se detiene, aparece una nube de lluvia sobre su cabeza
- Cada agente (Claude Code, Codex, Gemini, etc.) tiene su propio color de robot, y los agentes personalizados usan el color que elijas
- Si activas «Reducir movimiento» en el sistema, el robot se dibuja como una imagen fija

### Operar desde otro PC (RC)

Puedes manejar el tablero del PC que ejecuta los agentes (el host) desde Worktree Kanban en otro PC (el cliente). Tanto Mac como Windows pueden ser el host, y cualquiera de los dos puede ser el cliente. En el cliente puedes aprobar, responder preguntas, enviar instrucciones adicionales, hacer merge, etc., igual que en la pantalla del host.

![Conectarse desde otro PC y aprobar en el tablero del host](docs/images/es/feature-remote.gif)

- La aplicación del host solo escucha en `127.0.0.1`. La del cliente conecta con un túnel `ssh -N -L`, así que en el host solo hace falta un servidor SSH. Para conectar desde fuera, usa Tailscale u otra red similar
- SSH entra con una clave. En los «Ajustes de RC» del cliente, crea una clave ed25519 (`~/.ssh/agent-kanban_ed25519`) y registra la clave pública en los «Ajustes de RC» del host
- La primera vez se empareja con un código de 6 dígitos que aparece en el host. Después, un token guardado vuelve a conectar con el destino anterior

![Ajustes de RC del cliente (destino SSH y clave)](docs/images/es/rc-settings.png)

![Manejo del tablero del host desde el cliente (arriba se lee «Control remoto → SSH 100.101.102.103»)](docs/images/es/rc-client.png)

Los pasos, y cómo arreglar una conexión que falla, están en [docs/remote.md](docs/remote.md) (English).

### Usar desde el teléfono
Desde cualquier lugar, puede ver el tablero en el navegador del teléfono (Safari en iPhone, Chrome en Android), crear tareas, enviar instrucciones adicionales, aprobar y responder preguntas. No hace falta instalar nada en el teléfono.

- La aplicación del PC inicia [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (`cloudflared`, gratuito) y crea una URL HTTPS. No hace falta abrir puertos en el router. Elija un Quick Tunnel sin cuenta, o un túnel con nombre cuya URL no cambia
- Pulse «Teléfono» arriba, luego «Conectar un teléfono», y escanee el código QR con el teléfono. Los tokens caducan a los 30 días, y puede revocar un teléfono conectado cuando quiera
- Fusionar, los PR y cambiar la configuración no están disponibles desde el teléfono. Los agentes siempre se ejecutan en el PC, y solo funciona mientras la aplicación está abierta en el PC

Los pasos, y cómo arreglar una conexión que falla, están en [docs/mobile.md](docs/mobile.md) (English).

### Usar desde otras herramientas (CLI y MCP)
Agentes y scripts pueden crear tareas, consultar su estado y manejarlas: iniciar, aprobar, responder, fusionar, abrir PR, eliminar y ejecutar Pipelines.

- `wtk` es un comando para la terminal y los scripts (`wtk create "Fix the login bug" --start`, `wtk tasks`, `wtk merge <id>`). Se instala desde Ajustes > "CLI / MCP"
- `wtk mcp` es un servidor MCP, para que Claude Code y otros agentes manejen el tablero por sí mismos
- Si la aplicación no está abierta, wtk la inicia en modo residente. Otros equipos pueden usarlo por un túnel SSH tras emparejarse con un código de un solo uso

Consulte [docs/cli.md](docs/cli.md) (English).

Además: cambiar el estado (columna) de una tarjeta arrastrándola, mensajes a un agente en ejecución (btw), adjuntar imágenes y archivos, competición (varios agentes resuelven la misma tarea), y repositorios de WSL en Windows. El uso está resumido en [docs/usage.md](docs/usage.md) (English).

### Pipeline: describe un flujo en lenguaje natural y ejecuta tareas con él
Escribe el flujo que quieres en lenguaje natural, por ejemplo «implementar con Codex, revisar con Claude y volver a la implementación si hay cambios que hacer», y el agente construye el diagrama de flujo. Elige ese Pipeline al crear una tarea y los agentes se pasarán el trabajo paso a paso, siguiendo sus ramas y bucles. También puedes editar el diagrama a mano.

![Escribir un flujo en lenguaje natural, elegirlo para una tarea nueva y ver cómo avanzan los pasos y vuelven atrás tras una revisión](docs/images/es/feature-pipeline.gif)

Los detalles están en [docs/agents.md](docs/agents.md) (English).

### Subtareas
Cuando una tarea es grande, el agente puede proponer dividirla en subtareas. Salen de la rama padre, avanzan en paralelo o en orden y se fusionan a medida que terminan. También se puede iniciar una sola subtarea, y se admiten los sub-issues de GitHub, GitLab, Linear y Jira.

![Aceptar la propuesta de dividir una tarea y ver cómo las subtareas avanzan y se fusionan](docs/images/es/feature-subtasks.gif)

### Ejecutar varios repositorios en paralelo

Los repositorios se abren en pestañas (hasta 3). Cambiar de pestaña no detiene las tareas de los otros repositorios. Una pestaña que no está seleccionada muestra **cuántas tareas están en marcha** (azul) y **cuántas esperan tu respuesta** (aprobación, una pregunta, etc., en naranja), así que las pestañas bastan para ver qué repositorio te necesita. El límite de tareas simultáneas (el ajuste de cuántas ejecutar a la vez) se comparte entre todos los repositorios.

![Cambiar de pestaña de repositorio mientras las tareas de las demás siguen en marcha](docs/images/es/feature-repos.gif)

![Tres repositorios abiertos en pestañas. Las pestañas inactivas muestran cuántas tareas están en marcha y cuántas esperan tu respuesta](docs/images/es/repo-tabs.png)

El «+» de la barra de pestañas, o pulsar la pestaña abierta, permite elegir entre los repositorios abiertos hace poco. Desde ahí también se puede clonar desde una URL o crear un repositorio nuevo.

Puedes abrir una carpeta que no es un repositorio git (producción de vídeo y otro trabajo que no es código). En ese caso la tarea se ejecuta directamente en la carpeta, sin crear un worktree, y se cierra con «Marcar como hecha» (más detalles en [docs/usage.md](docs/usage.md) (English)).

![Diálogo para elegir repositorio (recientes y los que están abiertos en pestañas)](docs/images/es/repo-switch.png)

### Aprobación

Cuando una acción necesita permiso, puedes leer el comando y la entrada completos en la tarjeta y en el panel de detalle, y luego elegir permitir, rechazar o permitir siempre en esta tarea. Al rechazar, puedes devolver un motivo al agente.

![Leer el comando completo y aprobarlo](docs/images/es/feature-approval.gif)

<details>
<summary>Ver pantalla</summary>

![Tarjeta en espera de aprobación y panel de detalle](docs/images/es/detail-permission.png)

</details>

### Integraciones (GitHub, GitLab, Linear, Jira, Slack)

Crea tareas desde Issues y mantén su estado sincronizado. También puedes publicar notificaciones en Slack e iniciar tareas desde Slack.

| Servicio | Entrada para la tarea | Cuerpo del PR / MR | Sincronización de estado | Qué necesitas para conectar |
| --- | --- | --- | --- | --- |
| GitHub | `21, 22, 24` | `Closes #21` | Status de GitHub Projects | `gh` |
| GitLab | `12`, `group/project#12`, URL | `Closes #12` | Etiquetas y abierto / cerrado | URL, Personal Access Token (`api`) |
| Linear | `ENG-123`, URL | `Ref ENG-123 <URL>` | Estado del flujo de trabajo | Clave de API |
| Jira | `ABC-123`, URL | `ABC-123 <URL>` | Transición | URL, y un token de API con correo (Cloud) o un Personal Access Token (Data Center) |

Construye las instrucciones a partir del título, el cuerpo y los comentarios del Issue, y crea una tarjeta por Issue. Las ramas se llaman como `agent/issue-21-…`. Los sub-issues funcionan con los cuatro servicios, y los comentarios de vuelta en el Issue, con GitLab, Linear y Jira.

- **GitLab**: funciona con gitlab.com y con instalaciones propias. Si origin pertenece al GitLab conectado, usa la API en lugar de `gh` para crear MR y comprobar fusiones, conflictos y resultados de pipeline
- **Linear y Jira**: solo gestionan issues. Los PR y MR se crean en el host del repositorio. Jira funciona con Cloud y Data Center
- **Slack**: publica finalizaciones, fallos y lo que espera tu confirmación. Los usuarios de Slack permitidos pueden iniciar una tarea con una mención o un comando de barra en un canal configurado. También pueden aprobar y responder preguntas con los botones de las notificaciones. De entrada, nadie puede hacerlo. Usa Socket Mode, así que no abre puertos, pero solo funciona con la aplicación abierta

Cómo configurarlo:

1. En «Ajustes» → «Integraciones», escribe la dirección y el token, y guarda. Los tokens se cifran con una clave del almacén seguro del sistema operativo
2. En «Ajustes» → «Enlace con Issues», elige «Gestor de issues que se usa» para cada proyecto
3. Escribe números o URL en la pestaña de Issue de «Nueva tarea»

Cómo crear la aplicación de Slack y los detalles de cada servicio están en [docs/integrations.md](docs/integrations.md) (English).

![Introducir números de Issue para crear una tarjeta por Issue](docs/images/es/feature-issue.gif)

<details>
<summary>Ver pantalla</summary>

![Diálogo para crear tareas desde Issues](docs/images/es/issue-dialog.png)

</details>

### Preguntas del agente

Cuando Claude Code pregunta con `AskUserQuestion`, la tarjeta pasa a ser una pregunta y aparece un formulario de respuesta. Se admiten la selección múltiple y el texto libre (Otro).

![Responder a una pregunta del agente eligiendo una opción](docs/images/es/feature-question.gif)

<details>
<summary>Ver pantalla</summary>

![Formulario de respuesta a una pregunta](docs/images/es/question.png)

</details>

### worktree y diff

La pestaña «worktree» muestra los commits de la rama, los cambios sin commit, la relación con la base y los otros worktrees del mismo repositorio. En la pestaña «diff» eliges los archivos cambiados en un árbol agrupado por carpeta y ves el diff de cada archivo.

![Revisar el diff y fusionar](docs/images/es/feature-merge.gif)

<details>
<summary>Ver pantalla</summary>

![Pestaña worktree](docs/images/es/worktree.png)

![Pestaña diff](docs/images/es/diff.png)

</details>

### Conversación

En «Conversación» puedes preguntar al agente sobre el repositorio sin crear una tarea (worktree). Las respuestas se muestran en Markdown. Cuando quieras que empiece a trabajar, «Convertir en tarea» continúa esa conversación como tarea.

![Preguntar sobre el código en una conversación y convertirla en tarea](docs/images/es/feature-chat.gif)

<details>
<summary>Ver pantalla</summary>

![Conversación](docs/images/es/chat.png)

</details>

### Terminal

Abra una shell dentro de la aplicación. La pestaña «Terminal» de una tarea se abre en el worktree de esa tarea, y el botón «Terminal» de arriba (Ctrl + `) abre un panel en la parte inferior donde puede abrir tantas shells como quiera, sin relación con ninguna tarea. Las shells siguen en ejecución al cambiar de pestaña u ocultar el panel, hasta que las cierre. Durante el control remoto la shell se ejecuta en el host, y también puede permitirla desde el teléfono.

### Notificaciones

La espera de aprobación, las preguntas, la espera de respuesta, la espera de revisión y la finalización se acumulan en el icono de la campana, arriba a la derecha, y también sale una notificación de escritorio. Al pulsar una notificación se abre esa tarea. También pueden ir a Slack (consulta «Integraciones» más arriba).

![Abrir una notificación para ir a la tarjeta que te necesita](docs/images/es/feature-notifications.gif)

<details>
<summary>Ver pantalla</summary>

![Notificaciones](docs/images/es/notifications.png)

</details>

### Resolver conflictos

Si un merge entra en conflicto, la tarjeta pasa a ser un conflicto. Después de incorporar la rama base en la rama de la tarea, puedes pedir al agente que lo resuelva o corregirlo tú en un editor. En ambos casos, la rama base no cambia hasta que hagas el merge.

![Pedir al agente que resuelva un conflicto y fusionar](docs/images/es/feature-conflict.gif)

<details>
<summary>Ver pantalla</summary>

![Resolución de un conflicto](docs/images/es/conflict.png)

</details>

### Skills y conversaciones anteriores

Al crear una tarea puedes elegir una skill de Claude Code (se pasa como `/nombre-de-la-skill`). También puedes elegir una conversación anterior de Claude Code (sesión) y continuar desde ahí.

![Elegir una skill y una conversación anterior para una tarea nueva](docs/images/es/feature-skills.gif)

<details>
<summary>Ver pantalla</summary>

![Tarea nueva (con una skill y una conversación elegidas)](docs/images/es/new-task.png)

</details>

### Programador de tareas

Desde el menú de la barra superior, cambia a «Programador de tareas» para gestionar, en tarjetas, programaciones que crean y ejecutan una tarea en un momento dado (una vez, cada hora, cada día, cada semana o cada mes). Puedes registrar una tarea del kanban como programación, y también crear una tarea desde una programación en el momento. Las programaciones solo se ejecutan mientras la aplicación está abierta (más detalles en [docs/usage.md](docs/usage.md) (English)).

![Registrar una revisión diaria de dependencias, ejecutarla ahora y ver el resultado en el tablero](docs/images/es/feature-scheduler.gif)

## Requisitos

- git
- La CLI del agente que uses (una de Claude Code / Codex CLI / Antigravity CLI / Gemini CLI / Cursor CLI / OpenCode / Copilot CLI / Amp / Pi / Droid), con la sesión ya iniciada
- `gh`, si usas Issues y PRs de GitHub (también se puede instalar desde la aplicación)
- Un token por cada servicio que conectes (GitLab, Linear, Jira, Slack). Para guardarlos hace falta el almacén seguro del sistema operativo (en Linux, GNOME Keyring, KWallet o similar). Los Issues y MR de un repositorio de GitLab no necesitan `gh`

## Instalación

**Mac / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/kazuya83/worktree-kanban/main/install.sh | bash
```

**Windows** (PowerShell)

```powershell
irm https://raw.githubusercontent.com/kazuya83/worktree-kanban/main/install.ps1 | iex
```

Los mismos comandos actualizan a la última versión. También se puede actualizar desde la aplicación: «Ajustes» → «Actualización de la aplicación» → «Actualizar a la nueva versión». Si marcas «Actualizar automáticamente cuando salga una versión nueva», se sustituye y se vuelve a abrir cuando no hay ninguna tarea en marcha. Para fijar una versión, desinstalar, instalar desde un archivo y el aviso del primer arranque, consulta [docs/install.md](docs/install.md) (English).

## Uso

1. En «Elegir repositorio», elige el repositorio git en el que trabajar (también puedes clonar desde una URL o crear uno nuevo)
2. En «Nueva tarea», escribe las instrucciones y créala
3. Cuando quede en espera de aprobación, permítela en la tarjeta
4. Cuando pase a la columna Revisión, comprueba el diff y pulsa «Merge» o «Crear PR»

## Documentación

| Documento | Contenido |
| --- | --- |
| [Pantalla y uso](docs/usage.md) (English) | Uso de cada función: aprobación, preguntas, comprobación de la especificación, programador de tareas, skills, conversación, btw, merge / PR, estado de los Issues, notificaciones, conflictos y más |
| [Agentes y orquestación](docs/agents.md) (English) | Diferencias entre Claude Code / Codex / Antigravity / Gemini / Cursor / OpenCode / Copilot / Amp / Pi / Droid, Pipeline y competición |
| [Ajustes](docs/settings.md) (English) | La pantalla de ajustes que se abre desde el menú de la barra superior, y sus apartados |
| [Integraciones](docs/integrations.md) (English) | Configurar GitLab, Linear, Jira y Slack, y qué pueden y no pueden hacer |
| [Control remoto](docs/remote.md) (English) | Cómo manejar el tablero desde otro PC por un túnel SSH, y cómo arreglar una conexión que falla |
| [Usar desde el teléfono](docs/mobile.md) (English) | Cómo manejar el tablero desde el navegador del teléfono desde cualquier lugar (Cloudflare Tunnel), y cómo arreglar una conexión que falla |
| [CLI y MCP](docs/cli.md) (English) | Crear y manejar tareas desde scripts y agentes con `wtk` y su servidor MCP, también desde otro equipo |
| [Modo residente](docs/headless.md) (English) | Mantenerlo en marcha sin ventana (también en un servidor Linux): el programador, Slack, la vigilancia de Issues y el host de control remoto |
| [Instalación](docs/install.md) (English) | Instalación, actualización, desinstalación y uso de un repositorio de WSL en Windows |
| [Para desarrolladores](docs/development.md) (English) | Ejecutar desde el código, compilar, publicar, cómo está hecha la aplicación y las pruebas |
| [Migrar desde Vibe Kanban](https://kazuya83.github.io/worktree-kanban/migrate-from-vibe-kanban.html) (English) | Qué cambió en Vibe Kanban, qué se conserva y los pasos para migrar |
| [Migrar desde Conductor](https://kazuya83.github.io/worktree-kanban/migrate-from-conductor.html) (English) | Qué cambia en Conductor, cómo exportar los datos de Cloud, qué se conserva y los pasos para migrar |

## Contacto

- **Autor en GitHub**: [@kazuya83](https://github.com/kazuya83)
- **Correo**: [kzy83ishi15@gmail.com](mailto:kzy83ishi15@gmail.com)
- **Issues**: [worktree-kanban/issues](https://github.com/kazuya83/worktree-kanban/issues) — informes de errores y solicitudes de funciones

## Licencia

Publicado bajo la [Functional Source License 1.1 (FSL-1.1-ALv2)](LICENSE). Puedes usarlo, modificarlo y redistribuirlo para cualquier fin, salvo un producto o servicio comercial competidor. Cada versión pasa a estar disponible bajo la Apache License 2.0 dos años después de su publicación.
