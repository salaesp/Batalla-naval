# ⚓ Batalla Naval

Batalla naval online para dos jugadores. Uno crea la partida, le pasa el código (o el link) a un amigo, y juegan cada uno desde su navegador.

## Cómo se juega

1. **Crear partida**: te da un código de 5 letras y un link para compartir.
2. Tu amigo entra al link (o pone el código y toca **Unirse**).
3. Cada uno ubica sus barcos (a mano, tocando el tablero, o con **Al azar**) y toca **¡Listo!**.
4. Se sortea quién arranca y se dispara por turnos. Gana quien hunde primero toda la flota rival.
5. Al terminar podés pedir **Revancha** sin tener que reconectar.

Flota: portaaviones (5), acorazado (4), crucero (3), submarino (3) y destructor (2). Hay chat entre los dos jugadores.

## Cómo funciona

Es un sitio 100% estático (HTML + CSS + JS, sin build ni backend propio). Los dos navegadores se conectan directamente entre sí por **WebRTC** usando [PeerJS](https://peerjs.com/):

- El código de partida es el ID de PeerJS del anfitrión (`batalla-naval-v1-<CÓDIGO>`).
- El servidor público y gratuito de PeerJS (`0.peerjs.com`) sólo se usa para que los navegadores se encuentren; después el juego viaja directo entre los dos.
- Cada jugador guarda su propia flota: cuando el rival dispara, tu navegador responde si fue agua, tocado o hundido. Al final, el ganador muestra dónde estaban sus barcos.

## Publicar en Cloudflare Pages

### Opción A: conectando el repositorio de GitHub

1. En el panel de Cloudflare: **Workers & Pages → Create → Pages → Connect to Git**.
2. Elegí este repositorio.
3. Configuración de build:
   - **Framework preset**: None
   - **Build command**: *(vacío)*
   - **Build output directory**: `public`
4. **Save and Deploy**. Cada push a la rama principal vuelve a publicar.

### Opción B: desde la terminal con Wrangler

```sh
npx wrangler pages deploy public --project-name batalla-naval
```

## Probarlo localmente

Cualquier servidor estático sirve, por ejemplo:

```sh
cd public
python3 -m http.server 8000
```

Abrí `http://localhost:8000` en dos pestañas (o en dos dispositivos de la misma red) y jugá contra vos mismo.

## Notas

- Si un jugador recarga la página o cierra la pestaña, la partida se corta y hay que crear una nueva.
- En algunas redes muy restrictivas (redes corporativas o ciertos datos móviles) WebRTC puede no lograr conectar. PeerJS ya incluye servidores STUN/TURN públicos para la mayoría de los casos.
- Si en algún momento querés no depender del servidor público de PeerJS, se puede levantar uno propio con [`peerjs-server`](https://github.com/peers/peerjs-server) y pasarle `host`/`port` al `new Peer(...)` en `public/game.js`.
