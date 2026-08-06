-- English Push — esquema inicial
-- Ejecutar en Supabase Studio → SQL Editor

create extension if not exists "pgcrypto";

-- ─────────────────────────── USUARIOS ───────────────────────────

create table usuarios (
  id               uuid primary key default gen_random_uuid(),
  telegram_chat_id bigint unique not null,
  nombre           text,
  nivel            text not null default 'intermedio'
                     check (nivel in ('principiante','intermedio','avanzado')),
  zona_horaria     text not null default 'America/Mexico_City',
  ventana_inicio   time not null default '19:00',
  ventana_fin      time not null default '21:30',
  dias_activos     smallint[] not null default '{1,2,3,4,5,6,7}',  -- ISO-8601: 1=lunes
  activo           boolean not null default true,
  created_at       timestamptz not null default now()
);

comment on column usuarios.nivel is
  'Controla el registro del inglés del tutor: el bot habla siempre en inglés, graduado por este campo.';
comment on column usuarios.dias_activos is
  'Días ISO en los que el nudge puede dispararse.';

-- ─────────────────────────── SESIONES ───────────────────────────

create type modo_practica as enum
  ('free_conversation','voice_drill','spaced_review','listening');

create table sesiones (
  id            uuid primary key default gen_random_uuid(),
  usuario_id    uuid not null references usuarios(id) on delete cascade,
  modo          modo_practica not null,
  origen        text not null default 'telegram' check (origen in ('telegram','web')),
  contexto      jsonb not null default '{}'::jsonb,
  resumen       text,
  completada    boolean not null default false,
  iniciada_en   timestamptz not null default now(),
  finalizada_en timestamptz,
  duracion_seg  int generated always as
                  (extract(epoch from (finalizada_en - iniciada_en))::int) stored
);

comment on column sesiones.contexto is
  'Estado vivo del modo: ítems SRS en curso, preguntas de listening pendientes, etc.';
comment on column sesiones.resumen is
  'Resumen generado al cerrar la sesión. Alimenta el contexto acotado de /api/chat.';

create index sesiones_usuario_fecha_idx on sesiones (usuario_id, iniciada_en desc);

-- Una sola sesión abierta por usuario: es el estado de conversación del webhook.
create unique index sesiones_una_abierta_idx
  on sesiones (usuario_id) where completada = false;

create table mensajes (
  id         uuid primary key default gen_random_uuid(),
  sesion_id  uuid not null references sesiones(id) on delete cascade,
  rol        text not null check (rol in ('user','assistant')),
  contenido  text not null,          -- texto, o la transcripción si vino en audio
  fue_audio  boolean not null default false,
  audio_path text,                   -- ruta en Supabase Storage
  created_at timestamptz not null default now()
);

create index mensajes_sesion_idx on mensajes (sesion_id, created_at);

-- ────────────────────────── SRS: ERRORES ─────────────────────────

create table errores (
  id                 uuid primary key default gen_random_uuid(),
  usuario_id         uuid not null references usuarios(id) on delete cascade,
  tipo               text not null
                       check (tipo in ('gramatica','vocabulario','pronunciacion','uso')),
  patron             text not null,   -- p.ej. "usa 'I am agree' en vez de 'I agree'"
  clave              text not null,   -- slug normalizado, para deduplicar
  ejemplo_incorrecto text,
  correccion         text not null,
  explicacion        text,
  frecuencia         int not null default 1,
  ultima_deteccion   timestamptz not null default now(),
  -- SM-2
  nivel_dominio      smallint not null default 0 check (nivel_dominio between 0 and 5),
  facilidad          numeric(4,2) not null default 2.50,
  intervalo_dias     int not null default 1,
  repeticiones       int not null default 0,
  proxima_revision   date not null default current_date,
  estado             text not null default 'activo'
                       check (estado in ('activo','dominado','archivado')),
  detectado_en       timestamptz not null default now(),
  unique (usuario_id, clave)
);

create index errores_pendientes_idx
  on errores (usuario_id, proxima_revision) where estado = 'activo';

-- ──────────────────────── SRS: VOCABULARIO ───────────────────────

create table vocabulario (
  id               uuid primary key default gen_random_uuid(),
  usuario_id       uuid not null references usuarios(id) on delete cascade,
  termino          text not null,
  clave            text not null,
  tipo             text not null default 'palabra'
                     check (tipo in ('palabra','expresion','phrasal_verb','collocation')),
  significado_es   text,
  ejemplo_en       text,
  sesion_origen    uuid references sesiones(id) on delete set null,
  -- SM-2
  nivel_dominio    smallint not null default 0 check (nivel_dominio between 0 and 5),
  facilidad        numeric(4,2) not null default 2.50,
  intervalo_dias   int not null default 1,
  repeticiones     int not null default 0,
  proxima_revision date not null default current_date,
  estado           text not null default 'activo'
                     check (estado in ('activo','dominado','archivado')),
  introducido_en   timestamptz not null default now(),
  unique (usuario_id, clave)
);

create index vocabulario_pendientes_idx
  on vocabulario (usuario_id, proxima_revision) where estado = 'activo';

-- Cola unificada de repaso: el motor SRS consume solo esta vista y no
-- necesita saber si repasa un error o una palabra nueva.
create view srs_pendientes as
  select id, usuario_id, 'error'::text as item_tipo, patron as etiqueta,
         nivel_dominio, proxima_revision, frecuencia as peso
    from errores
   where estado = 'activo'
  union all
  select id, usuario_id, 'vocabulario'::text, termino,
         nivel_dominio, proxima_revision, 1
    from vocabulario
   where estado = 'activo';

create table revisiones (
  id            uuid primary key default gen_random_uuid(),
  usuario_id    uuid not null references usuarios(id) on delete cascade,
  item_tipo     text not null check (item_tipo in ('error','vocabulario')),
  item_id       uuid not null,
  sesion_id     uuid references sesiones(id) on delete set null,
  calidad       smallint not null check (calidad between 0 and 5),  -- q de SM-2
  respondido_en timestamptz not null default now()
);

create index revisiones_usuario_idx on revisiones (usuario_id, respondido_en desc);

-- ───────────────────────── ENGAGEMENT ────────────────────────────

create table racha (
  usuario_id      uuid primary key references usuarios(id) on delete cascade,
  streak_actual   int not null default 0,
  streak_maximo   int not null default 0,
  ultima_practica date,
  total_sesiones  int not null default 0,
  updated_at      timestamptz not null default now()
);

create table nudges (
  id                 uuid primary key default gen_random_uuid(),
  usuario_id         uuid not null references usuarios(id) on delete cascade,
  tono               text not null
                       check (tono in ('suave','directo','firme','celebracion')),
  modo_propuesto     modo_practica,
  dias_sin_practicar int not null,
  mensaje            text not null,
  enviado_en         timestamptz not null default now(),
  respondido         boolean not null default false,
  sesion_id          uuid references sesiones(id) on delete set null
);

create index nudges_usuario_idx on nudges (usuario_id, enviado_en desc);

-- ─────────────────────────── RLS ─────────────────────────────────
-- El backend accede con la secret key (bypasea RLS). Activamos RLS sin
-- políticas = deny-all, para que la publishable key nunca lea nada si algún
-- día se agrega un frontend.

alter table usuarios    enable row level security;
alter table sesiones    enable row level security;
alter table mensajes    enable row level security;
alter table errores     enable row level security;
alter table vocabulario enable row level security;
alter table revisiones  enable row level security;
alter table racha       enable row level security;
alter table nudges      enable row level security;
