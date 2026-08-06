import type { CSSProperties } from "react";

import styles from "./page.module.css";

const BOT = "seb_english_push_bot";

/**
 * The four practice modes.
 *
 * `channel` is the point of the grid: the modes are not a sequence and are not
 * difficulty tiers, they are four different channels of the language. That is
 * the only honest way to group them.
 */
const MODES = [
  {
    name: "Free conversation",
    channel: "Escribir",
    command: "/chat",
    body: "Trae él el tema y te lleva la contraria si hace falta, porque defender una postura es donde sale el idioma bueno. Aquí deja pasar los errores pequeños: importa el volumen.",
  },
  {
    name: "Voice drill",
    channel: "Hablar",
    command: "/drill",
    body: "Una pregunta concreta que exige entre veinte y cuarenta y cinco segundos hablados, sin tiempo de componer la frase en español antes. Respondes con nota de voz.",
  },
  {
    name: "Spaced review",
    channel: "Recordar",
    command: "/review",
    body: "Micro-ejercicios construidos con tus propios errores. Nunca te pregunta si recuerdas algo: te pone en una situación donde tienes que producirlo.",
  },
  {
    name: "Listening",
    channel: "Escuchar",
    command: "/listen",
    body: "Cien o ciento cincuenta palabras habladas, solo en audio, y preguntas que no puedes contestar sin haber entendido. Nunca verás el texto.",
  },
] as const;

const COMMAND_GROUPS = [
  {
    title: "Practicar",
    items: [
      { cmd: "/chat", desc: "Empieza a hablar ahora mismo." },
      { cmd: "/practice", desc: "Él elige el modo por ti." },
      { cmd: "/quick", desc: "La versión de dos minutos. Cuenta igual." },
      { cmd: "/review", desc: "Repasa lo que ya fallaste antes." },
      { cmd: "/drill", desc: "Te pregunta, contestas hablando." },
      { cmd: "/listen", desc: "Un pasaje en audio y preguntas." },
    ],
  },
  {
    title: "Ver",
    items: [
      { cmd: "/mistakes", desc: "Tus errores activos, por frecuencia." },
      { cmd: "/vocab", desc: "El vocabulario que te ha enseñado." },
      { cmd: "/streak", desc: "Racha actual, récord y sesiones." },
    ],
  },
  {
    title: "Ajustar",
    items: [
      { cmd: "/level intermediate", desc: "beginner, intermediate o advanced." },
      { cmd: "/schedule 19:00-21:30", desc: "La franja en la que puede escribirte." },
      { cmd: "/pause", desc: "Deja de escribirte. La racha no se pierde." },
      { cmd: "/resume", desc: "Vuelve a escribirte." },
    ],
  },
] as const;

/** The real ladder from lib/srs/sm2.ts. Bar widths are the days, to scale. */
const LADDER = [
  { hits: "1er acierto", days: 1 },
  { hits: "2º", days: 3 },
  { hits: "3º", days: 7 },
  { hits: "4º", days: 15 },
  { hits: "5º", days: 30 },
  { hits: "6º", days: 60 },
] as const;

/** Staggers the thread so it writes itself once, in order, on load. */
const beat = (seconds: number): CSSProperties =>
  ({ "--delay": `${seconds}s` }) as CSSProperties;

export default function Manual() {
  return (
    <div className={styles.page}>
      <header className={styles.masthead}>
        <span className={styles.wordmark}>English Push</span>
        <a className={styles.handle} href={`https://t.me/${BOT}`}>
          @{BOT}
        </a>
      </header>

      <main>
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>Manual</p>
            <h1 className={styles.headline}>
              No espera a que estés <em>motivado</em>.
            </h1>
            <p className={styles.lede}>
              Te escribe él, dentro de la franja que le hayas dado, y apunta cada
              error que cometes para traértelo de vuelta cuando estés a punto de
              olvidarlo. Esta página es la chuleta: qué escribir y qué hace cada
              cosa.
            </p>
            <a className={styles.cta} href={`https://t.me/${BOT}`}>
              Abrir el bot en Telegram
            </a>
          </div>

          {/* The signature: the product's thesis, acted out rather than described. */}
          <div className={styles.thread} aria-label="Ejemplo de conversación">
            <div className={styles.threadBar}>
              <span className={styles.threadDot} />
              English coach
            </div>

            <div className={styles.msgBot} style={beat(0.4)}>
              <p>
                Hey — you&rsquo;ve got twenty minutes and I&rsquo;ve got a
                question. What&rsquo;s the worst bug you ever shipped?
              </p>
              <time className={styles.stamp}>20:14</time>
            </div>

            <div className={styles.msgYou} style={beat(1.5)}>
              <p>
                Last year I deploy a migration that delete half the users table
              </p>
              <time className={styles.stamp}>20:16</time>
            </div>

            <div className={styles.msgBot} style={beat(2.4)}>
              <p>
                Oof. Great story, terrible Tuesday. Did you have backups, or was
                it a very long night?
              </p>
              <time className={styles.stamp}>20:16</time>
            </div>

            <div className={styles.notes} style={beat(3.4)}>
              <p className={styles.notesTitle}>Notes · Grammar</p>
              <p className={styles.wrong}>I deploy a migration that delete</p>
              <p className={styles.right}>I deployed a migration that deleted</p>
              <p className={styles.why}>
                Past simple: both verbs need the past form, not just the first.
              </p>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.h2}>Las correcciones van aparte</h2>
          <p className={styles.prose}>
            Nunca interrumpe la conversación para corregirte. Te responde como
            respondería una persona, y la corrección llega debajo, en su propio
            bloque. Leer la charla y leer el feedback son dos actos distintos;
            mezclarlos rompe justo lo que estás entrenando. Corrige dos o tres
            cosas por turno como mucho — un mensaje lleno de rojo no enseña nada
            y quita las ganas de escribir el siguiente.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.h2}>Los cuatro modos</h2>
          <div className={styles.modes}>
            {MODES.map((mode) => (
              <article key={mode.name} className={styles.mode}>
                <p className={styles.channel}>{mode.channel}</p>
                <h3 className={styles.modeName}>{mode.name}</h3>
                <p className={styles.modeBody}>{mode.body}</p>
                <code className={styles.modeCmd}>{mode.command}</code>
              </article>
            ))}
          </div>
          <p className={styles.aside}>
            No tienes que elegir: <code>/practice</code> puntúa los cuatro y usa
            el que toque. La deuda de repaso pesa más que la variedad, y repetir
            el modo de ayer resta puntos — dos días idénticos seguidos es la
            forma más rápida de que esto se sienta una tarea.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.h2}>Comandos</h2>
          <div className={styles.groups}>
            {COMMAND_GROUPS.map((group) => (
              <div key={group.title} className={styles.group}>
                <h3 className={styles.groupTitle}>{group.title}</h3>
                <dl className={styles.list}>
                  {group.items.map((item) => (
                    <div key={item.cmd} className={styles.row}>
                      <dt className={styles.cmd}>{item.cmd}</dt>
                      <dd className={styles.desc}>{item.desc}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
          <p className={styles.aside}>
            También puedes mandarle una nota de voz sin escribir ningún comando.
            Te devuelve la transcripción de lo que entendió antes de contestar:
            si una palabra te la transcribe mal siempre igual, eso es tu
            pronunciación, no su oído.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.h2}>Cuándo vuelve cada error</h2>
          <p className={styles.prose}>
            Cada error que cometes entra en una escalera. Si lo aciertas, el
            siguiente repaso se aleja; si fallas, vuelve a mañana y pierde
            facilidad — haber sufrido con algo es justo lo que debe mantener sus
            intervalos cortos. A los seis aciertos seguidos deja de preguntártelo.
          </p>
          <div className={styles.ladder}>
            {LADDER.map((rung) => (
              <div key={rung.days} className={styles.rung}>
                <span className={styles.rungLabel}>{rung.hits}</span>
                <span
                  className={styles.rungBar}
                  style={{ width: `${(rung.days / 60) * 100}%` }}
                />
                <span className={styles.rungDays}>
                  {rung.days} {rung.days === 1 ? "día" : "días"}
                </span>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <p>
          Proyecto personal. El bot habla inglés contigo, siempre — incluso si le
          escribes en español.
        </p>
        <a href="/status">Estado del servicio</a>
      </footer>
    </div>
  );
}
