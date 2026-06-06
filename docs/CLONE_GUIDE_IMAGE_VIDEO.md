# AI Studio Clone — Image & Video Generation

> **Comment utiliser ce document.**
> Ce fichier est un tutoriel **complet et autonome** pour répliquer un SaaS de génération d'images et de vidéos IA (style Higgsfield / Midjourney). Tu peux soit :
>
> 1. **Le suivre à la main** : chaque étape est expliquée, copie-colle le code dans tes propres fichiers.
> 2. **Le donner à une IA** (Claude / Cursor / Windsurf / ChatGPT) : dépose ce fichier dans un projet AI ou un chat et demande "Recrée ce projet en suivant ce tutoriel" — l'IA aura tout ce qu'il faut (architecture, deps, schéma BDD, code source verbatim, env vars, deploy).
>
> **Pré-requis pour terminer en moins de 2h** : compte GitHub, compte Vercel (gratuit), compte Supabase (gratuit), compte KIE.ai (~5$ pour tester), Node.js 20+ installé localement, un éditeur de code (VS Code, Cursor, etc.).

---

## Table des matières

1. [Aperçu du produit](#1-aperçu-du-produit)
2. [Architecture technique](#2-architecture-technique)
3. [Stack & dépendances](#3-stack--dépendances)
4. [Étape 1 — Créer le projet local](#4-étape-1--créer-le-projet-local)
5. [Étape 2 — Configurer Supabase (BDD + stockage)](#5-étape-2--configurer-supabase-bdd--stockage)
6. [Étape 3 — Configurer KIE.ai (les modèles IA)](#6-étape-3--configurer-kieai-les-modèles-ia)
7. [Étape 4 — Variables d'environnement](#7-étape-4--variables-denvironnement)
8. [Étape 5 — Structure du projet](#8-étape-5--structure-du-projet)
9. [Code source complet](#9-code-source-complet)
   - 9.1. [Fichiers de config racine](#91-fichiers-de-config-racine)
   - 9.2. [App layout & styles](#92-app-layout--styles)
   - 9.3. [Lib (helpers réutilisables)](#93-lib-helpers-réutilisables)
   - 9.4. [API routes](#94-api-routes)
   - 9.5. [Components UI](#95-components-ui)
   - 9.6. [Pages](#96-pages)
10. [Étape 6 — Lancer en local](#10-étape-6--lancer-en-local)
11. [Étape 7 — Déployer sur Vercel](#11-étape-7--déployer-sur-vercel)
12. [Checklist de test](#12-checklist-de-test)
13. [Personnalisation (ajouter un modèle, changer la marque)](#13-personnalisation)
14. [Troubleshooting (erreurs fréquentes)](#14-troubleshooting)

---

## 1. Aperçu du produit

Ce SaaS expose deux fonctionnalités principales, chacune sur sa page :

### `/` — Image Generation

Génère des images IA depuis un prompt texte (text-to-image) ou un prompt + image(s) de référence (image-to-image).

- **5 modèles** au choix : Nano Banana Pro (Google Gemini 3), Nano Banana, GPT Image 2 (OpenAI), Seedream 4.5 (ByteDance), Wan 2.7 Pro (Alibaba)
- **Aspect ratios** variables par modèle (1:1, 9:16, 16:9, 21:9, etc.)
- **Qualités** : 1K / 2K / 4K
- **Jusqu'à 20 images en parallèle** par génération
- **Images de référence** (i2i) sur les modèles compatibles
- **Galerie persistante** avec aperçu plein écran + téléchargement

### `/video` — Video Creation

Génère des vidéos IA à partir d'une image de départ (image-to-video) :

- **Modèle** : Kling 3.0 (image-to-video, single shot 3-15s)
- **Start frame** obligatoire + **End frame** optionnel (interpolation entre les deux)
- **Qualités** : 720p / 1080p / 4K
- **Aspect ratios** : 9:16 / 16:9 / 1:1
- **Sound on/off** (avec un premium tarifaire)
- **Galerie persistante**

### UX commune

- **Dark theme** moderne (couleur accent jaune-vert lime `#d4ff3a`)
- **Galerie** : grille responsive, hover-play sur les vidéos, click pour ouvrir en grand
- **Prompt bar fixe en bas** (image) ou **panneau latéral** (vidéo) avec sélecteurs visuels
- **Polling automatique** des jobs en cours, status badge "en cours / done / failed"
- **Persistance** : les résultats sont stockés dans Supabase Storage (au lieu des URLs KIE temporaires)
- **Optimistic UI** : placeholders affichés immédiatement avant le retour serveur

---

## 2. Architecture technique

```
┌──────────────┐         ┌─────────────────┐         ┌──────────────┐
│   Browser    │ ──────► │  Next.js (Vercel)│ ──────► │   KIE.ai    │
│  (React 19)  │         │  - API routes   │         │ (génère     │
│              │ ◄────── │  - SSR pages    │ ◄────── │  l'asset)   │
└──────────────┘         └────────┬────────┘         └──────────────┘
       ▲                          │
       │                          ▼
       │                 ┌─────────────────┐
       │                 │    Supabase     │
       │                 │  - Postgres DB  │
       │                 │    (batches,    │
       │                 │     items)      │
       │                 │  - Storage      │
       │                 │    (uploads,    │
       │                 │     archives)   │
       └─────────────────┴─────────────────┘
```

**Flux de génération d'image** :

1. Le navigateur POST `/api/generate/run` avec `{ prompt, modelKey, aspectRatio, quality, count, inputUrls }`
2. Le serveur Next.js crée une ligne `batches` + N lignes `items` dans Postgres
3. Pour chaque item, soumission d'un task à `https://api.kie.ai/api/v1/jobs/createTask` → reçoit un `taskId`
4. Le navigateur poll `/api/batch/{id}/status` toutes les 4s
5. Le serveur poll KIE pour chaque `taskId` en attente. Quand un task est `success`, l'URL résultante est téléchargée et **archivée dans Supabase Storage** (les URLs KIE expirent en ~24h)
6. Le navigateur affiche les images dès qu'elles arrivent

**Flux de génération vidéo** :

Idem, mais avec :
- `/api/video/create` au lieu de `/api/generate/run`
- L'image de départ (et de fin optionnelle) est **re-hostée** sur le CDN whitelisté de KIE (`kieai.redpandaai.co`) car Kling refuse les URLs Supabase brutes
- Polling plus lent (6s) car les vidéos prennent 3-15min à générer

---

## 3. Stack & dépendances

| Couche | Tech | Version |
|---|---|---|
| Framework | Next.js (App Router) | 16.2.6 |
| UI | React | 19.2.4 |
| Styling | Tailwind CSS v4 (PostCSS plugin) | ^4 |
| Icônes | lucide-react | ^1.17.0 |
| BDD + Storage | Supabase (`@supabase/ssr`, `@supabase/supabase-js`) | ^0.10.3 / ^2.106.2 |
| Image processing serveur | sharp | ^0.34.0 |
| Modèles IA | KIE.ai (REST API) | — |
| Hébergement | Vercel (Pro recommandé pour `maxDuration=60s`) | — |
| Langage | TypeScript strict | ^5 |

**Note** : tu n'as **pas besoin** de :
- ❌ Anthropic SDK (uniquement utilisé pour des features avancées non incluses ici)
- ❌ HuggingFace Transformers (uniquement pour la transcription audio, non incluse)
- ❌ ElevenLabs (uniquement pour les voix off, non incluse)

---

## 4. Étape 1 — Créer le projet local

### 4.1. Pré-requis machine

Installe :
- **Node.js 20+** (vérifie avec `node -v`) — [nodejs.org](https://nodejs.org)
- **npm** (livré avec Node) ou **pnpm** (`npm i -g pnpm`)
- **git** (vérifie avec `git --version`)

### 4.2. Création du projet Next.js

Dans un dossier de travail (`~/Code/` par exemple — **évite iCloud Drive / Dropbox** sinon Git aura des erreurs `mmap`), lance :

```bash
npx create-next-app@16 ai-studio --typescript --tailwind --app --src-dir --turbopack=false
cd ai-studio
```

Réponses recommandées au prompt interactif :
- ESLint : **Yes**
- Tailwind CSS : **Yes**
- `src/` directory : **Yes**
- App Router : **Yes**
- Turbopack : **No** (use Webpack)
- Alias `@/*` : **Yes** (défaut)

### 4.3. Installer les dépendances supplémentaires

```bash
npm install @supabase/ssr @supabase/supabase-js lucide-react sharp
```

### 4.4. Vérifie que ça démarre

```bash
npm run dev
```

Ouvre [http://localhost:3000](http://localhost:3000) — tu dois voir la page d'accueil Next par défaut. Maintenant on va la remplacer.

### 4.5. Initialiser le repo Git

```bash
git init
git add -A
git commit -m "Initial Next.js scaffold"
```

---

## 5. Étape 2 — Configurer Supabase (BDD + stockage)

Supabase héberge gratuitement :
- Une base Postgres (500MB)
- Un stockage objet (1GB) — pour les images uploads + les images/vidéos générées qu'on archive

### 5.1. Créer le projet Supabase

1. Va sur [supabase.com](https://supabase.com) → **Sign up** (gratuit, via GitHub)
2. **New project** :
   - Nom : `ai-studio` (n'importe quoi)
   - Région : la plus proche de toi (**Europe West (London)** pour la France)
   - Password DB : génère-en un fort et **note-le quelque part**, tu n'en auras pas besoin pour ce SaaS mais Supabase te le demande
   - Plan : **Free**
3. Attends ~2 minutes la création
4. Une fois ouvert, clique sur l'icône **Settings** (⚙️) → **API**. Note :
   - `Project URL` (commence par `https://xxx.supabase.co`)
   - `anon public` (clé publique)
   - `service_role secret` (clé serveur — **garde-la secrète**)

### 5.2. Créer les tables BDD

Va dans **SQL Editor** (icône `</>` à gauche) → **New query**, colle ce SQL et clique **Run** :

```sql
-- batches: un batch = un groupe de générations lancées ensemble.
-- meta_json contient les paramètres (prompt, modèle, ratio…) pour
-- les afficher en hover dans la galerie sans avoir à les requêter.
create table public.batches (
  batch_id     text primary key,
  kind         text not null,                  -- 'image_gen' | 'video_create'
  model        text not null,                  -- modelKey, ex. 'nano-banana-pro'
  status       text not null default 'running',-- 'running' | 'completed' | 'failed'
  cost_usd     numeric default 0,              -- coût estimé pour le batch entier
  meta_json    jsonb default '{}'::jsonb,      -- snapshot des inputs utilisateur
  created_at   timestamptz not null default now(),
  updated_at   timestamptz default now()
);

create index batches_kind_created_idx
  on public.batches (kind, created_at desc);

-- items: une génération individuelle. Un batch en a 1 à 20.
-- kie_task_id est l'id du job KIE qu'on poll.
create table public.items (
  item_id      text primary key,
  batch_id     text not null references public.batches(batch_id) on delete cascade,
  idx          int default 0,                  -- ordre dans le batch (pour le tri UI)
  status       text not null default 'queued', -- 'queued' | 'processing' | 'done' | 'failed' | 'cancelled'
  input_url    text,                           -- (image gen i2i) première image de réf
  output_url   text,                           -- URL finale (Supabase Storage après archive)
  error        text,                           -- message d'erreur si status='failed'
  kie_task_id  text,                           -- id retourné par KIE.ai
  started_at   timestamptz default now(),
  ended_at     timestamptz
);

create index items_batch_idx     on public.items (batch_id);
create index items_status_idx    on public.items (status);
create index items_ended_at_idx  on public.items (ended_at desc nulls last);

-- IMPORTANT: pas de Row Level Security activée — on accède toujours
-- côté serveur avec la service_role key. Si tu ajoutes plus tard un
-- système d'auth multi-utilisateur, active RLS sur les deux tables.
```

Tu dois voir "Success. No rows returned" en bas.

### 5.3. Créer les buckets de stockage

Va dans **Storage** (icône ☁️) → **New bucket** :

1. **Bucket 1** :
   - Nom : `pixelforge-uploads`
   - Public bucket : ✅ (yes, public)
   - Click **Save**
2. **Bucket 2** :
   - Nom : `pixelforge-images`
   - Public bucket : ✅
   - Click **Save**
3. **Bucket 3** :
   - Nom : `pixelforge-videos`
   - Public bucket : ✅
   - Click **Save**

> **Pourquoi 3 buckets ?**
> - `pixelforge-uploads` : images uploadées par l'utilisateur (références pour i2i, frames de départ pour vidéo)
> - `pixelforge-images` : images générées par KIE qu'on a archivées pour qu'elles restent dispo
> - `pixelforge-videos` : pareil pour les vidéos

**Optionnel mais recommandé** : ajoute une policy de retention pour purger les vieux fichiers (Storage → Policies → "Expire after X days").

---

## 6. Étape 3 — Configurer KIE.ai (les modèles IA)

KIE.ai est une API unifiée qui donne accès à 100+ modèles d'IA (Gemini, OpenAI, Kling, ByteDance…) avec une facturation au crédit. Beaucoup plus simple que de signer un contrat avec chaque vendeur.

### 6.1. Créer le compte

1. Va sur [kie.ai](https://kie.ai) → **Sign up** (GitHub OK)
2. Une fois loggé, va sur **Billing** → **Top up** :
   - Recharge **5$ minimum** pour tester (les 5 modèles d'image coûtent entre 0.02$ et 0.16$ par image, donc tu peux tester ~30-50 générations)
   - Recharge **20$+** si tu veux tester la vidéo (Kling 3.0 1080p = 0.135$/s × 5s = 0.68$ par vidéo)
3. Va dans **API Keys** → **Create new key** → copie la clé (commence par `sk-...`)

### 6.2. Vérifier les modèles disponibles

Tous les modèles utilisés par ce projet sont déjà dispo sur KIE :

- `nano-banana-pro` (Google) — recommandé par défaut
- `google/nano-banana` (Google, version moins chère)
- `gpt-image-2-text-to-image` + `gpt-image-2-image-to-image` (OpenAI)
- `seedream/4.5-text-to-image` (ByteDance)
- `wan/2-7-image-pro` (Alibaba)
- `kling-3.0/video` (Kling 3.0, image-to-video)

Tu peux confirmer leur dispo dans [kie.ai/models](https://kie.ai/models).

---

## 7. Étape 4 — Variables d'environnement

Crée un fichier `.env.local` à la racine de ton projet (au même niveau que `package.json`) :

```bash
# === Supabase (depuis Settings → API dans le dashboard Supabase) ===
NEXT_PUBLIC_SUPABASE_URL=https://xxxxxxxxxxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi... # clé "anon public"
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...    # clé "service_role secret" — SECRET, jamais commit

# === KIE.ai (depuis API Keys dans le dashboard KIE) ===
KIE_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**Important** :
- `NEXT_PUBLIC_*` sont exposées au navigateur (OK pour Supabase anon + URL)
- `SUPABASE_SERVICE_ROLE_KEY` et `KIE_API_KEY` sont **serveur-only** — elles n'apparaissent jamais dans le bundle client
- Le fichier `.env.local` doit être dans `.gitignore` (Next l'y met par défaut)

Vérifie avec :

```bash
cat .gitignore | grep .env
```

Tu dois voir au moins `.env*.local`.

---

## 8. Étape 5 — Structure du projet

Voici l'arborescence finale du `src/` que tu vas créer :

```
src/
├── app/
│   ├── layout.tsx                                # Layout racine + TopNav
│   ├── page.tsx                                  # / — Image generation
│   ├── globals.css                               # Tokens design (dark theme)
│   │
│   ├── video/
│   │   └── page.tsx                              # /video — Video generation
│   │
│   └── api/
│       ├── generate/
│       │   └── run/
│       │       └── route.ts                      # POST: soumettre génération d'image(s)
│       ├── video/
│       │   └── create/
│       │       └── route.ts                      # POST: soumettre génération vidéo
│       ├── batch/
│       │   └── [id]/
│       │       └── status/
│       │           └── route.ts                  # GET: poll d'un batch + archive Storage
│       ├── item/
│       │   └── [id]/
│       │       └── cancel/
│       │           └── route.ts                  # POST: marquer un item comme cancelled
│       ├── items/
│       │   └── recent/
│       │       └── route.ts                      # GET: liste les items récents
│       ├── upload/
│       │   └── route.ts                          # POST: upload multipart vers Supabase Storage
│       ├── models/
│       │   └── route.ts                          # GET: dump du registry des modèles
│       └── health/
│           └── route.ts                          # GET: ping + statut des clés env
│
├── components/
│   ├── TopNav.tsx                                # Header sticky (logo + nav)
│   ├── HomeStudio.tsx                            # UI page image (galerie + PromptBar)
│   ├── CreateVideoStudio.tsx                     # UI page vidéo (frames + settings + galerie)
│   ├── PromptBar.tsx                             # Barre de prompt flottante avec selectors
│   ├── Gallery.tsx                               # Grille responsive des résultats
│   ├── ImagePreviewModal.tsx                     # Modal plein écran avec download
│   ├── RatioIcon.tsx                             # Icône SVG d'aspect ratio
│   └── ModelCard.tsx                             # Header de page (titre + lede) + helpers
│
└── lib/
    ├── env.ts                                    # Lecture validée des env vars
    ├── kie.ts                                    # Client REST KIE.ai
    ├── models.ts                                 # Registry des modèles (prix, ratios, qualités)
    ├── buildKieInput.ts                          # Construit l'input KIE par modèle
    └── supabase/
        ├── admin.ts                              # Client serveur (service_role)
        ├── client.ts                             # Client navigateur (anon)
        └── server.ts                             # Client SSR (anon + cookies)
```

**À la racine du projet** :

```
ai-studio/
├── package.json
├── next.config.ts
├── tsconfig.json
├── postcss.config.mjs
├── .env.local                                    # ⚠️ Ne pas commiter
├── .gitignore
└── src/                                          # ↑ voir au-dessus
```

---

## 9. Code source complet

Crée chaque fichier ci-dessous **exactement** à l'emplacement indiqué, avec le contenu fourni.

### 9.1. Fichiers de config racine

#### `package.json`

```json
{
  "name": "ai-studio",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev --webpack",
    "build": "next build",
    "start": "next start",
    "lint": "eslint"
  },
  "dependencies": {
    "@supabase/ssr": "^0.10.3",
    "@supabase/supabase-js": "^2.106.2",
    "lucide-react": "^1.17.0",
    "next": "16.2.6",
    "react": "19.2.4",
    "react-dom": "19.2.4",
    "sharp": "^0.34.0"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4",
    "@types/node": "^20",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "eslint": "^9",
    "eslint-config-next": "16.2.6",
    "tailwindcss": "^4",
    "typescript": "^5"
  }
}
```

> Si `create-next-app` t'a généré un package.json différent, **remplace les versions** par celles ci-dessus puis fais `npm install` à nouveau pour vérifier qu'elles s'installent. Next 16 + React 19 sont des versions modernes — si tu veux Next 15 / React 18, adapte (mais certaines APIs `await params` changent).

#### `next.config.ts`

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // sharp ships native bindings (libvips) qui ne doivent pas être bundlées
  // par Webpack — sinon le build Vercel échoue avec "Cannot find module".
  serverExternalPackages: ["sharp"],
};

export default nextConfig;
```

#### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

#### `postcss.config.mjs`

```javascript
export default {
  plugins: { "@tailwindcss/postcss": {} },
};
```

#### `.gitignore` (ajoute si manquant)

```gitignore
node_modules/
.next/
.env*.local
.vercel
*.log
.DS_Store
```

---

### 9.2. App layout & styles

#### `src/app/globals.css`

Design tokens (couleurs, polices) — tout le SaaS utilise ces variables. Tailwind v4 expose chaque `--color-pf-*` comme classe utilitaire (`bg-pf-bg`, `text-pf-accent`, etc.).

```css
@import "tailwindcss";

@theme {
  --color-pf-bg: #0a0a0a;
  --color-pf-elev: #141414;
  --color-pf-soft: #1c1c1c;
  --color-pf-border: #2a2a2a;
  --color-pf-text: #f5f5f5;
  --color-pf-dim: #a4a4a4;
  --color-pf-muted: #6a6a6a;
  --color-pf-accent: #d4ff3a;
  --color-pf-accent-fg: #0a0a0a;
  --color-pf-ok: #4cd964;
  --color-pf-warn: #ffb84c;
  --color-pf-danger: #ff5a5a;

  --font-sans: var(--font-geist-sans), -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif;
  --font-mono: var(--font-geist-mono), ui-monospace, "SF Mono", monospace;
}

html, body {
  background: var(--color-pf-bg);
  color: var(--color-pf-text);
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.5;
}

* {
  box-sizing: border-box;
}

a {
  color: var(--color-pf-accent);
  text-decoration: none;
}

/* Scrollbar fin assorti au dark theme */
*::-webkit-scrollbar { width: 8px; height: 8px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb { background: var(--color-pf-border); border-radius: 4px; }
*::-webkit-scrollbar-thumb:hover { background: #3a3a3a; }
```

#### `src/app/layout.tsx`

Layout racine — wrap toutes les pages dans `<html>` + `<body>` + `<TopNav />`.

```typescript
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { TopNav } from "@/components/TopNav";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AI Studio",
  description: "AI image & video studio powered by KIE.ai",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
      <body className="bg-pf-bg text-pf-text min-h-screen flex flex-col">
        <TopNav />
        <main className="flex-1 px-8 py-7 pb-48 max-w-[1600px] w-full mx-auto">
          {children}
        </main>
      </body>
    </html>
  );
}
```

---

### 9.3. Lib (helpers réutilisables)

#### `src/lib/env.ts`

```typescript
// Server-side env access avec validation. Throw clair quand un truc manque
// pour que les routes API plantent fort en dev au lieu de retourner un 500
// silencieux en prod.

function readRequired(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function readOptional(name: string): string | null {
  return process.env[name] || null;
}

export const env = {
  // Public (frontend-safe)
  supabaseUrl: readRequired("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseAnonKey: readRequired("NEXT_PUBLIC_SUPABASE_ANON_KEY"),

  // Server-only secrets
  kieApiKey: readOptional("KIE_API_KEY"),
  supabaseServiceRoleKey: readOptional("SUPABASE_SERVICE_ROLE_KEY"),
};

// Helper pour /api/health — ne throw jamais, juste reporte la présence.
export function readKeyStatus() {
  return {
    kie: Boolean(process.env.KIE_API_KEY),
    supabaseUrl: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    supabaseAnon: Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    supabaseServiceRole: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  };
}
```

#### `src/lib/supabase/admin.ts`

```typescript
// Server-only Supabase client utilisant la service_role key (bypass RLS).
// À utiliser depuis les Route Handlers quand l'op ne doit pas être limitée
// par des policies RLS (écriture batches/items, upload Storage…).
// NE JAMAIS importer depuis un component client.

import { createClient } from "@supabase/supabase-js";

export function createSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase admin client requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
```

#### `src/lib/supabase/client.ts`

```typescript
"use client";

import { createBrowserClient } from "@supabase/ssr";

export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
```

#### `src/lib/supabase/server.ts`

```typescript
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Server-side Supabase client honoring user session cookies.
// À utiliser depuis Route Handlers + Server Components.
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server component — cookies immutables. No-op.
          }
        },
      },
    },
  );
}
```

#### `src/lib/kie.ts`

Le client REST principal de KIE.ai. Gère la soumission de tasks, le polling, l'extraction des URLs résultantes (différents formats selon le modèle), et le re-hosting d'images pour les modèles vidéo qui exigent un CDN whitelisté.

```typescript
// KIE.ai REST client. Server-only. Lit KIE_API_KEY au moment de l'appel.

const API_BASE = "https://api.kie.ai";
const UPLOAD_BASE = "https://kieai.redpandaai.co";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class KieError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KieError";
  }
}
export class KieAuthError extends KieError {
  constructor(message: string) {
    super(message);
    this.name = "KieAuthError";
  }
}
export class KieNoCreditsError extends KieError {
  constructor(message: string) {
    super(message);
    this.name = "KieNoCreditsError";
  }
}
export class KieTaskFailed extends KieError {
  constructor(message: string) {
    super(message);
    this.name = "KieTaskFailed";
  }
}

function requireKey(): string {
  const k = process.env.KIE_API_KEY;
  if (!k) throw new KieAuthError("KIE_API_KEY env var is not set on the server.");
  return k;
}

function authHeader() {
  return { Authorization: `Bearer ${requireKey()}` };
}

async function handleResponse(r: Response): Promise<Record<string, unknown>> {
  if (r.status === 401 || r.status === 403) {
    throw new KieAuthError(
      `KIE.ai authentication failed (HTTP ${r.status}). Check the API key.`,
    );
  }
  const bodyText = await r.text();
  const lower = bodyText.toLowerCase();
  if (r.status === 402 || lower.includes("insufficient credits") || lower.includes("no credits")) {
    throw new KieNoCreditsError("KIE.ai is out of credits. Top up at https://kie.ai/billing.");
  }
  if (!r.ok) {
    throw new KieError(`KIE.ai HTTP ${r.status}: ${bodyText.slice(0, 400)}`);
  }
  try {
    return JSON.parse(bodyText);
  } catch {
    throw new KieError(`KIE.ai returned non-JSON: ${bodyText.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Submit / poll
// ---------------------------------------------------------------------------

export type SubmitOptions = {
  useVeoEndpoint?: boolean;
};

export async function submitTask(
  model: string,
  inputs: Record<string, unknown>,
  opts: SubmitOptions = {},
): Promise<string> {
  const url = opts.useVeoEndpoint
    ? `${API_BASE}/api/v1/veo/generate`
    : `${API_BASE}/api/v1/jobs/createTask`;
  const payload = opts.useVeoEndpoint ? { model, ...inputs } : { model, input: inputs };

  const r = await fetch(url, {
    method: "POST",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await handleResponse(r);
  const taskId =
    (data.data as { taskId?: string } | undefined)?.taskId ?? (data.taskId as string | undefined);
  if (!taskId) throw new KieError(`No taskId in KIE response: ${JSON.stringify(data).slice(0, 300)}`);
  return String(taskId);
}

export async function fetchTask(taskId: string): Promise<Record<string, unknown>> {
  const url = `${API_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`;
  const r = await fetch(url, { headers: authHeader() });
  const data = await handleResponse(r);
  return (data.data as Record<string, unknown>) || {};
}

export function normalizeState(record: Record<string, unknown>): "success" | "fail" | "processing" {
  const stateRaw = record.state;
  if (typeof stateRaw === "string") {
    const s = stateRaw.toLowerCase();
    if (["success", "completed", "succeeded"].includes(s)) return "success";
    if (["fail", "failed", "error"].includes(s)) return "fail";
    return "processing";
  }
  const flag = record.successFlag;
  if (flag === 1) return "success";
  if (flag === 2 || flag === 3) return "fail";
  return "processing";
}

export function extractResultUrls(record: Record<string, unknown>): string[] {
  const urls: string[] = [];

  // 1. resultJson as JSON-encoded string (Kling, Sora, Topaz, gpt-image-2)
  let parsed: Record<string, unknown> = {};
  const rj = record.resultJson;
  if (typeof rj === "string" && rj) {
    try {
      parsed = JSON.parse(rj);
    } catch {
      parsed = {};
    }
  } else if (rj && typeof rj === "object") {
    parsed = rj as Record<string, unknown>;
  }
  for (const key of ["resultUrls", "urls", "videos", "images"]) {
    const v = parsed[key];
    if (Array.isArray(v)) urls.push(...(v as unknown[]).filter(Boolean).map(String));
    else if (typeof v === "string" && v) urls.push(v);
  }

  // 2. resultUrls directly on record (or nested in response)
  const candidates: Array<Record<string, unknown> | undefined> = [
    record,
    (record.response as Record<string, unknown>) || undefined,
  ];
  for (const container of candidates) {
    if (!container) continue;
    const res = container.resultUrls;
    if (Array.isArray(res)) urls.push(...(res as unknown[]).filter(Boolean).map(String));
    else if (typeof res === "string" && res) urls.push(res);
  }

  // 3. Single-URL shortcuts (Veo)
  for (const k of ["videoUrl", "imageUrl", "resultUrl"]) {
    const v = record[k];
    if (typeof v === "string" && v) urls.push(v);
  }

  return Array.from(new Set(urls));
}

// ---------------------------------------------------------------------------
// File upload (multipart). Sur Vercel, gros fichiers → Supabase direct depuis
// le client. Cette fonction sert pour les cas serveur (re-hosting d'images).
// ---------------------------------------------------------------------------

export async function uploadFile(
  file: Blob,
  filename: string,
  uploadPath = "user-uploads",
): Promise<string> {
  const form = new FormData();
  form.append("file", file, filename);
  form.append("uploadPath", uploadPath);
  const r = await fetch(`${UPLOAD_BASE}/api/file-stream-upload`, {
    method: "POST",
    headers: authHeader(),
    body: form,
  });
  const data = await handleResponse(r);
  const downloadUrl =
    (data.data as { downloadUrl?: string; fileUrl?: string } | undefined)?.downloadUrl ??
    (data.data as { fileUrl?: string } | undefined)?.fileUrl ??
    (data.downloadUrl as string | undefined);
  if (!downloadUrl)
    throw new KieError(`No downloadUrl in KIE upload response: ${JSON.stringify(data).slice(0, 300)}`);
  return String(downloadUrl);
}

/**
 * Re-uploade une image depuis n'importe quelle URL publique vers le CDN
 * whitelisté de KIE. Indispensable pour Kling vidéo qui refuse les URLs
 * Supabase brutes.
 *
 * Pour les images, on re-encode en JPEG via sharp (rotation EXIF + cap
 * 2048px + qualité 92) pour éviter les fichiers mal taggés (WebP renommé
 * en .png, etc.) qui crashent le decoder Kling.
 */
export async function rehostToKie(sourceUrl: string, uploadPath = "user-frames"): Promise<string> {
  const resp = await fetch(sourceUrl);
  if (!resp.ok) {
    throw new KieError(`Failed to fetch source URL ${sourceUrl}: HTTP ${resp.status}`);
  }
  const contentType = resp.headers.get("content-type") || "";

  // Audio: passthrough
  if (contentType.startsWith("audio/")) {
    const blob = await resp.blob();
    let filename = "audio.bin";
    if (contentType.includes("mpeg") || contentType.includes("mp3")) filename = "audio.mp3";
    else if (contentType.includes("wav")) filename = "audio.wav";
    return uploadFile(blob, filename, uploadPath);
  }

  // Video: passthrough
  if (contentType.startsWith("video/")) {
    const blob = await resp.blob();
    let filename = "video.mp4";
    if (contentType.includes("quicktime")) filename = "video.mov";
    else if (contentType.includes("webm")) filename = "video.webm";
    return uploadFile(blob, filename, uploadPath);
  }

  // Images: normalize via sharp en JPEG propre
  const buf = Buffer.from(await resp.arrayBuffer());
  try {
    const sharpMod = (await import("sharp")).default;
    const out = await sharpMod(buf)
      .rotate()
      .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();
    return uploadFile(new Blob([new Uint8Array(out)], { type: "image/jpeg" }), "frame.jpg", uploadPath);
  } catch (e) {
    console.error("rehostToKie: sharp re-encode failed, passing through original", e);
    const blob = new Blob([new Uint8Array(buf)], { type: contentType || "application/octet-stream" });
    return uploadFile(blob, "frame.bin", uploadPath);
  }
}
```

#### `src/lib/models.ts`

Registry de tous les modèles avec leurs prix, aspect ratios, qualités, et conventions de naming spécifiques à chaque vendeur. **Source de vérité unique** : les pages, la PromptBar, et les API routes tirent toutes leur config d'ici.

```typescript
// Registry des modèles KIE.ai exposés par le SaaS.

export type ImageModel = {
  label: string;
  vendor: string;
  kieModelT2I: string | null;
  kieModelI2I: string | null;
  supports: Array<"t2i" | "i2i" | "edit">;
  aspectRatios: string[];
  qualities: string[];
  qualityParam: "resolution" | "quality" | "none";
  qualityMap?: Record<string, string>;
  pricing: Record<string, number>;
  defaultPricePerImage: number;
  pricingNote?: string;
  maxInputImages: number;
  notes: string;
  badge?: "TOP" | "NEW" | "SOON";
};

export type VideoCreateQuality = {
  label: string;
  displayLabel: string;
  resolution: string;
  kieMode: string;
  pricePerSecondNoAudio: number;
  pricePerSecondWithAudio: number;
};

export type VideoCreateModel = {
  label: string;
  vendor: string;
  kieModel: string;
  aspectRatios: string[];
  durations: number[];
  qualities: VideoCreateQuality[];
  supportsEndFrame: boolean;
  supportsSound: boolean;
  pricingNote?: string;
  badge?: "TOP" | "NEW" | "SOON" | "PREMIUM";
  notes: string;
};

export function priceForQuality(model: ImageModel, quality: string): number {
  return model.pricing[quality] ?? model.defaultPricePerImage;
}

export const IMAGE_MODELS: Record<string, ImageModel> = {
  "nano-banana-pro": {
    label: "Nano Banana Pro",
    vendor: "Google (Gemini 3 Pro Image)",
    kieModelT2I: "nano-banana-pro",
    kieModelI2I: "nano-banana-pro",
    supports: ["t2i", "i2i"],
    aspectRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "auto"],
    qualities: ["1K", "2K", "4K"],
    qualityParam: "resolution",
    pricing: { "1K": 0.09, "2K": 0.09, "4K": 0.12 },
    defaultPricePerImage: 0.09,
    maxInputImages: 8,
    notes: "Meilleur modèle 4K. Rendu de texte dans l'image excellent.",
    badge: "TOP",
  },
  "nano-banana": {
    label: "Nano Banana",
    vendor: "Google (Gemini 2.x Image)",
    kieModelT2I: "google/nano-banana",
    kieModelI2I: "google/nano-banana",
    supports: ["t2i", "i2i"],
    aspectRatios: ["1:1", "9:16", "16:9", "4:3", "3:4"],
    qualities: ["1K", "2K"],
    qualityParam: "resolution",
    pricing: { "1K": 0.02, "2K": 0.039 },
    defaultPricePerImage: 0.039,
    pricingNote: "Estimated",
    maxInputImages: 3,
    notes: "Version rapide & moins chère de Nano Banana Pro.",
  },
  "gpt-image-2": {
    label: "GPT Image 2",
    vendor: "OpenAI",
    kieModelT2I: "gpt-image-2-text-to-image",
    kieModelI2I: "gpt-image-2-image-to-image",
    supports: ["t2i", "i2i"],
    aspectRatios: ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "21:9", "9:21"],
    qualities: ["1K", "2K", "4K"],
    qualityParam: "resolution",
    pricing: { "1K": 0.04, "2K": 0.07, "4K": 0.16 },
    defaultPricePerImage: 0.07,
    pricingNote: "Estimated",
    maxInputImages: 16,
    notes: "4K avec rendu de texte quasi-parfait. Note: 1:1 ne peut pas atteindre 4K; aspect=auto force 1K.",
    badge: "NEW",
  },
  "seedream-4-5": {
    label: "Seedream 4.5",
    vendor: "ByteDance",
    kieModelT2I: "seedream/4.5-text-to-image",
    kieModelI2I: null,
    supports: ["t2i"],
    aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9"],
    qualities: ["2K", "4K"],
    qualityParam: "quality",
    qualityMap: { "2K": "basic", "4K": "high" },
    pricing: { "2K": 0.05, "4K": 0.10 },
    defaultPricePerImage: 0.05,
    pricingNote: "Estimated",
    maxInputImages: 0,
    notes: "Photoréaliste avec raisonnement visuel intelligent.",
  },
  "wan-2-7-image-pro": {
    label: "Wan 2.7 Pro",
    vendor: "Alibaba",
    kieModelT2I: "wan/2-7-image-pro",
    kieModelI2I: "wan/2-7-image-pro",
    supports: ["t2i", "i2i", "edit"],
    aspectRatios: ["1:1", "16:9", "4:3", "21:9", "3:4", "9:16", "8:1", "1:8"],
    qualities: ["1K", "2K", "4K"],
    qualityParam: "resolution",
    pricing: { "1K": 0.04, "2K": 0.06, "4K": 0.10 },
    defaultPricePerImage: 0.06,
    pricingNote: "Estimated",
    maxInputImages: 9,
    notes: "Édition forte. Supporte les ratios panoramiques 8:1 / 1:8.",
    badge: "NEW",
  },
};

export const VIDEO_CREATE_MODELS: Record<string, VideoCreateModel> = {
  "kling-3-0-video": {
    label: "Kling 3.0",
    vendor: "Kling",
    kieModel: "kling-3.0/video",
    aspectRatios: ["16:9", "9:16", "1:1"],
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    qualities: [
      { label: "Std", displayLabel: "720p",  resolution: "1280×720",  kieMode: "std", pricePerSecondNoAudio: 0.07,  pricePerSecondWithAudio: 0.10  },
      { label: "Pro", displayLabel: "1080p", resolution: "1920×1080", kieMode: "pro", pricePerSecondNoAudio: 0.09,  pricePerSecondWithAudio: 0.135 },
      { label: "4K",  displayLabel: "4K",    resolution: "3840×2160", kieMode: "4K",  pricePerSecondNoAudio: 0.335, pricePerSecondWithAudio: 0.335 },
    ],
    supportsEndFrame: true,
    supportsSound: true,
    badge: "TOP",
    notes: "Image-to-video avec start frame + end frame optionnelle. Single shot, 3-15s.",
  },
};

export function getAllModels() {
  return {
    image: IMAGE_MODELS,
    video: VIDEO_CREATE_MODELS,
  };
}
```

#### `src/lib/buildKieInput.ts`

Couche d'abstraction qui sait construire la bonne forme d'`input` pour chaque modèle. Chaque vendeur utilise des noms de champs différents (`resolution` vs `quality`, `input_urls` vs `image_input`…) — cette fonction gère ces différences pour que `/api/generate/run` reste model-agnostic.

```typescript
import { IMAGE_MODELS } from "./models";

export type GenerateCommon = {
  prompt: string;
  aspectRatio: string;
  quality: string;
  inputUrls: string[];
};

export type BuiltJob = {
  kieModelId: string;
  input: Record<string, unknown>;
  useVeoEndpoint: boolean;
};

export function buildKieInput(modelKey: string, common: GenerateCommon): BuiltJob {
  const model = IMAGE_MODELS[modelKey];
  if (!model) throw new Error(`Unknown image model: ${modelKey}`);

  const hasRefs = common.inputUrls.length > 0;
  const useI2I = hasRefs && model.kieModelI2I !== null;
  const kieModelId = useI2I
    ? (model.kieModelI2I as string)
    : (model.kieModelT2I as string);

  const input: Record<string, unknown> = {
    prompt: common.prompt,
  };

  if (common.aspectRatio) input.aspect_ratio = common.aspectRatio;

  if (model.qualityParam === "resolution") {
    input.resolution = common.quality;
  } else if (model.qualityParam === "quality") {
    const mapped = model.qualityMap?.[common.quality] ?? common.quality;
    input.quality = mapped;
  }

  // Input reference images — different field names per family
  if (hasRefs) {
    if (modelKey === "nano-banana-pro" || modelKey === "nano-banana") {
      input.image_input = common.inputUrls;
    } else {
      input.input_urls = common.inputUrls;
    }
  }

  // Model-specific extras
  if (modelKey === "nano-banana-pro" || modelKey === "nano-banana") {
    input.output_format = "png";
  }
  if (modelKey === "seedream-4-5") {
    input.nsfw_checker = false;
  }
  if (modelKey === "wan-2-7-image-pro") {
    input.n = 1;
    input.watermark = false;
    input.nsfw_checker = false;
  }

  // GPT Image 2 constraint: 1:1 + 4K rejeté → downgrade transparent vers 2K
  if (modelKey === "gpt-image-2" && common.aspectRatio === "1:1" && common.quality === "4K") {
    input.resolution = "2K";
  }
  if (modelKey === "gpt-image-2" && common.aspectRatio === "auto") {
    input.resolution = "1K";
  }

  return {
    kieModelId,
    input,
    useVeoEndpoint: false,
  };
}
```

---

### 9.4. API routes

#### `src/app/api/generate/run/route.ts`

Endpoint **principal** pour l'image gen. Crée un batch, soumet N tasks à KIE en parallèle, persiste les `items` avec leur `kie_task_id`.

```typescript
import { NextRequest, NextResponse } from "next/server";

import { submitTask } from "@/lib/kie";
import { IMAGE_MODELS, priceForQuality } from "@/lib/models";
import { buildKieInput } from "@/lib/buildKieInput";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Body = {
  prompt?: string;
  modelKey?: string;
  aspectRatio?: string;
  quality?: string;
  count?: number;
  inputUrls?: string[];
};

function genBatchId() {
  return `gen_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function genItemId() {
  return `it_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const prompt = (body.prompt || "").trim();
  const modelKey = body.modelKey || "nano-banana-pro";
  const aspectRatio = body.aspectRatio || "1:1";
  const quality = body.quality || "1K";
  const count = Math.max(1, Math.min(20, Number(body.count) || 1));
  const inputUrls = Array.isArray(body.inputUrls)
    ? body.inputUrls.filter((u): u is string => typeof u === "string" && u.length > 0)
    : [];

  if (!prompt) {
    return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
  }

  const model = IMAGE_MODELS[modelKey];
  if (!model) {
    return NextResponse.json({ error: `Unknown image model: ${modelKey}` }, { status: 400 });
  }

  if (inputUrls.length > 0 && !model.kieModelI2I) {
    return NextResponse.json(
      { error: `${model.label} does not accept reference images. Pick a model that supports i2i.` },
      { status: 400 },
    );
  }

  const batchId = genBatchId();
  const supabase = createSupabaseAdminClient();

  const meta = { prompt, modelKey, aspectRatio, quality, count, inputUrls };
  const estimatedCost = priceForQuality(model, quality) * count;
  const { error: batchErr } = await supabase.from("batches").insert({
    batch_id: batchId,
    kind: "image_gen",
    model: modelKey,
    status: "running",
    cost_usd: estimatedCost,
    meta_json: meta,
  });
  if (batchErr) {
    return NextResponse.json(
      { error: "Failed to create batch", detail: batchErr.message },
      { status: 500 },
    );
  }

  const built = buildKieInput(modelKey, { prompt, aspectRatio, quality, inputUrls });

  const submits = await Promise.allSettled(
    Array.from({ length: count }).map(async (_, idx) => {
      const itemId = genItemId();
      const taskId = await submitTask(built.kieModelId, built.input, {
        useVeoEndpoint: built.useVeoEndpoint,
      });
      return { itemId, idx, taskId };
    }),
  );

  const rows = submits.map((res, idx) => {
    if (res.status === "fulfilled") {
      return {
        item_id: res.value.itemId,
        batch_id: batchId,
        idx,
        status: "processing",
        input_url: inputUrls[0] ?? null,
        output_url: null,
        error: null,
        kie_task_id: res.value.taskId,
        started_at: new Date().toISOString(),
        ended_at: null,
      };
    }
    return {
      item_id: genItemId(),
      batch_id: batchId,
      idx,
      status: "failed",
      input_url: inputUrls[0] ?? null,
      output_url: null,
      error: String(res.reason).slice(0, 500),
      kie_task_id: null,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
    };
  });

  const { error: itemsErr } = await supabase.from("items").insert(rows);
  if (itemsErr) {
    return NextResponse.json(
      { error: "Failed to persist items", detail: itemsErr.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    batch_id: batchId,
    count: rows.length,
    submitted: rows.filter((r) => r.status === "processing").length,
    failed: rows.filter((r) => r.status === "failed").length,
    estimated_cost_usd: estimatedCost,
  });
}
```

#### `src/app/api/video/create/route.ts`

Idem mais pour la vidéo Kling 3.0. Différences notables : single item par batch (pas de count), re-host des frames via `rehostToKie`, paramètre `sound` qui change le prix.

```typescript
import { NextRequest, NextResponse } from "next/server";

import { rehostToKie, submitTask } from "@/lib/kie";
import { VIDEO_CREATE_MODELS } from "@/lib/models";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Body = {
  startFrameUrl?: string;
  endFrameUrl?: string;
  prompt?: string;
  modelKey?: string;
  qualityLabel?: string;
  aspectRatio?: string;
  duration?: number | string;
  sound?: boolean;
};

function genBatchId() {
  return `vid_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function genItemId() {
  return `it_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const startFrameUrl = (body.startFrameUrl || "").trim();
  const endFrameUrl = (body.endFrameUrl || "").trim();
  const prompt = (body.prompt || "").trim();
  const modelKey = body.modelKey || "kling-3-0-video";
  const qualityLabel = body.qualityLabel || "Pro";
  const aspectRatio = body.aspectRatio || "9:16";
  const duration = Number(body.duration) || 5;
  const sound = !!body.sound;

  if (!prompt) {
    return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
  }
  if (!startFrameUrl) {
    return NextResponse.json({ error: "Start frame image is required" }, { status: 400 });
  }

  const model = VIDEO_CREATE_MODELS[modelKey];
  if (!model) {
    return NextResponse.json({ error: `Unknown video model: ${modelKey}` }, { status: 400 });
  }
  const quality = model.qualities.find((q) => q.label === qualityLabel) ?? model.qualities[0];

  if (!model.durations.includes(duration)) {
    return NextResponse.json(
      { error: `Duration must be one of ${model.durations.join(", ")}` },
      { status: 400 },
    );
  }
  if (!model.aspectRatios.includes(aspectRatio)) {
    return NextResponse.json(
      { error: `Aspect ratio must be one of ${model.aspectRatios.join(", ")}` },
      { status: 400 },
    );
  }

  const batchId = genBatchId();
  const itemId = genItemId();
  const supabase = createSupabaseAdminClient();

  const unitPrice = sound ? quality.pricePerSecondWithAudio : quality.pricePerSecondNoAudio;
  const estimatedCost = unitPrice * duration;

  const meta = {
    startFrameUrl,
    endFrameUrl: endFrameUrl || null,
    prompt,
    modelKey,
    qualityLabel: quality.label,
    aspectRatio,
    duration,
    sound,
  };

  const { error: batchErr } = await supabase.from("batches").insert({
    batch_id: batchId,
    kind: "video_create",
    model: modelKey,
    status: "running",
    cost_usd: estimatedCost,
    meta_json: meta,
  });
  if (batchErr) {
    return NextResponse.json(
      { error: "Failed to create batch", detail: batchErr.message },
      { status: 500 },
    );
  }

  // Kling 3.0 ne fetch que les images sur son CDN whitelisté — rehost les
  // URLs Supabase via KIE file-stream-upload avant submit.
  try {
    const imageUrls: string[] = [];
    if (startFrameUrl) imageUrls.push(await rehostToKie(startFrameUrl, "video-frames"));
    if (endFrameUrl) imageUrls.push(await rehostToKie(endFrameUrl, "video-frames"));

    const input: Record<string, unknown> = {
      prompt,
      sound,
      duration: String(duration),
      aspect_ratio: aspectRatio,
      mode: quality.kieMode,
      multi_shots: false,
      multi_prompt: [],
    };
    if (imageUrls.length > 0) input.image_urls = imageUrls;

    const taskId = await submitTask(model.kieModel, input);

    const { error: itemErr } = await supabase.from("items").insert({
      item_id: itemId,
      batch_id: batchId,
      idx: 0,
      status: "processing",
      input_url: startFrameUrl,
      output_url: null,
      error: null,
      kie_task_id: taskId,
      started_at: new Date().toISOString(),
    });
    if (itemErr) {
      return NextResponse.json(
        { error: "Failed to persist item", detail: itemErr.message },
        { status: 500 },
      );
    }

    return NextResponse.json({
      batch_id: batchId,
      task_id: taskId,
      estimated_cost_usd: estimatedCost,
    });
  } catch (e) {
    await supabase
      .from("batches")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("batch_id", batchId);
    await supabase.from("items").insert({
      item_id: itemId,
      batch_id: batchId,
      idx: 0,
      status: "failed",
      input_url: startFrameUrl,
      output_url: null,
      error: String(e).slice(0, 500),
      kie_task_id: null,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
    });
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
```

#### `src/app/api/batch/[id]/status/route.ts`

Le polling endpoint. Appelé par le frontend toutes les 4-6s tant qu'un batch a des items en `processing`. Côté serveur : pour chaque item en attente, on poll KIE et si `success` on **archive** l'URL résultante dans Supabase Storage (parce que les URLs KIE expirent en ~24h).

```typescript
import { NextResponse } from "next/server";

import { extractResultUrls, fetchTask, normalizeState } from "@/lib/kie";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const IMAGE_BUCKET = "pixelforge-images";
const VIDEO_BUCKET = "pixelforge-videos";

type RouteContext = { params: Promise<{ id: string }> };

function detectMediaKind(url: string, contentType: string): { kind: "image" | "video"; ext: string } {
  const u = url.toLowerCase();
  const c = contentType.toLowerCase();
  if (c.startsWith("video/") || u.includes(".mp4") || u.includes(".mov") || u.includes(".webm")) {
    if (u.includes(".webm") || c.includes("webm")) return { kind: "video", ext: "webm" };
    if (u.includes(".mov") || c.includes("quicktime")) return { kind: "video", ext: "mov" };
    return { kind: "video", ext: "mp4" };
  }
  if (u.includes(".webp") || c.includes("webp")) return { kind: "image", ext: "webp" };
  if (u.includes(".jpg") || u.includes(".jpeg") || c.includes("jpeg")) return { kind: "image", ext: "jpg" };
  return { kind: "image", ext: "png" };
}

async function archiveToStorage(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  kieUrl: string,
  batchId: string,
  itemId: string,
): Promise<string> {
  try {
    const r = await fetch(kieUrl);
    if (!r.ok) return kieUrl;
    const contentType = r.headers.get("content-type") || "image/png";
    const { kind, ext } = detectMediaKind(kieUrl, contentType);
    const bucket = kind === "video" ? VIDEO_BUCKET : IMAGE_BUCKET;
    const storagePath = `${batchId}/${itemId}.${ext}`;
    const buf = Buffer.from(await r.arrayBuffer());
    const { error } = await supabase.storage
      .from(bucket)
      .upload(storagePath, buf, { contentType, upsert: true });
    if (error) {
      console.error("storage upload error", error);
      return kieUrl;
    }
    const { data } = supabase.storage.from(bucket).getPublicUrl(storagePath);
    return data.publicUrl || kieUrl;
  } catch (e) {
    console.error("archiveToStorage error", e);
    return kieUrl;
  }
}

export async function GET(_req: Request, ctx: RouteContext) {
  const { id: batchId } = await ctx.params;
  if (!batchId) return NextResponse.json({ error: "Missing batch id" }, { status: 400 });

  const supabase = createSupabaseAdminClient();

  const { data: batch } = await supabase
    .from("batches")
    .select("batch_id,kind,model,status,cost_usd,meta_json,created_at,updated_at")
    .eq("batch_id", batchId)
    .maybeSingle();
  if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });

  const { data: items } = await supabase
    .from("items")
    .select("item_id,idx,status,output_url,error,kie_task_id,started_at,ended_at")
    .eq("batch_id", batchId)
    .order("idx", { ascending: true });

  const itemsList = items || [];
  const stillProcessing = itemsList.filter((i) => i.status === "processing" && i.kie_task_id);

  if (stillProcessing.length > 0) {
    await Promise.all(
      stillProcessing.map(async (item) => {
        try {
          const record = await fetchTask(item.kie_task_id as string);
          const state = normalizeState(record);
          if (state === "success") {
            const urls = extractResultUrls(record);
            const kieUrl = urls[0] || null;
            let finalUrl: string | null = kieUrl;
            if (kieUrl) {
              finalUrl = await archiveToStorage(supabase, kieUrl, batchId, item.item_id);
            }
            await supabase
              .from("items")
              .update({
                status: "done",
                output_url: finalUrl,
                ended_at: new Date().toISOString(),
              })
              .eq("item_id", item.item_id);
            item.status = "done";
            item.output_url = finalUrl;
          } else if (state === "fail") {
            const failMsg =
              (record.failMsg as string) ||
              (record.error as string) ||
              (record.errorMessage as string) ||
              "kie task failed";
            const failCode = (record.failCode as string) || "";
            const err = failCode ? `[${failCode}] ${failMsg}` : failMsg;
            await supabase
              .from("items")
              .update({
                status: "failed",
                error: err.slice(0, 500),
                ended_at: new Date().toISOString(),
              })
              .eq("item_id", item.item_id);
            item.status = "failed";
            item.error = err;
          }
        } catch (e) {
          console.error("KIE poll error", item.item_id, e);
        }
      }),
    );
  }

  const allDone = itemsList.every((i) => i.status === "done" || i.status === "failed");
  const anyFailed = itemsList.some((i) => i.status === "failed");
  let batchStatus = batch.status;
  if (allDone && batch.status === "running") {
    batchStatus = anyFailed && itemsList.every((i) => i.status === "failed") ? "failed" : "completed";
    await supabase
      .from("batches")
      .update({ status: batchStatus, updated_at: new Date().toISOString() })
      .eq("batch_id", batchId);
  }

  return NextResponse.json({
    batch_id: batchId,
    status: batchStatus,
    cost_usd: batch.cost_usd,
    meta: batch.meta_json,
    items: itemsList.map((i) => ({
      item_id: i.item_id,
      idx: i.idx,
      status: i.status,
      output_url: i.output_url,
      error: i.error,
    })),
  });
}
```

#### `src/app/api/item/[id]/cancel/route.ts`

Cancel "soft" — marque l'item comme `cancelled` côté Supabase. KIE n'a pas d'endpoint d'annulation, donc le job continue côté KIE et est facturé, mais il disparaît de la galerie utilisateur.

```typescript
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: RouteContext) {
  const { id: itemId } = await ctx.params;
  if (!itemId) return NextResponse.json({ error: "Missing item id" }, { status: 400 });

  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("items")
    .update({
      status: "cancelled",
      ended_at: new Date().toISOString(),
      error: "cancelled by user",
    })
    .eq("item_id", itemId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
```

#### `src/app/api/items/recent/route.ts`

Liste les items récents pour la galerie. Utilisé par le bouton "Refresh" implicite ou par d'éventuelles pages list. Filtre par `kind` (image_gen ou video_create).

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 60));
  const kind = url.searchParams.get("kind") || "image_gen";

  const supabase = createSupabaseAdminClient();

  const { data: batches } = await supabase
    .from("batches")
    .select("batch_id,kind,model,status,created_at,meta_json")
    .eq("kind", kind)
    .order("created_at", { ascending: false })
    .limit(30);

  if (!batches || batches.length === 0) {
    return NextResponse.json({ items: [] });
  }

  const batchIds = batches.map((b) => b.batch_id);
  const batchByid = Object.fromEntries(batches.map((b) => [b.batch_id, b]));

  const { data: items } = await supabase
    .from("items")
    .select("item_id,batch_id,idx,status,output_url,started_at,ended_at")
    .in("batch_id", batchIds)
    .neq("status", "cancelled")
    .order("ended_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  const enriched = (items || []).map((i) => {
    const b = batchByid[i.batch_id] || {};
    const meta = (b.meta_json || {}) as Record<string, unknown>;
    return {
      item_id: i.item_id,
      batch_id: i.batch_id,
      idx: i.idx,
      status: i.status,
      output_url: i.output_url,
      created_at: i.started_at || (b.created_at as string | undefined),
      ended_at: i.ended_at,
      prompt: meta.prompt as string | undefined,
      model_key: meta.modelKey as string | undefined,
      aspect_ratio: meta.aspectRatio as string | undefined,
    };
  });

  return NextResponse.json({ items: enriched });
}
```

#### `src/app/api/upload/route.ts`

Upload multipart vers Supabase Storage. Utilisé par la PromptBar pour les images de référence (i2i) et par CreateVideoStudio pour les start/end frames.

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const BUCKET = "pixelforge-uploads";
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB

const ALLOWED_TYPES = [
  "image/png", "image/jpeg", "image/jpg", "image/webp",
  "video/mp4", "video/quicktime", "video/webm", "video/x-m4v",
] as const;

function extFromMime(mime: string): string {
  if (mime.includes("png")) return "png";
  if (mime.includes("webp") && mime.startsWith("image")) return "webp";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.startsWith("video/")) {
    if (mime.includes("quicktime")) return "mov";
    if (mime.includes("webm")) return "webm";
    if (mime.includes("m4v")) return "m4v";
    return "mp4";
  }
  return "bin";
}

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }
  const file = form.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' field" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File too large (max 50 MB)" }, { status: 413 });
  }
  const lower = file.type.toLowerCase();
  if (!ALLOWED_TYPES.includes(lower as typeof ALLOWED_TYPES[number])) {
    return NextResponse.json(
      { error: `Unsupported file type: ${file.type}` },
      { status: 415 },
    );
  }

  const supabase = createSupabaseAdminClient();
  const ext = extFromMime(file.type);
  const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const path = `${id}.${ext}`;

  const buf = Buffer.from(await file.arrayBuffer());
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, buf, { contentType: file.type, upsert: false });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  if (!data?.publicUrl) {
    return NextResponse.json({ error: "Failed to get public URL" }, { status: 500 });
  }

  return NextResponse.json({
    url: data.publicUrl,
    path,
    size: file.size,
    type: file.type,
  });
}
```

#### `src/app/api/models/route.ts`

Dump du registry models — utile pour debug/admin.

```typescript
import { NextResponse } from "next/server";
import { getAllModels } from "@/lib/models";

export const dynamic = "force-static";

export async function GET() {
  return NextResponse.json(getAllModels());
}
```

#### `src/app/api/health/route.ts`

Endpoint de santé pour vérifier que les env vars sont bien set en prod.

```typescript
import { NextResponse } from "next/server";
import { readKeyStatus } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    keys: readKeyStatus(),
    ts: Date.now(),
  });
}
```

---

### 9.5. Components UI

#### `src/components/TopNav.tsx`

Header sticky avec logo + 2 onglets (Image / Video). Garde-le simple — pas de mega menu pour ce clone.

```typescript
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Item = { href: string; label: string };

const ITEMS: Item[] = [
  { href: "/",      label: "Image" },
  { href: "/video", label: "Video" },
];

function NavLink({ item, active }: { item: Item; active: boolean }) {
  return (
    <Link
      href={item.href}
      className={`px-3 py-1.5 rounded-md text-sm font-medium whitespace-nowrap transition-colors ${
        active ? "text-pf-accent" : "text-pf-dim hover:text-pf-text"
      }`}
    >
      {item.label}
    </Link>
  );
}

export function TopNav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 bg-pf-elev/95 backdrop-blur-md border-b border-pf-border">
      <div className="flex items-center gap-6 px-5 h-14">
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <div className="w-7 h-7 rounded-md bg-pf-accent flex items-center justify-center text-pf-accent-fg font-bold text-sm">
            A
          </div>
          <span className="font-bold tracking-tight text-pf-text">AI Studio</span>
        </Link>

        <nav className="flex items-center gap-1 flex-1">
          {ITEMS.map((it) => {
            const active = pathname === it.href || (it.href === "/" && pathname === "/");
            return <NavLink key={it.href} item={it} active={active} />;
          })}
        </nav>
      </div>
    </header>
  );
}
```

#### `src/components/ModelCard.tsx`

Helpers de mise en forme pour les headers de page.

```typescript
type Props = {
  label: string;
  vendor: string;
  meta?: string;
  price: string;
};

export function ModelCard({ label, vendor, meta, price }: Props) {
  return (
    <div className="bg-pf-elev border border-pf-border rounded-lg p-3.5">
      <div className="font-semibold">{label}</div>
      <div className="text-xs text-pf-muted mt-0.5">{vendor}</div>
      {meta ? <div className="text-xs text-pf-muted mt-1.5">{meta}</div> : null}
      <div className="text-xs text-pf-accent font-semibold mt-2.5">{price}</div>
    </div>
  );
}

export function ModelsGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">{children}</div>
  );
}

export function WorkspaceHeader({ title, lede }: { title: string; lede: string }) {
  return (
    <>
      <h1 className="text-[22px] font-bold mb-1">{title}</h1>
      <p className="text-pf-dim mb-7">{lede}</p>
    </>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[11px] font-semibold uppercase tracking-[1.2px] text-pf-muted mt-8 mb-3">
      {children}
    </h2>
  );
}
```

#### `src/components/RatioIcon.tsx`

Icône SVG dont les proportions correspondent à un aspect ratio. Utilisé dans les dropdowns.

```typescript
type Props = { ratio: string; size?: number };

export function RatioIcon({ ratio, size = 18 }: Props) {
  if (ratio === "auto") {
    return (
      <span
        className="inline-flex items-center justify-center text-pf-muted"
        style={{ width: size, height: size, fontSize: size * 0.55 }}
      >
        A
      </span>
    );
  }
  const [w, h] = ratio.split(":").map(Number);
  const max = size - 4;
  const rw = w >= h ? max : (w / h) * max;
  const rh = h >= w ? max : (h / w) * max;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <rect
        x={(size - rw) / 2}
        y={(size - rh) / 2}
        width={rw}
        height={rh}
        stroke="currentColor"
        strokeWidth={1.5}
        fill="none"
        rx={2}
      />
    </svg>
  );
}
```

#### `src/components/Gallery.tsx`

La grille principale. Affiche image OU vidéo selon l'extension de l'URL. Hover-play pour les vidéos. Click → ouvre `ImagePreviewModal`. Download button apparait au hover.

```typescript
"use client";

import { Download, Loader2, AlertCircle, X } from "lucide-react";

export type GalleryItem = {
  item_id: string;
  batch_id?: string;
  idx?: number;
  status: "queued" | "processing" | "done" | "failed" | "cancelled";
  output_url?: string | null;
  prompt?: string | null;
  aspect_ratio?: string | null;
  model_key?: string | null;
  error?: string | null;
};

function aspectToClass(ratio?: string | null): string {
  switch (ratio) {
    case "9:16": return "aspect-[9/16]";
    case "16:9": return "aspect-[16/9]";
    case "4:3":  return "aspect-[4/3]";
    case "3:4":  return "aspect-[3/4]";
    case "3:2":  return "aspect-[3/2]";
    case "2:3":  return "aspect-[2/3]";
    default:     return "aspect-square";
  }
}

async function triggerDownload(url: string, filename: string) {
  try {
    const resp = await fetch(url);
    const blob = await resp.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
  } catch {
    window.open(url, "_blank");
  }
}

function isVideoUrl(url: string): boolean {
  const u = url.toLowerCase();
  return u.includes(".mp4") || u.includes(".webm") || u.includes(".mov") || u.includes("/pixelforge-videos/");
}

function Card({
  item,
  onCancel,
  onOpen,
}: {
  item: GalleryItem;
  onCancel?: (id: string) => void;
  onOpen?: (item: GalleryItem) => void;
}) {
  const ratioClass = aspectToClass(item.aspect_ratio);

  if (item.status === "done" && item.output_url) {
    const video = isVideoUrl(item.output_url);
    const ext = video ? "mp4" : "png";
    return (
      <div
        className={`group relative bg-pf-elev border border-pf-border rounded-lg overflow-hidden cursor-zoom-in ${ratioClass}`}
        onClick={() => onOpen?.(item)}
      >
        {video ? (
          <video
            src={item.output_url}
            muted
            loop
            playsInline
            preload="metadata"
            onMouseEnter={(e) => (e.currentTarget as HTMLVideoElement).play().catch(() => {})}
            onMouseLeave={(e) => {
              const v = e.currentTarget as HTMLVideoElement;
              v.pause();
              v.currentTime = 0;
            }}
            className="absolute inset-0 w-full h-full object-cover"
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.output_url}
            alt={item.prompt ?? "generated"}
            className="absolute inset-0 w-full h-full object-cover"
          />
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            triggerDownload(item.output_url!, `${item.item_id}.${ext}`);
          }}
          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-pf-bg/80 backdrop-blur-sm border border-pf-border rounded-md p-1.5 hover:bg-pf-accent hover:text-pf-accent-fg"
          aria-label="Download"
        >
          <Download size={14} />
        </button>
        {item.prompt && (
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-pf-bg/95 via-pf-bg/60 to-transparent p-3 opacity-0 group-hover:opacity-100 transition-opacity">
            <p className="text-xs text-pf-text line-clamp-3">{item.prompt}</p>
          </div>
        )}
      </div>
    );
  }

  if (item.status === "failed") {
    return (
      <div className={`group relative bg-pf-elev border border-pf-danger/50 rounded-lg overflow-hidden ${ratioClass}`}>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-pf-danger text-center px-4">
          <AlertCircle size={24} className="mb-2" />
          <span className="text-xs font-semibold">Failed</span>
          {item.error && <span className="text-[10px] text-pf-muted mt-1 line-clamp-3">{item.error}</span>}
        </div>
        {onCancel && (
          <button
            type="button"
            onClick={() => onCancel(item.item_id)}
            className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-pf-bg/80 backdrop-blur-sm border border-pf-border rounded-md p-1.5 hover:bg-pf-danger hover:text-white"
            aria-label="Dismiss"
            title="Remove from gallery"
          >
            <X size={14} />
          </button>
        )}
      </div>
    );
  }

  // queued / processing
  return (
    <div className={`group relative bg-pf-elev border border-pf-border rounded-lg overflow-hidden ${ratioClass}`}>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-pf-muted">
        <Loader2 size={24} className="animate-spin mb-2" />
        <span className="text-xs">{item.status}</span>
      </div>
      {onCancel && (
        <button
          type="button"
          onClick={() => onCancel(item.item_id)}
          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-pf-bg/80 backdrop-blur-sm border border-pf-border rounded-md p-1.5 hover:bg-pf-danger hover:text-white"
          aria-label="Cancel"
          title="Remove from gallery (KIE still bills you — no refund)"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

export function Gallery({
  items,
  onCancel,
  onOpen,
}: {
  items: GalleryItem[];
  onCancel?: (id: string) => void;
  onOpen?: (item: GalleryItem) => void;
}) {
  const visible = items.filter((i) => i.status !== "cancelled");
  if (visible.length === 0) {
    return (
      <div className="border border-dashed border-pf-border rounded-lg py-20 text-center text-pf-muted">
        No images yet. Write a prompt below and hit <span className="text-pf-accent">Generate</span>.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 pb-44">
      {visible.map((it) => (
        <Card key={it.item_id} item={it} onCancel={onCancel} onOpen={onOpen} />
      ))}
    </div>
  );
}
```

#### `src/components/ImagePreviewModal.tsx`

Modal plein écran pour examiner un résultat. Détecte vidéo vs image, affiche le prompt + métadonnées dans un panneau latéral, bouton Download. Esc / click outside pour fermer.

```typescript
"use client";

import { useEffect } from "react";
import { X, Download, Copy as CopyIcon } from "lucide-react";
import type { GalleryItem } from "./Gallery";

type Props = {
  item: GalleryItem | null;
  onClose: () => void;
};

async function triggerDownload(url: string, filename: string) {
  try {
    const resp = await fetch(url);
    const blob = await resp.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
  } catch {
    window.open(url, "_blank");
  }
}

function aspectMaxWidth(ratio?: string | null): string {
  switch (ratio) {
    case "9:16": return "max-w-[420px]";
    case "16:9": return "max-w-[1100px]";
    case "21:9": return "max-w-[1300px]";
    case "3:4":  return "max-w-[520px]";
    case "4:5":  return "max-w-[600px]";
    case "2:3":  return "max-w-[560px]";
    case "1:1":
    default:     return "max-w-[760px]";
  }
}

function isVideoUrl(url: string): boolean {
  const u = url.toLowerCase();
  return u.includes(".mp4") || u.includes(".webm") || u.includes(".mov") || u.includes("/pixelforge-videos/");
}

export function ImagePreviewModal({ item, onClose }: Props) {
  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", onKey);
    };
  }, [item, onClose]);

  if (!item || !item.output_url) return null;

  const widthClass = aspectMaxWidth(item.aspect_ratio);
  const video = isVideoUrl(item.output_url);
  const fileExt = video ? "mp4" : "png";

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/85 backdrop-blur-md flex items-center justify-center p-6"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute top-5 right-5 w-9 h-9 rounded-full bg-pf-elev border border-pf-border text-pf-text hover:bg-pf-soft flex items-center justify-center"
        aria-label="Close"
      >
        <X size={18} />
      </button>

      <div className="grid lg:grid-cols-[1fr_360px] gap-6 w-full max-w-[1400px] max-h-[calc(100vh-3rem)]">
        <div className="flex items-center justify-center min-h-0">
          {video ? (
            <video
              src={item.output_url}
              controls
              autoPlay
              playsInline
              onClick={(e) => e.stopPropagation()}
              className={`w-full ${widthClass} h-auto max-h-[calc(100vh-6rem)] object-contain rounded-lg bg-black`}
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.output_url}
              alt={item.prompt ?? "generated"}
              onClick={(e) => e.stopPropagation()}
              className={`w-full ${widthClass} h-auto max-h-[calc(100vh-6rem)] object-contain rounded-lg`}
            />
          )}
        </div>

        <aside
          className="bg-pf-elev border border-pf-border rounded-xl p-5 overflow-y-auto max-h-[calc(100vh-6rem)]"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-5">
            <div className="text-[10px] font-semibold tracking-[1.5px] uppercase text-pf-muted">
              Prompt
            </div>
            {item.prompt && (
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(item.prompt ?? "")}
                className="text-xs flex items-center gap-1 text-pf-dim hover:text-pf-text"
              >
                <CopyIcon size={12} /> Copy
              </button>
            )}
          </div>
          <p className="text-sm text-pf-text whitespace-pre-wrap leading-relaxed max-h-[40vh] overflow-y-auto pr-2 break-words">
            {item.prompt || <span className="text-pf-muted">(no prompt)</span>}
          </p>

          <div className="text-[10px] font-semibold tracking-[1.5px] uppercase text-pf-muted mt-8 mb-3">
            Information
          </div>
          <div className="space-y-2 text-sm">
            <Row label="Model"        value={item.model_key ?? "—"} />
            <Row label="Aspect ratio" value={item.aspect_ratio ?? "—"} />
            <Row label="Item id"      value={item.item_id} mono />
          </div>

          <button
            type="button"
            onClick={() => triggerDownload(item.output_url!, `${item.item_id}.${fileExt}`)}
            className="mt-7 w-full flex items-center justify-center gap-2 bg-pf-accent text-pf-accent-fg hover:opacity-90 font-semibold rounded-lg py-2.5"
          >
            <Download size={16} />
            Download
          </button>
        </aside>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-pf-muted">{label}</span>
      <span className={`text-pf-text ${mono ? "font-mono text-xs" : ""} truncate text-right`}>
        {value}
      </span>
    </div>
  );
}
```

#### `src/components/PromptBar.tsx`

LE composant central de la page Image. Barre flottante en bas avec textarea + sélecteurs (modèle / ratio / qualité / count) + upload d'images de référence. Persiste l'état dans localStorage. Cmd+Enter pour générer.

```typescript
"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, Minus, Plus, ChevronDown, Check, ImagePlus, X, Loader2 } from "lucide-react";
import { RatioIcon } from "./RatioIcon";

type ImageModelInfo = {
  key: string;
  label: string;
  vendor: string;
  aspectRatios: string[];
  qualities: string[];
  pricing: Record<string, number>;
  defaultPricePerImage: number;
  pricingNote?: string;
  maxInputImages: number;
  badge?: "TOP" | "NEW" | "SOON";
};

type Props = {
  models: ImageModelInfo[];
  busy?: boolean;
  onSubmit: (input: {
    prompt: string;
    modelKey: string;
    aspectRatio: string;
    quality: string;
    count: number;
    inputUrls: string[];
  }) => void;
};

type RefImage = { url: string; localPreview?: string };

const BAR_STORAGE_KEY = "pf:promptBar:v1";

type PersistedBar = {
  prompt: string;
  modelKey: string;
  aspectRatio: string;
  quality: string;
  count: number;
  refs: Array<{ url: string }>;
};

function readPersisted(): Partial<PersistedBar> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(BAR_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<PersistedBar>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function Badge({ kind }: { kind: "TOP" | "NEW" | "SOON" }) {
  const styles: Record<typeof kind, string> = {
    NEW: "bg-pf-accent text-pf-accent-fg",
    TOP: "bg-pink-500 text-white",
    SOON: "bg-pf-soft text-pf-muted",
  };
  return (
    <span className={`text-[9px] font-bold uppercase tracking-wider rounded px-1.5 py-0.5 ${styles[kind]}`}>
      {kind}
    </span>
  );
}

export function PromptBar({ models, busy, onSubmit }: Props) {
  const persisted = typeof window !== "undefined" ? readPersisted() : {};

  const [prompt, setPrompt] = useState(persisted.prompt ?? "");
  const [modelKey, setModelKey] = useState(() => {
    if (persisted.modelKey && models.some((m) => m.key === persisted.modelKey)) {
      return persisted.modelKey;
    }
    return models[0]?.key ?? "";
  });
  const [count, setCount] = useState(
    typeof persisted.count === "number" && persisted.count >= 1 && persisted.count <= 20
      ? persisted.count
      : 1,
  );
  const [modelOpen, setModelOpen] = useState(false);
  const [ratioOpen, setRatioOpen] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);

  const selectedModel = models.find((m) => m.key === modelKey) || models[0];
  const ratios = selectedModel?.aspectRatios ?? ["1:1"];
  const qualities = selectedModel?.qualities ?? ["1K"];
  const maxRefs = selectedModel?.maxInputImages ?? 0;

  const initialRatio =
    persisted.aspectRatio && ratios.includes(persisted.aspectRatio)
      ? persisted.aspectRatio
      : ratios.includes("9:16")
        ? "9:16"
        : ratios[0] ?? "1:1";
  const initialQuality =
    persisted.quality && qualities.includes(persisted.quality)
      ? persisted.quality
      : qualities.includes("1K")
        ? "1K"
        : qualities[0] ?? "1K";
  const [aspectRatio, setAspectRatio] = useState(initialRatio);
  const [quality, setQuality] = useState(initialQuality);

  const [refs, setRefs] = useState<RefImage[]>(() => {
    const arr = Array.isArray(persisted.refs) ? persisted.refs : [];
    return arr
      .filter((r) => r && typeof r.url === "string" && r.url.startsWith("http"))
      .map((r) => ({ url: r.url }));
  });
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const payload: PersistedBar = {
        prompt,
        modelKey,
        aspectRatio,
        quality,
        count,
        refs: refs.map((r) => ({ url: r.url })),
      };
      window.localStorage.setItem(BAR_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* quota / private mode */
    }
  }, [prompt, modelKey, aspectRatio, quality, count, refs]);

  useEffect(() => {
    if (!ratios.includes(aspectRatio)) {
      setAspectRatio(ratios.includes("9:16") ? "9:16" : ratios[0] ?? "1:1");
    }
    if (!qualities.includes(quality)) {
      setQuality(qualities.includes("1K") ? "1K" : qualities[0] ?? "1K");
    }
    if (refs.length > maxRefs) {
      setRefs((r) => r.slice(0, maxRefs));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey]);

  const unitPrice =
    selectedModel?.pricing?.[quality] ?? selectedModel?.defaultPricePerImage ?? 0;
  const estimatedCost = unitPrice * count;
  const pricePrefix = selectedModel?.pricingNote ? "~" : "";

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    if (maxRefs === 0) {
      setUploadError(`${selectedModel?.label} doesn't accept reference images.`);
      return;
    }
    setUploadError(null);
    const slots = maxRefs - refs.length;
    const toUpload = Array.from(files).slice(0, slots);
    setUploading(true);
    for (const f of toUpload) {
      const localPreview = URL.createObjectURL(f);
      try {
        const form = new FormData();
        form.append("file", f);
        const r = await fetch("/api/upload", { method: "POST", body: form });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        setRefs((prev) => [...prev, { url: data.url, localPreview }]);
      } catch (e) {
        setUploadError(String(e));
      }
    }
    setUploading(false);
  }

  function removeRef(idx: number) {
    setRefs((prev) => {
      const next = [...prev];
      const removed = next.splice(idx, 1)[0];
      if (removed?.localPreview) URL.revokeObjectURL(removed.localPreview);
      return next;
    });
  }

  function closeAllMenus() {
    setModelOpen(false);
    setRatioOpen(false);
    setQualityOpen(false);
  }

  function handleGenerate() {
    if (!prompt.trim() || busy || uploading) return;
    closeAllMenus();
    onSubmit({
      prompt: prompt.trim(),
      modelKey,
      aspectRatio,
      quality,
      count,
      inputUrls: refs.map((r) => r.url),
    });
  }

  const canAddMore = refs.length < maxRefs;

  return (
    <div className="fixed left-1/2 -translate-x-1/2 bottom-6 z-40 w-[min(960px,calc(100vw-48px))]">
      <div className="rounded-2xl border border-pf-border bg-pf-elev/95 backdrop-blur-md shadow-2xl">
        {(refs.length > 0 || maxRefs > 0) && (
          <div className="flex gap-2 items-center px-4 pt-4 pb-1 flex-wrap">
            {refs.map((r, i) => (
              <div
                key={i}
                className="relative w-16 h-16 rounded-lg overflow-hidden border border-pf-border group/ref"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={r.localPreview ?? r.url} alt="" className="w-full h-full object-cover" />
                <button
                  type="button"
                  onClick={() => removeRef(i)}
                  className="absolute top-0.5 right-0.5 bg-pf-bg/80 border border-pf-border rounded p-0.5 opacity-0 group-hover/ref:opacity-100 transition-opacity hover:bg-pf-danger hover:text-white"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
            {canAddMore && (
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                disabled={uploading}
                className="w-16 h-16 rounded-lg border border-dashed border-pf-border flex flex-col items-center justify-center text-pf-muted hover:border-pf-accent hover:text-pf-accent disabled:opacity-50"
              >
                {uploading ? <Loader2 size={18} className="animate-spin" /> : <ImagePlus size={18} />}
                <span className="text-[9px] mt-0.5">{refs.length}/{maxRefs}</span>
              </button>
            )}
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              onChange={(e) => {
                handleFiles(e.target.files);
                e.target.value = "";
              }}
              className="hidden"
            />
            {uploadError && (
              <span className="text-xs text-pf-danger ml-1">{uploadError}</span>
            )}
          </div>
        )}

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              handleGenerate();
            }
          }}
          placeholder={refs.length > 0 ? "Describe the scene you imagine…" : "Describe the image you want to generate…"}
          rows={3}
          className="w-full bg-transparent text-pf-text placeholder:text-pf-muted resize-none border-0 outline-none p-5 pb-2 text-[15px] leading-relaxed"
        />

        <div className="flex items-center gap-2 px-4 pb-3 pt-1 flex-wrap">
          {/* Model selector */}
          <div className="relative">
            <button
              type="button"
              onClick={() => { setModelOpen((s) => !s); setRatioOpen(false); setQualityOpen(false); }}
              className="flex items-center gap-2 bg-pf-soft border border-pf-border rounded-full px-3 py-1.5 text-sm hover:bg-pf-bg"
            >
              <span className="w-5 h-5 rounded-full bg-pf-accent text-pf-accent-fg flex items-center justify-center font-bold text-[10px]">
                G
              </span>
              <span>{selectedModel?.label ?? "Model"}</span>
              <ChevronDown size={14} className="text-pf-muted" />
            </button>
            {modelOpen && (
              <div className="absolute bottom-full mb-2 left-0 bg-pf-elev border border-pf-border rounded-lg shadow-2xl p-1 min-w-[280px] z-50">
                {models.map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => {
                      setModelKey(m.key);
                      setModelOpen(false);
                    }}
                    className={`w-full text-left px-3 py-2 rounded-md hover:bg-pf-soft flex items-start gap-2 ${
                      m.key === modelKey ? "text-pf-accent" : "text-pf-text"
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm">{m.label}</span>
                        {m.badge && <Badge kind={m.badge} />}
                      </div>
                      <div className="text-xs text-pf-muted mt-0.5">
                        {m.vendor} · {m.pricingNote ? "~" : ""}from $
                        {(m.pricing[m.qualities[0]] ?? m.defaultPricePerImage).toFixed(3)}/img
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Aspect ratio */}
          <div className="relative">
            <button
              type="button"
              onClick={() => { setRatioOpen((s) => !s); setModelOpen(false); setQualityOpen(false); }}
              className="flex items-center gap-1.5 bg-pf-soft border border-pf-border rounded-full px-3 py-1.5 text-sm hover:bg-pf-bg"
            >
              <span className="text-pf-text">
                <RatioIcon ratio={aspectRatio} size={14} />
              </span>
              <span>{aspectRatio}</span>
              <ChevronDown size={14} className="text-pf-muted" />
            </button>
            {ratioOpen && (
              <div className="absolute bottom-full mb-2 left-0 bg-pf-elev border border-pf-border rounded-xl shadow-2xl p-1.5 z-50 min-w-[180px] max-h-[400px] overflow-y-auto">
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-[1.2px] text-pf-muted">
                  Aspect ratio
                </div>
                {ratios.map((r) => {
                  const selected = r === aspectRatio;
                  return (
                    <button
                      key={r}
                      type="button"
                      onClick={() => { setAspectRatio(r); setRatioOpen(false); }}
                      className={`flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm hover:bg-pf-soft ${
                        selected ? "bg-pf-soft" : ""
                      }`}
                    >
                      <span className={selected ? "text-pf-text" : "text-pf-dim"}>
                        <RatioIcon ratio={r} />
                      </span>
                      <span className={`flex-1 text-left ${selected ? "text-pf-text" : "text-pf-dim"}`}>
                        {r === "auto" ? "Auto" : r}
                      </span>
                      {selected && <Check size={14} className="text-pf-text" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Quality */}
          <div className="relative">
            <button
              type="button"
              onClick={() => { setQualityOpen((s) => !s); setModelOpen(false); setRatioOpen(false); }}
              className="flex items-center gap-1.5 bg-pf-soft border border-pf-border rounded-full px-3 py-1.5 text-sm hover:bg-pf-bg"
            >
              <span className="text-pf-muted text-xs">✦</span>
              <span>{quality}</span>
              <ChevronDown size={14} className="text-pf-muted" />
            </button>
            {qualityOpen && (
              <div className="absolute bottom-full mb-2 left-0 bg-pf-elev border border-pf-border rounded-lg shadow-2xl p-1 z-50 min-w-[80px]">
                {qualities.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => { setQuality(q); setQualityOpen(false); }}
                    className={`block w-full text-left px-3 py-1.5 rounded-md hover:bg-pf-soft text-sm ${
                      q === quality ? "text-pf-accent" : "text-pf-text"
                    }`}
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Counter */}
          <div className="flex items-center gap-2 bg-pf-soft border border-pf-border rounded-full px-2 py-1 text-sm">
            <button
              type="button"
              onClick={() => setCount((c) => Math.max(1, c - 1))}
              className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-pf-bg"
            >
              <Minus size={14} />
            </button>
            <span className="min-w-[36px] text-center text-sm">{count} / 20</span>
            <button
              type="button"
              onClick={() => setCount((c) => Math.min(20, c + 1))}
              className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-pf-bg"
            >
              <Plus size={14} />
            </button>
          </div>

          <div className="flex-1" />

          <span className="text-xs text-pf-muted hidden sm:block">
            est. {pricePrefix}${estimatedCost.toFixed(3)}
          </span>

          <button
            type="button"
            onClick={handleGenerate}
            disabled={!prompt.trim() || busy || uploading}
            className="flex items-center gap-2 bg-pf-accent text-pf-accent-fg font-semibold rounded-full px-5 py-2 text-sm hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
          >
            <Sparkles size={16} />
            {busy ? "Generating…" : "Generate"}
            <span className="bg-black/15 rounded-full px-1.5 text-xs">{count}</span>
          </button>
        </div>
      </div>
      <div className="text-center text-[11px] text-pf-muted mt-2">
        ⌘ + Enter to generate · KIE.ai bills your account per image
      </div>
    </div>
  );
}
```

#### `src/components/HomeStudio.tsx`

Orchestrateur de la page Image : gère le state batches actifs, le polling, l'envoi via PromptBar, l'ouverture du modal.

```typescript
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PromptBar } from "./PromptBar";
import { Gallery, GalleryItem } from "./Gallery";
import { ImagePreviewModal } from "./ImagePreviewModal";

type ImageModelInfo = {
  key: string;
  label: string;
  vendor: string;
  aspectRatios: string[];
  qualities: string[];
  pricing: Record<string, number>;
  defaultPricePerImage: number;
  pricingNote?: string;
  maxInputImages: number;
  badge?: "TOP" | "NEW" | "SOON";
};

type Props = {
  models: ImageModelInfo[];
  initialItems: GalleryItem[];
};

type ActiveBatch = {
  batchId: string;
  prompt: string;
  modelKey: string;
  aspectRatio: string;
  quality: string;
  itemIds: string[];
};

export function HomeStudio({ models, initialItems }: Props) {
  const [items, setItems] = useState<GalleryItem[]>(initialItems);
  const [active, setActive] = useState<ActiveBatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<GalleryItem | null>(null);
  const pollers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  const stopPolling = useCallback((batchId: string) => {
    const id = pollers.current.get(batchId);
    if (id) {
      clearInterval(id);
      pollers.current.delete(batchId);
    }
    setActive((prev) => prev.filter((b) => b.batchId !== batchId));
  }, []);

  const pollBatch = useCallback(
    async (batchId: string, ctx: ActiveBatch) => {
      try {
        const r = await fetch(`/api/batch/${batchId}/status`, { cache: "no-store" });
        if (!r.ok) return;
        const data = await r.json();
        const remoteItems = (data.items || []) as Array<{
          item_id: string;
          idx: number;
          status: GalleryItem["status"];
          output_url: string | null;
          error?: string | null;
        }>;

        setItems((prev) => {
          const map = new Map(prev.map((p) => [p.item_id, p]));
          for (const ri of remoteItems) {
            const existing = map.get(ri.item_id);
            const merged: GalleryItem = {
              item_id: ri.item_id,
              batch_id: batchId,
              idx: ri.idx,
              status: ri.status,
              output_url: ri.output_url,
              error: ri.error,
              prompt: existing?.prompt ?? ctx.prompt,
              aspect_ratio: existing?.aspect_ratio ?? ctx.aspectRatio,
              model_key: existing?.model_key ?? ctx.modelKey,
            };
            map.set(ri.item_id, merged);
          }
          return Array.from(map.values()).sort((a, b) => {
            if (a.batch_id !== b.batch_id) {
              return (b.batch_id || "").localeCompare(a.batch_id || "");
            }
            return (a.idx ?? 0) - (b.idx ?? 0);
          });
        });

        const allTerminal = remoteItems.every(
          (i) => i.status === "done" || i.status === "failed",
        );
        if (allTerminal && remoteItems.length > 0) {
          stopPolling(batchId);
        }
      } catch {
        // swallow transient network errors — keep polling
      }
    },
    [stopPolling],
  );

  const handleSubmit = useCallback(
    async (input: {
      prompt: string;
      modelKey: string;
      aspectRatio: string;
      quality: string;
      count: number;
      inputUrls: string[];
    }) => {
      setBusy(true);
      setError(null);

      // Pre-insert N placeholder cards pour feedback immédiat.
      const tempId = `tmp_${Date.now().toString(36)}`;
      const placeholders: GalleryItem[] = Array.from({ length: input.count }).map((_, idx) => ({
        item_id: `${tempId}_${idx}`,
        batch_id: tempId,
        idx,
        status: "queued",
        prompt: input.prompt,
        aspect_ratio: input.aspectRatio,
        model_key: input.modelKey,
      }));
      setItems((prev) => [...placeholders, ...prev]);

      try {
        const r = await fetch("/api/generate/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        const data = await r.json();
        if (!r.ok) {
          setError(data.error || `HTTP ${r.status}`);
          setItems((prev) => prev.filter((it) => it.batch_id !== tempId));
          return;
        }

        const realBatchId = data.batch_id as string;
        const ctx: ActiveBatch = {
          batchId: realBatchId,
          prompt: input.prompt,
          modelKey: input.modelKey,
          aspectRatio: input.aspectRatio,
          quality: input.quality,
          itemIds: [],
        };
        setActive((prev) => [...prev, ctx]);
        setItems((prev) => prev.filter((it) => it.batch_id !== tempId));

        const intervalId = setInterval(() => pollBatch(realBatchId, ctx), 4000);
        pollers.current.set(realBatchId, intervalId);
        pollBatch(realBatchId, ctx);
      } catch (e) {
        setError(String(e));
        setItems((prev) => prev.filter((it) => it.batch_id !== tempId));
      } finally {
        setBusy(false);
      }
    },
    [pollBatch],
  );

  useEffect(() => {
    const cur = pollers.current;
    return () => {
      cur.forEach((id) => clearInterval(id));
      cur.clear();
    };
  }, []);

  const handleCancel = useCallback(async (itemId: string) => {
    setItems((prev) => prev.filter((i) => i.item_id !== itemId));
    try {
      await fetch(`/api/item/${encodeURIComponent(itemId)}/cancel`, { method: "POST" });
    } catch {
      /* best-effort */
    }
  }, []);

  return (
    <>
      {active.length > 0 && (
        <div className="mb-4 inline-flex items-center gap-2 bg-pf-elev border border-pf-border rounded-full px-3 py-1 text-xs text-pf-dim">
          <span className="w-2 h-2 rounded-full bg-pf-accent animate-pulse" />
          {active.length} batch{active.length > 1 ? "es" : ""} in progress
        </div>
      )}
      {error && (
        <div className="mb-4 bg-pf-elev border border-pf-danger rounded-lg px-4 py-2 text-sm text-pf-danger">
          {error}
        </div>
      )}
      <Gallery items={items} onCancel={handleCancel} onOpen={setPreview} />
      <PromptBar models={models} busy={busy} onSubmit={handleSubmit} />
      <ImagePreviewModal item={preview} onClose={() => setPreview(null)} />
    </>
  );
}
```

#### `src/components/CreateVideoStudio.tsx`

Orchestrateur de la page Vidéo : 2-column layout (panneau de paramètres à gauche, galerie à droite). Upload start/end frames via `/api/upload`, soumission via `/api/video/create`, polling toutes les 6s.

```typescript
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Sparkles, Loader2, ImagePlus, X, Check, Volume2, VolumeX, RefreshCcw,
} from "lucide-react";
import { Gallery, type GalleryItem } from "./Gallery";
import { ImagePreviewModal } from "./ImagePreviewModal";
import { RatioIcon } from "./RatioIcon";

type QualityInfo = {
  label: string;
  displayLabel: string;
  resolution: string;
  pricePerSecondNoAudio: number;
  pricePerSecondWithAudio: number;
};

type VideoCreateModelInfo = {
  key: string;
  label: string;
  vendor: string;
  aspectRatios: string[];
  durations: number[];
  qualities: QualityInfo[];
  supportsEndFrame: boolean;
  supportsSound: boolean;
  pricingNote?: string;
};

type Props = {
  models: VideoCreateModelInfo[];
  initialItems: GalleryItem[];
};

type ActiveBatch = {
  batchId: string;
  prompt: string;
};

const LS_KEY = "video_create_inputs_v1";

type PersistedInputs = {
  startFrameUrl?: string | null;
  endFrameUrl?: string | null;
  prompt?: string;
  qualityLabel?: string;
  aspectRatio?: string;
  duration?: number;
  sound?: boolean;
};

function loadPersisted(): PersistedInputs {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function savePersisted(v: PersistedInputs) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(v));
  } catch {}
}

export function CreateVideoStudio({ models, initialItems }: Props) {
  const model = models[0];
  const qualities = model?.qualities ?? [];
  const ratios = model?.aspectRatios ?? ["9:16"];
  const durations = model?.durations ?? [5];

  const [startUrl, setStartUrl] = useState<string | null>(null);
  const [endUrl, setEndUrl] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [qualityLabel, setQualityLabel] = useState<string>(qualities[1]?.label ?? qualities[0]?.label ?? "Pro");
  const [aspectRatio, setAspectRatio] = useState<string>(ratios.includes("9:16") ? "9:16" : ratios[0]);
  const [duration, setDuration] = useState<number>(5);
  const [sound, setSound] = useState<boolean>(false);
  const [uploadingStart, setUploadingStart] = useState(false);
  const [uploadingEnd, setUploadingEnd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<GalleryItem[]>(initialItems);
  const [active, setActive] = useState<ActiveBatch[]>([]);
  const [preview, setPreview] = useState<GalleryItem | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const [qualityOpen, setQualityOpen] = useState(false);
  const [ratioOpen, setRatioOpen] = useState(false);
  const [durationOpen, setDurationOpen] = useState(false);

  const startInput = useRef<HTMLInputElement | null>(null);
  const endInput = useRef<HTMLInputElement | null>(null);
  const pollers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  const selectedQuality = qualities.find((q) => q.label === qualityLabel) ?? qualities[0];

  useEffect(() => {
    const p = loadPersisted();
    if (p.startFrameUrl) setStartUrl(p.startFrameUrl);
    if (p.endFrameUrl) setEndUrl(p.endFrameUrl);
    if (p.prompt) setPrompt(p.prompt);
    if (p.qualityLabel && qualities.some((q) => q.label === p.qualityLabel)) setQualityLabel(p.qualityLabel);
    if (p.aspectRatio && ratios.includes(p.aspectRatio)) setAspectRatio(p.aspectRatio);
    if (p.duration && durations.includes(p.duration)) setDuration(p.duration);
    if (typeof p.sound === "boolean") setSound(p.sound);
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    savePersisted({
      startFrameUrl: startUrl, endFrameUrl: endUrl, prompt,
      qualityLabel, aspectRatio, duration, sound,
    });
  }, [hydrated, startUrl, endUrl, prompt, qualityLabel, aspectRatio, duration, sound]);

  async function uploadFile(file: File): Promise<string> {
    const form = new FormData();
    form.append("file", file);
    const r = await fetch("/api/upload", { method: "POST", body: form });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data.url as string;
  }

  async function handleStartFile(files: FileList | null) {
    const f = files?.[0]; if (!f) return;
    setUploadingStart(true); setError(null);
    try { setStartUrl(await uploadFile(f)); }
    catch (e) { setError(String(e)); }
    finally { setUploadingStart(false); }
  }
  async function handleEndFile(files: FileList | null) {
    const f = files?.[0]; if (!f) return;
    setUploadingEnd(true); setError(null);
    try { setEndUrl(await uploadFile(f)); }
    catch (e) { setError(String(e)); }
    finally { setUploadingEnd(false); }
  }

  const stopPolling = useCallback((batchId: string) => {
    const id = pollers.current.get(batchId);
    if (id) { clearInterval(id); pollers.current.delete(batchId); }
    setActive((prev) => prev.filter((b) => b.batchId !== batchId));
  }, []);

  const pollBatch = useCallback(async (batchId: string, ctx: ActiveBatch) => {
    try {
      const r = await fetch(`/api/batch/${batchId}/status`, { cache: "no-store" });
      if (!r.ok) return;
      const data = await r.json();
      const remoteItems = (data.items || []) as Array<{
        item_id: string; idx: number; status: GalleryItem["status"];
        output_url: string | null; error?: string | null;
      }>;
      setItems((prev) => {
        const map = new Map(prev.map((p) => [p.item_id, p]));
        for (const ri of remoteItems) {
          const existing = map.get(ri.item_id);
          map.set(ri.item_id, {
            item_id: ri.item_id, batch_id: batchId, idx: ri.idx,
            status: ri.status, output_url: ri.output_url, error: ri.error,
            prompt: existing?.prompt ?? ctx.prompt,
            aspect_ratio: existing?.aspect_ratio ?? aspectRatio,
            model_key: existing?.model_key ?? model?.key,
          });
        }
        return Array.from(map.values()).sort((a, b) => (b.batch_id || "").localeCompare(a.batch_id || ""));
      });
      const allTerminal = remoteItems.every((i) => i.status === "done" || i.status === "failed");
      if (allTerminal && remoteItems.length > 0) stopPolling(batchId);
    } catch {}
  }, [aspectRatio, model?.key, stopPolling]);

  const handleGenerate = useCallback(async () => {
    if (!startUrl || !prompt.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/video/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startFrameUrl: startUrl, endFrameUrl: endUrl, prompt: prompt.trim(),
          modelKey: model?.key, qualityLabel, aspectRatio, duration, sound,
        }),
      });
      const data = await r.json();
      if (!r.ok) { setError(data.error || `HTTP ${r.status}`); return; }
      const realBatchId = data.batch_id as string;
      const ctx: ActiveBatch = { batchId: realBatchId, prompt };
      setActive((prev) => [...prev, ctx]);
      const intervalId = setInterval(() => pollBatch(realBatchId, ctx), 6000);
      pollers.current.set(realBatchId, intervalId);
      pollBatch(realBatchId, ctx);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [startUrl, endUrl, prompt, model?.key, qualityLabel, aspectRatio, duration, sound, busy, pollBatch]);

  const handleCancel = useCallback(async (itemId: string) => {
    setItems((prev) => prev.filter((i) => i.item_id !== itemId));
    try { await fetch(`/api/item/${encodeURIComponent(itemId)}/cancel`, { method: "POST" }); } catch {}
  }, []);

  useEffect(() => {
    const cur = pollers.current;
    return () => { cur.forEach((id) => clearInterval(id)); cur.clear(); };
  }, []);

  const unitPrice = sound
    ? selectedQuality?.pricePerSecondWithAudio ?? 0
    : selectedQuality?.pricePerSecondNoAudio ?? 0;
  const estimatedCost = duration * unitPrice;
  const canGenerate = !!startUrl && !!prompt.trim() && !busy && !uploadingStart && !uploadingEnd;

  return (
    <div className="grid lg:grid-cols-[420px_1fr] gap-6 pb-32">
      <aside className="flex flex-col gap-4">
        {/* Frames */}
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[1.5px] text-pf-muted mb-2">
            Frames
          </div>
          <div className="grid grid-cols-2 gap-3">
            {/* Start frame */}
            <div>
              <div className="text-[10px] text-pf-muted mb-1.5">Start frame</div>
              {startUrl ? (
                <div className="relative aspect-square rounded-xl overflow-hidden border border-pf-border">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={startUrl} alt="" className="w-full h-full object-cover" />
                  <button
                    type="button" onClick={() => setStartUrl(null)}
                    className="absolute top-1.5 right-1.5 bg-pf-bg/80 border border-pf-border rounded-md p-1 hover:bg-pf-danger hover:text-white"
                  ><X size={12} /></button>
                </div>
              ) : (
                <button
                  type="button" onClick={() => startInput.current?.click()} disabled={uploadingStart}
                  className="w-full aspect-square rounded-xl border border-dashed border-pf-border flex flex-col items-center justify-center text-pf-muted hover:border-pf-accent hover:text-pf-accent disabled:opacity-50"
                >
                  {uploadingStart ? <Loader2 size={20} className="animate-spin" /> : <ImagePlus size={20} />}
                  <span className="text-[10px] mt-1">Upload</span>
                </button>
              )}
              <input
                ref={startInput} type="file" accept="image/png,image/jpeg,image/webp"
                onChange={(e) => { handleStartFile(e.target.files); e.target.value = ""; }}
                className="hidden"
              />
            </div>

            {/* End frame (optional) */}
            <div>
              <div className="text-[10px] text-pf-muted mb-1.5">
                End frame <span className="text-pf-muted/60">(opt)</span>
              </div>
              {endUrl ? (
                <div className="relative aspect-square rounded-xl overflow-hidden border border-pf-border">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={endUrl} alt="" className="w-full h-full object-cover" />
                  <button
                    type="button" onClick={() => setEndUrl(null)}
                    className="absolute top-1.5 right-1.5 bg-pf-bg/80 border border-pf-border rounded-md p-1 hover:bg-pf-danger hover:text-white"
                  ><X size={12} /></button>
                </div>
              ) : (
                <button
                  type="button" onClick={() => endInput.current?.click()} disabled={uploadingEnd}
                  className="w-full aspect-square rounded-xl border border-dashed border-pf-border flex flex-col items-center justify-center text-pf-muted hover:border-pf-accent hover:text-pf-accent disabled:opacity-50"
                >
                  {uploadingEnd ? <Loader2 size={20} className="animate-spin" /> : <ImagePlus size={20} />}
                  <span className="text-[10px] mt-1">Upload</span>
                </button>
              )}
              <input
                ref={endInput} type="file" accept="image/png,image/jpeg,image/webp"
                onChange={(e) => { handleEndFile(e.target.files); e.target.value = ""; }}
                className="hidden"
              />
            </div>
          </div>
        </div>

        {/* Prompt */}
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[1.5px] text-pf-muted mb-2">
            Prompt
          </div>
          <textarea
            value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5}
            placeholder="Describe the motion: camera moves, what happens between start and end frames..."
            className="w-full bg-pf-elev border border-pf-border rounded-xl p-3 text-sm text-pf-text placeholder:text-pf-muted resize-none outline-none focus:border-pf-accent"
          />
        </div>

        {/* Settings row */}
        <div className="bg-pf-elev border border-pf-border rounded-xl p-3">
          <div className="grid grid-cols-3 gap-2">
            {/* Aspect ratio */}
            <div className="relative">
              <button
                type="button" onClick={() => { setRatioOpen((s) => !s); setQualityOpen(false); setDurationOpen(false); }}
                className="w-full bg-pf-soft border border-pf-border rounded-lg p-2.5 hover:bg-pf-bg"
              >
                <div className="text-[10px] uppercase tracking-[1.2px] text-pf-muted">Ratio</div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <RatioIcon ratio={aspectRatio} size={14} />
                  <span className="font-semibold text-sm">{aspectRatio}</span>
                </div>
              </button>
              {ratioOpen && (
                <div className="absolute top-full mt-1 left-0 right-0 bg-pf-elev border border-pf-border rounded-lg shadow-2xl p-1 z-50">
                  {ratios.map((r) => (
                    <button
                      key={r} type="button"
                      onClick={() => { setAspectRatio(r); setRatioOpen(false); }}
                      className={`flex items-center gap-2 w-full px-2 py-1.5 rounded-md hover:bg-pf-soft ${r === aspectRatio ? "bg-pf-soft" : ""}`}
                    >
                      <RatioIcon ratio={r} size={14} />
                      <span className="text-sm flex-1 text-left">{r}</span>
                      {r === aspectRatio && <Check size={12} />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Duration */}
            <div className="relative">
              <button
                type="button" onClick={() => { setDurationOpen((s) => !s); setQualityOpen(false); setRatioOpen(false); }}
                className="w-full bg-pf-soft border border-pf-border rounded-lg p-2.5 hover:bg-pf-bg"
              >
                <div className="text-[10px] uppercase tracking-[1.2px] text-pf-muted">Duration</div>
                <div className="font-semibold text-sm mt-0.5">{duration}s</div>
              </button>
              {durationOpen && (
                <div className="absolute top-full mt-1 left-0 right-0 bg-pf-elev border border-pf-border rounded-lg shadow-2xl p-1 z-50 max-h-[240px] overflow-y-auto">
                  {durations.map((d) => (
                    <button
                      key={d} type="button"
                      onClick={() => { setDuration(d); setDurationOpen(false); }}
                      className={`block w-full text-left px-3 py-1.5 rounded-md hover:bg-pf-soft text-sm ${d === duration ? "text-pf-accent" : ""}`}
                    >{d}s</button>
                  ))}
                </div>
              )}
            </div>

            {/* Quality */}
            <div className="relative">
              <button
                type="button" onClick={() => { setQualityOpen((s) => !s); setRatioOpen(false); setDurationOpen(false); }}
                className="w-full bg-pf-soft border border-pf-border rounded-lg p-2.5 hover:bg-pf-bg"
              >
                <div className="text-[10px] uppercase tracking-[1.2px] text-pf-muted">Quality</div>
                <div className="font-semibold text-sm mt-0.5">{selectedQuality?.displayLabel}</div>
              </button>
              {qualityOpen && (
                <div className="absolute top-full mt-1 right-0 left-0 bg-pf-elev border border-pf-border rounded-lg shadow-2xl p-1 z-50 min-w-[200px]">
                  {qualities.map((q) => {
                    const price = sound ? q.pricePerSecondWithAudio : q.pricePerSecondNoAudio;
                    return (
                      <button
                        key={q.label} type="button"
                        onClick={() => { setQualityLabel(q.label); setQualityOpen(false); }}
                        className={`w-full text-left px-3 py-2 rounded-md hover:bg-pf-soft flex items-center justify-between ${q.label === qualityLabel ? "bg-pf-soft" : ""}`}
                      >
                        <div>
                          <div className="font-semibold text-sm">{q.displayLabel}</div>
                          <div className="text-[10px] text-pf-muted">
                            {q.resolution} · ${price.toFixed(3)}/s
                            {sound && q.pricePerSecondNoAudio !== q.pricePerSecondWithAudio && (
                              <span className="text-pf-muted/60"> (+audio)</span>
                            )}
                          </div>
                        </div>
                        {q.label === qualityLabel && <Check size={12} />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Sound toggle + cost */}
          <div className="flex items-center justify-between mt-3 px-1">
            <button
              type="button" onClick={() => setSound((s) => !s)}
              className={`flex items-center gap-1.5 text-xs ${sound ? "text-pf-accent" : "text-pf-muted"}`}
            >
              {sound ? <Volume2 size={14} /> : <VolumeX size={14} />}
              <span>Sound {sound ? "on" : "off"}</span>
            </button>
            <div className="text-right">
              <div className="text-xs text-pf-muted">
                {duration}s × ${unitPrice.toFixed(3)}/s
              </div>
              <div className="font-semibold text-base">
                ${estimatedCost.toFixed(2)}
              </div>
            </div>
          </div>
        </div>

        <button
          type="button" onClick={handleGenerate} disabled={!canGenerate}
          className="w-full flex items-center justify-center gap-2 bg-pf-accent text-pf-accent-fg font-semibold rounded-lg py-3 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Sparkles size={16} />
          {busy ? "Submitting…" : "Generate"}
        </button>
        {!startUrl && <div className="text-[11px] text-pf-muted text-center">Upload a start frame to begin.</div>}
        {startUrl && !prompt.trim() && <div className="text-[11px] text-pf-muted text-center">Add a prompt.</div>}
        {error && <div className="text-[11px] text-pf-danger text-center">{error}</div>}
      </aside>

      <div>
        {active.length > 0 && (
          <div className="mb-4 inline-flex items-center gap-2 bg-pf-elev border border-pf-border rounded-full px-3 py-1 text-xs text-pf-dim">
            <span className="w-2 h-2 rounded-full bg-pf-accent animate-pulse" />
            <RefreshCcw size={11} className="animate-spin" />
            {active.length} video{active.length > 1 ? "s" : ""} rendering (3-15 min)
          </div>
        )}
        <Gallery items={items} onCancel={handleCancel} onOpen={setPreview} />
      </div>
      <ImagePreviewModal item={preview} onClose={() => setPreview(null)} />
    </div>
  );
}
```

---

### 9.6. Pages

#### `src/app/page.tsx` — Image generation home

Page d'accueil. Fait un SSR query Supabase pour les items récents (pour les voir au load), puis passe au component client `HomeStudio`.

```typescript
import { IMAGE_MODELS } from "@/lib/models";
import { HomeStudio } from "@/components/HomeStudio";
import { WorkspaceHeader } from "@/components/ModelCard";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { GalleryItem } from "@/components/Gallery";

export const dynamic = "force-dynamic";

async function fetchRecentItems(): Promise<GalleryItem[]> {
  try {
    const supabase = createSupabaseAdminClient();
    const { data: batches } = await supabase
      .from("batches")
      .select("batch_id,kind,model,status,created_at,meta_json")
      .eq("kind", "image_gen")
      .order("created_at", { ascending: false })
      .limit(30);
    if (!batches || batches.length === 0) return [];

    const batchById: Record<string, (typeof batches)[number]> = Object.fromEntries(
      batches.map((b) => [b.batch_id, b]),
    );

    const { data: items } = await supabase
      .from("items")
      .select("item_id,batch_id,idx,status,output_url,started_at,ended_at,error")
      .in("batch_id", batches.map((b) => b.batch_id))
      .neq("status", "cancelled")
      .order("ended_at", { ascending: false, nullsFirst: false })
      .limit(60);

    return (items || []).map((i) => {
      const b = batchById[i.batch_id] || ({} as (typeof batches)[number]);
      const meta = (b.meta_json || {}) as {
        prompt?: string;
        modelKey?: string;
        aspectRatio?: string;
      };
      return {
        item_id: i.item_id,
        batch_id: i.batch_id,
        idx: i.idx ?? undefined,
        status: i.status,
        output_url: i.output_url,
        error: i.error,
        prompt: meta.prompt ?? null,
        aspect_ratio: meta.aspectRatio ?? null,
        model_key: meta.modelKey ?? null,
      } satisfies GalleryItem;
    });
  } catch (e) {
    console.error("fetchRecentItems failed:", e);
    return [];
  }
}

export default async function Home() {
  const initialItems = await fetchRecentItems();

  const models = Object.entries(IMAGE_MODELS).map(([key, m]) => ({
    key,
    label: m.label,
    vendor: m.vendor,
    aspectRatios: m.aspectRatios,
    qualities: m.qualities,
    pricing: m.pricing,
    defaultPricePerImage: m.defaultPricePerImage,
    pricingNote: m.pricingNote,
    maxInputImages: m.maxInputImages,
    badge: m.badge,
  }));

  return (
    <>
      <WorkspaceHeader
        title="Image generation"
        lede="Generate images from text prompts. Up to 20 in parallel per run."
      />
      <HomeStudio models={models} initialItems={initialItems} />
    </>
  );
}
```

#### `src/app/video/page.tsx` — Video generation

Page vidéo. Même pattern : fetch items récents en SSR, passe au client `CreateVideoStudio`.

```typescript
import { VIDEO_CREATE_MODELS } from "@/lib/models";
import { CreateVideoStudio } from "@/components/CreateVideoStudio";
import { WorkspaceHeader } from "@/components/ModelCard";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { GalleryItem } from "@/components/Gallery";

export const dynamic = "force-dynamic";

async function fetchRecentVideos(): Promise<GalleryItem[]> {
  try {
    const supabase = createSupabaseAdminClient();
    const { data: batches } = await supabase
      .from("batches")
      .select("batch_id,kind,model,status,created_at,meta_json")
      .eq("kind", "video_create")
      .order("created_at", { ascending: false })
      .limit(30);
    if (!batches || batches.length === 0) return [];
    const batchById = Object.fromEntries(batches.map((b) => [b.batch_id, b]));

    const { data: items } = await supabase
      .from("items")
      .select("item_id,batch_id,idx,status,output_url,started_at,ended_at,error")
      .in("batch_id", batches.map((b) => b.batch_id))
      .neq("status", "cancelled")
      .order("ended_at", { ascending: false, nullsFirst: false })
      .limit(60);

    return (items || []).map((i) => {
      const b = batchById[i.batch_id];
      const meta = (b?.meta_json || {}) as {
        prompt?: string;
        modelKey?: string;
        aspectRatio?: string;
      };
      return {
        item_id: i.item_id,
        batch_id: i.batch_id,
        idx: i.idx ?? undefined,
        status: i.status,
        output_url: i.output_url,
        error: i.error,
        prompt: meta.prompt ?? null,
        aspect_ratio: meta.aspectRatio ?? "9:16",
        model_key: meta.modelKey ?? null,
      } satisfies GalleryItem;
    });
  } catch (e) {
    console.error("fetchRecentVideos failed:", e);
    return [];
  }
}

export default async function VideoPage() {
  const initialItems = await fetchRecentVideos();

  const videoCreateModels = Object.entries(VIDEO_CREATE_MODELS).map(([key, m]) => ({
    key,
    label: m.label,
    vendor: m.vendor,
    aspectRatios: m.aspectRatios,
    durations: m.durations,
    qualities: m.qualities.map((q) => ({
      label: q.label,
      displayLabel: q.displayLabel,
      resolution: q.resolution,
      pricePerSecondNoAudio: q.pricePerSecondNoAudio,
      pricePerSecondWithAudio: q.pricePerSecondWithAudio,
    })),
    supportsEndFrame: m.supportsEndFrame,
    supportsSound: m.supportsSound,
    pricingNote: m.pricingNote,
  }));

  return (
    <>
      <WorkspaceHeader
        title="Video"
        lede="Generate videos from images using Kling 3.0."
      />
      <CreateVideoStudio models={videoCreateModels} initialItems={initialItems} />
    </>
  );
}
```

---

## 10. Étape 6 — Lancer en local

Maintenant que tout est en place, depuis la racine de ton projet :

```bash
npm run dev
```

Ouvre [http://localhost:3000](http://localhost:3000).

### Tests rapides

1. **Page Image (/)** : tu vois le header "Image generation" + une galerie vide + la PromptBar fixe en bas
2. **Page Video (/video)** : panneau de paramètres à gauche + galerie vide à droite
3. **Health check** : va sur [http://localhost:3000/api/health](http://localhost:3000/api/health) — tu dois voir :
   ```json
   {
     "ok": true,
     "keys": {
       "kie": true,
       "supabaseUrl": true,
       "supabaseAnon": true,
       "supabaseServiceRole": true
     },
     "ts": 1234567890123
   }
   ```
   Si une clé est `false`, vérifie ton `.env.local` (et **redémarre** `npm run dev` — Next ne reload pas les env vars chaudes).

### Première génération

1. Sur `/`, tape un prompt simple : `A serene mountain landscape at sunrise, photorealistic`
2. Laisse le modèle par défaut (Nano Banana Pro), ratio 9:16, qualité 1K, count 1
3. Click **Generate** → tu vois un placeholder gris dans la galerie
4. Attends ~10-30s — l'image apparaît
5. Click dessus → modal plein écran avec download

Si ça plante :
- **Erreur "Failed to fetch"** : le `npm run dev` est mort, relance
- **Erreur "KIE.ai authentication failed"** : ta `KIE_API_KEY` est wrong
- **Erreur "Failed to create batch"** : tes credentials Supabase sont wrong, ou les tables n'existent pas (recolle le SQL)
- L'image est marquée "Failed" sans message clair : check les logs `Vercel logs` ou `npm run dev` terminal — KIE renvoie souvent des codes comme `[content_policy_violation]` pour des prompts NSFW

---

## 11. Étape 7 — Déployer sur Vercel

### 11.1. Push sur GitHub

Crée un repo GitHub vide (sans README, sans .gitignore), puis :

```bash
git add -A
git commit -m "Initial AI Studio clone"
git branch -M main
git remote add origin https://github.com/TON_USER/ai-studio.git
git push -u origin main
```

### 11.2. Créer le projet Vercel

1. Va sur [vercel.com](https://vercel.com) → **Sign up** avec GitHub (gratuit)
2. **Add New** → **Project** → sélectionne ton repo `ai-studio`
3. **Framework Preset** : Next.js (détecté auto)
4. **Root Directory** : laisse vide (racine)
5. **Environment Variables** : ajoute les 4 mêmes que ton `.env.local` :
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `KIE_API_KEY`
6. **Deploy**

Premier build ~2 min. Tu reçois une URL `ai-studio-xxx.vercel.app`.

### 11.3. Plan Vercel : Hobby vs Pro

- **Hobby (gratuit)** : `maxDuration` capped à **10s** par route. Suffisant pour image gen rapide mais **trop court** pour KIE qui peut prendre 30-60s. Tes générations marcheront mais le polling sera fragile.
- **Pro ($20/mois)** : `maxDuration` peut aller à **60s** (déjà setté dans le code via `export const maxDuration = 60`). Recommandé dès que tu génères régulièrement.

### 11.4. Vérifier le déploiement

Va sur ton URL Vercel + `/api/health` — pareil que en local, toutes les clés à `true`.
Puis génère une image — pareil que en local.

### 11.5. (Optionnel) Custom domain

Settings → Domains → Add → entre ton domaine (ex. `ai.tondomaine.com`) → suis les instructions DNS (CNAME vers `cname.vercel-dns.com`).

---

## 12. Checklist de test

Avant de considérer le SaaS "fonctionnel", valide chaque point :

### Image generation
- [ ] `/` charge sans erreur, galerie vide visible
- [ ] PromptBar : taper du texte, changer modèle, changer ratio, changer qualité, changer count
- [ ] PromptBar : refresh la page → état restauré depuis localStorage
- [ ] Upload d'une image de référence → preview thumbnail visible
- [ ] Generate avec count=1 → placeholder gris → image après ~15s
- [ ] Generate avec count=5 → 5 placeholders → 5 images en parallèle
- [ ] Click sur image → modal plein écran s'ouvre
- [ ] Modal : Esc ferme, click outside ferme, bouton X ferme
- [ ] Modal : bouton Download télécharge le fichier
- [ ] Test chaque modèle au moins une fois (Nano Banana Pro, GPT Image 2, etc.)
- [ ] Test i2i avec Nano Banana Pro + 1 image de ref
- [ ] Refresh la page → galerie repeuple depuis Supabase

### Video generation
- [ ] `/video` charge, panneau de paramètres + galerie vide
- [ ] Upload start frame → thumbnail visible
- [ ] Upload end frame (optionnel) → thumbnail visible
- [ ] Settings : changer ratio / duration / quality / sound → coût mis à jour
- [ ] Generate sans start frame → bouton désactivé + hint "Upload a start frame"
- [ ] Generate sans prompt → bouton désactivé + hint "Add a prompt"
- [ ] Generate avec start + prompt → "3-15 min rendering" badge
- [ ] Vidéo apparait au bout de ~5min, lecture au hover dans la galerie
- [ ] Click vidéo → modal avec player vidéo

### Persistence
- [ ] Items archivés dans Supabase Storage : va dans Supabase → Storage → bucket `pixelforge-images` → tu vois `<batch_id>/<item_id>.png`
- [ ] Idem pour `pixelforge-videos`
- [ ] BDD : Supabase → Table Editor → table `batches` → tu vois tes batches récents
- [ ] BDD : table `items` → entries avec `status='done'` + `output_url` pointant vers Supabase

### Cleanup
- [ ] Click bouton X sur un item failed → disparaît de la galerie
- [ ] Click bouton X sur un item en processing → disparaît + KIE continue en arrière-plan

---

## 13. Personnalisation

### Ajouter un nouveau modèle d'image

1. Ouvre `src/lib/models.ts`
2. Ajoute une entrée dans `IMAGE_MODELS` :
   ```typescript
   "mon-nouveau-modele": {
     label: "Mon Modèle",
     vendor: "Vendeur",
     kieModelT2I: "kie/model-id-t2i",
     kieModelI2I: "kie/model-id-i2i", // ou null si pas d'i2i
     supports: ["t2i", "i2i"],
     aspectRatios: ["1:1", "16:9"],
     qualities: ["1K", "2K"],
     qualityParam: "resolution", // ou "quality" si le modèle utilise "quality" comme champ
     pricing: { "1K": 0.05, "2K": 0.10 },
     defaultPricePerImage: 0.05,
     maxInputImages: 5,
     notes: "Description du modèle.",
   },
   ```
3. Si le modèle a des paramètres spéciaux, ajoute la logique dans `src/lib/buildKieInput.ts`
4. Redémarre `npm run dev` — le modèle apparait dans le dropdown

### Changer la marque / le logo

1. `src/components/TopNav.tsx` : change `"AI Studio"` par ton nom + change la lettre dans le `<div>` (actuellement "A")
2. `src/app/layout.tsx` : change le `title` dans `metadata`
3. `src/app/globals.css` : change `--color-pf-accent` pour ta couleur d'accent

### Ajouter un système d'auth multi-user

Tu auras besoin de :
1. Activer **Supabase Auth** (Dashboard → Authentication → Settings)
2. Ajouter un `owner_id uuid` aux tables `batches` et `items` (avec FK vers `auth.users.id`)
3. Activer **Row Level Security** sur ces 2 tables avec une policy `(auth.uid() = owner_id)`
4. Remplacer `createSupabaseAdminClient` par `createSupabaseServerClient` dans les API routes pour respecter la session utilisateur
5. Wrapper l'app dans un middleware auth qui redirige vers `/login` si pas connecté

C'est un assez gros refactor — fais-le seulement si tu vises un produit multi-tenant.

---

## 14. Troubleshooting

### "Module not found: Can't resolve 'sharp'"
→ Lance `npm install sharp`. Si erreur de build natif, force la version : `npm install sharp@^0.34.0 --include=optional`

### "Failed to fetch ... ENOTFOUND api.kie.ai"
→ Pas de réseau, ou KIE est down. Vérifie [https://status.kie.ai](https://status.kie.ai)

### "KIE.ai authentication failed (HTTP 401)"
→ Clé `KIE_API_KEY` invalide. Régénère sur kie.ai → API Keys → Create new key → met-la dans `.env.local` + dans Vercel env vars + **redéploie**

### "KIE.ai is out of credits"
→ Recharge sur kie.ai → Billing

### "Failed to create batch" (Supabase)
→ Vérifie que les tables `batches` et `items` existent (Supabase Table Editor) et que `SUPABASE_SERVICE_ROLE_KEY` est la **service_role** (pas la anon).

### Génération marquée "Failed" sans détails
→ Ouvre les logs Vercel (Project → Logs) ou ton terminal `npm run dev`. KIE renvoie souvent des codes comme :
- `[content_policy_violation]` → prompt NSFW, reformule
- `[invalid_input]` → paramètre invalide (aspect ratio non supporté, etc.)
- `[insufficient_credits]` → recharge KIE

### Les vidéos ne génèrent pas
→ Kling refuse souvent les images Supabase. Vérifie dans les logs que `rehostToKie` réussit. Si erreur sharp, la frame source est peut-être corrompue — re-uploade une autre image.

### Mes images générées ont des URLs `kie.ai/...` au lieu de Supabase
→ L'archivage a échoué (probablement Supabase Storage bucket policy). Va dans Supabase → Storage → `pixelforge-images` → Policies → assure-toi que le bucket est **public** (toggle en haut).

### Le polling ne s'arrête jamais
→ Bug rare : un task KIE reste bloqué en `processing` côté KIE. Le bouton X de la galerie permet de le retirer du UI (KIE continue de facturer, désolé).

### Vercel build échoue avec "Cannot find module 'sharp'"
→ Vérifie que `serverExternalPackages: ["sharp"]` est bien dans `next.config.ts`. Si tu utilises une version ancienne de Next, c'est `experimental.serverComponentsExternalPackages`.

### "Database error: relation 'public.batches' does not exist"
→ Tu as oublié de run le SQL Supabase. Retourne à l'étape 5.2.

---

## Annexe — Comparaison avec le projet d'origine

Ce clone correspond à la **partie Image + Vidéo** d'un SaaS plus large appelé PixelForge. Les fonctionnalités suivantes ont été **volontairement exclues** pour rester focus sur l'essentiel :

- ❌ Système de "Briefs" (workflow de création publicitaire orchestrée)
- ❌ Synchronisation Notion (push de briefs sur des pages Notion)
- ❌ Upload Google Drive (archive des assets)
- ❌ Génération de voix off (ElevenLabs)
- ❌ Transcription audio (Whisper / KIE)
- ❌ Cut silence (nettoyage audio in-browser)
- ❌ Génération de copies publicitaires (Anthropic Claude)
- ❌ Génération de prompts assistée (Anthropic Claude)
- ❌ Lipsync (Kling Avatars)
- ❌ Batch wizard hebdomadaire

Si tu veux les ajouter plus tard, le code de chaque feature est modulaire et facile à réintégrer.

---

**Voilà.** Avec ce document tu as **tout** pour reconstruire un SaaS de génération d'images + vidéos IA fonctionnel. Compte 1-2h si tu es à l'aise avec Node/Next, ou 3-4h si c'est ta première fois avec Supabase/Vercel.

Bonne génération 🎨

— Document écrit pour faciliter la duplication d'un SaaS existant. Source : PixelForge (Tristan Rabel). Distribué tel quel, modifie librement.
