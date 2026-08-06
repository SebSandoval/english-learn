import type { Metadata } from "next";
import Link from "next/link";

import { checkHealth } from "@/lib/health";

import styles from "./status.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "English Push — estado",
  description: "Qué puede hacer el bot ahora mismo.",
};

/**
 * The human answer to "is it working?".
 *
 * Capabilities are named for what the bot does, never for the vendor behind
 * them: "Escucharte" is the thing that can be broken, Groq is an implementation
 * detail. The failing-table detail only appears when something is actually
 * wrong — a wall of green rows trains you to stop reading it.
 */
export default async function Status() {
  const report = await checkHealth();
  const down = report.capabilities.filter((c) => !c.ready);
  const brokenTables = Object.entries(report.tables).filter(([, v]) => v !== "ok");

  return (
    <div className={styles.page}>
      <header className={styles.masthead}>
        <Link className={styles.wordmark} href="/">
          English Push
        </Link>
        <span className={styles.crumb}>Estado</span>
      </header>

      <main>
        <p className={styles.eyebrow}>Ahora mismo</p>
        <h1 className={styles.headline}>
          {down.length === 0
            ? "Todo funciona."
            : down.length === 1
              ? "Una cosa no funciona."
              : `${down.length} cosas no funcionan.`}
        </h1>
        <p className={styles.lede}>
          {down.length === 0
            ? "Escríbele por Telegram y responde."
            : `Puedes seguir usándolo: ${down.map((c) => c.label.toLowerCase()).join(", ")} no está disponible.`}
        </p>

        <ul className={styles.list}>
          {report.capabilities.map((c) => (
            <li key={c.key} className={styles.item}>
              <span className={c.ready ? styles.dotOk : styles.dotDown} aria-hidden />
              <span className={styles.label}>{c.label}</span>
              <span className={styles.detail}>{c.detail}</span>
              <span className={styles.state}>{c.ready ? "Activo" : "Caído"}</span>
            </li>
          ))}
        </ul>

        {brokenTables.length > 0 && (
          <section className={styles.faults}>
            <h2 className={styles.faultsTitle}>Detalle del fallo</h2>
            {brokenTables.map(([table, message]) => (
              <p key={table} className={styles.fault}>
                <code>{table}</code> {message}
              </p>
            ))}
          </section>
        )}
      </main>

      <footer className={styles.footer}>
        <p>
          Comprobado{" "}
          <time dateTime={report.checkedAt}>
            {new Date(report.checkedAt).toLocaleString("es", {
              dateStyle: "medium",
              timeStyle: "short",
              timeZone: "America/Bogota",
            })}
          </time>{" "}
          · hora de Bogotá
        </p>
        <a href="/api/health">Ver el JSON completo</a>
      </footer>
    </div>
  );
}
