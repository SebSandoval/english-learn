/**
 * Database types, mirroring supabase/migrations/0001_init.sql.
 *
 * NOTE: table and column names are still in Spanish because the schema hasn't
 * been migrated yet. Type names, aliases and all application code are English.
 * Once the schema is renamed, this file is regenerated and the mismatch is gone:
 *   npx supabase gen types typescript --project-id <PROJECT_ID> > lib/db/types.ts
 */

export type PracticeMode =
  | "free_conversation"
  | "voice_drill"
  | "spaced_review"
  | "listening";

/** Stored values are Spanish because they're enforced by DB check constraints. */
export type Level = "principiante" | "intermedio" | "avanzado";
export type NudgeTone = "suave" | "directo" | "firme" | "celebracion";
export type SrsState = "activo" | "dominado" | "archivado";
export type MistakeType = "gramatica" | "vocabulario" | "pronunciacion" | "uso";
export type VocabType = "palabra" | "expresion" | "phrasal_verb" | "collocation";
export type SrsItemType = "error" | "vocabulario";

type Timestamptz = string;
type DateOnly = string;

export interface Database {
  public: {
    Tables: {
      usuarios: {
        Row: {
          id: string;
          telegram_chat_id: number;
          nombre: string | null;
          nivel: Level;
          zona_horaria: string;
          ventana_inicio: string;
          ventana_fin: string;
          dias_activos: number[];
          activo: boolean;
          created_at: Timestamptz;
        };
        Insert: {
          id?: string;
          telegram_chat_id: number;
          nombre?: string | null;
          nivel?: Level;
          zona_horaria?: string;
          ventana_inicio?: string;
          ventana_fin?: string;
          dias_activos?: number[];
          activo?: boolean;
          created_at?: Timestamptz;
        };
        Update: Partial<Database["public"]["Tables"]["usuarios"]["Insert"]>;
        Relationships: [];
      };

      sesiones: {
        Row: {
          id: string;
          usuario_id: string;
          modo: PracticeMode;
          origen: "telegram" | "web";
          contexto: Record<string, unknown>;
          resumen: string | null;
          completada: boolean;
          iniciada_en: Timestamptz;
          finalizada_en: Timestamptz | null;
          duracion_seg: number | null;
        };
        Insert: {
          id?: string;
          usuario_id: string;
          modo: PracticeMode;
          origen?: "telegram" | "web";
          contexto?: Record<string, unknown>;
          resumen?: string | null;
          completada?: boolean;
          iniciada_en?: Timestamptz;
          finalizada_en?: Timestamptz | null;
        };
        Update: Partial<Database["public"]["Tables"]["sesiones"]["Insert"]>;
        Relationships: [];
      };

      mensajes: {
        Row: {
          id: string;
          sesion_id: string;
          rol: "user" | "assistant";
          contenido: string;
          fue_audio: boolean;
          audio_path: string | null;
          created_at: Timestamptz;
        };
        Insert: {
          id?: string;
          sesion_id: string;
          rol: "user" | "assistant";
          contenido: string;
          fue_audio?: boolean;
          audio_path?: string | null;
          created_at?: Timestamptz;
        };
        Update: Partial<Database["public"]["Tables"]["mensajes"]["Insert"]>;
        Relationships: [];
      };

      errores: {
        Row: {
          id: string;
          usuario_id: string;
          tipo: MistakeType;
          patron: string;
          clave: string;
          ejemplo_incorrecto: string | null;
          correccion: string;
          explicacion: string | null;
          frecuencia: number;
          ultima_deteccion: Timestamptz;
          nivel_dominio: number;
          facilidad: number;
          intervalo_dias: number;
          repeticiones: number;
          proxima_revision: DateOnly;
          estado: SrsState;
          detectado_en: Timestamptz;
        };
        Insert: {
          id?: string;
          usuario_id: string;
          tipo: MistakeType;
          patron: string;
          clave: string;
          ejemplo_incorrecto?: string | null;
          correccion: string;
          explicacion?: string | null;
          frecuencia?: number;
          ultima_deteccion?: Timestamptz;
          nivel_dominio?: number;
          facilidad?: number;
          intervalo_dias?: number;
          repeticiones?: number;
          proxima_revision?: DateOnly;
          estado?: SrsState;
          detectado_en?: Timestamptz;
        };
        Update: Partial<Database["public"]["Tables"]["errores"]["Insert"]>;
        Relationships: [];
      };

      vocabulario: {
        Row: {
          id: string;
          usuario_id: string;
          termino: string;
          clave: string;
          tipo: VocabType;
          significado_es: string | null;
          ejemplo_en: string | null;
          sesion_origen: string | null;
          nivel_dominio: number;
          facilidad: number;
          intervalo_dias: number;
          repeticiones: number;
          proxima_revision: DateOnly;
          estado: SrsState;
          introducido_en: Timestamptz;
        };
        Insert: {
          id?: string;
          usuario_id: string;
          termino: string;
          clave: string;
          tipo?: VocabType;
          significado_es?: string | null;
          ejemplo_en?: string | null;
          sesion_origen?: string | null;
          nivel_dominio?: number;
          facilidad?: number;
          intervalo_dias?: number;
          repeticiones?: number;
          proxima_revision?: DateOnly;
          estado?: SrsState;
          introducido_en?: Timestamptz;
        };
        Update: Partial<Database["public"]["Tables"]["vocabulario"]["Insert"]>;
        Relationships: [];
      };

      revisiones: {
        Row: {
          id: string;
          usuario_id: string;
          item_tipo: SrsItemType;
          item_id: string;
          sesion_id: string | null;
          calidad: number;
          respondido_en: Timestamptz;
        };
        Insert: {
          id?: string;
          usuario_id: string;
          item_tipo: SrsItemType;
          item_id: string;
          sesion_id?: string | null;
          calidad: number;
          respondido_en?: Timestamptz;
        };
        Update: Partial<Database["public"]["Tables"]["revisiones"]["Insert"]>;
        Relationships: [];
      };

      racha: {
        Row: {
          usuario_id: string;
          streak_actual: number;
          streak_maximo: number;
          ultima_practica: DateOnly | null;
          total_sesiones: number;
          updated_at: Timestamptz;
        };
        Insert: {
          usuario_id: string;
          streak_actual?: number;
          streak_maximo?: number;
          ultima_practica?: DateOnly | null;
          total_sesiones?: number;
          updated_at?: Timestamptz;
        };
        Update: Partial<Database["public"]["Tables"]["racha"]["Insert"]>;
        Relationships: [];
      };

      nudges: {
        Row: {
          id: string;
          usuario_id: string;
          tono: NudgeTone;
          modo_propuesto: PracticeMode | null;
          dias_sin_practicar: number;
          mensaje: string;
          enviado_en: Timestamptz;
          respondido: boolean;
          sesion_id: string | null;
        };
        Insert: {
          id?: string;
          usuario_id: string;
          tono: NudgeTone;
          modo_propuesto?: PracticeMode | null;
          dias_sin_practicar: number;
          mensaje: string;
          enviado_en?: Timestamptz;
          respondido?: boolean;
          sesion_id?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["nudges"]["Insert"]>;
        Relationships: [];
      };
    };

    Views: {
      srs_pendientes: {
        Row: {
          id: string;
          usuario_id: string;
          item_tipo: SrsItemType;
          etiqueta: string;
          nivel_dominio: number;
          proxima_revision: DateOnly;
          peso: number;
        };
        Relationships: [];
      };
    };

    Functions: Record<string, never>;
    Enums: { modo_practica: PracticeMode };
    CompositeTypes: Record<string, never>;
  };
}

export type User = Database["public"]["Tables"]["usuarios"]["Row"];
export type Session = Database["public"]["Tables"]["sesiones"]["Row"];
export type Message = Database["public"]["Tables"]["mensajes"]["Row"];
export type Mistake = Database["public"]["Tables"]["errores"]["Row"];
export type VocabEntry = Database["public"]["Tables"]["vocabulario"]["Row"];
export type Streak = Database["public"]["Tables"]["racha"]["Row"];
export type Nudge = Database["public"]["Tables"]["nudges"]["Row"];
export type DueSrsItem = Database["public"]["Views"]["srs_pendientes"]["Row"];
