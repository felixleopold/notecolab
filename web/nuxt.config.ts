export default defineNuxtConfig({
  modules: ['@nuxtjs/tailwindcss', 'nuxt-og-image'],

  css: ['~/assets/css/theme.css', '~/assets/css/pure-white.css', 'katex/dist/katex.min.css'],

  // Used by nuxt-og-image to build absolute og:image URLs and as og:site_name.
  site: {
    url: 'https://notecolab.com',
    name: 'NoteColab',
  },

  ogImage: {
    // Render the preview card with satori (pure JS) + resvg-wasm everywhere, so
    // no native binary is needed — keeps the node:22-alpine runtime portable
    // (the native @resvg/resvg-js has no reliable musl story in the slim image).
    compatibility: {
      dev: { resvg: 'wasm' },
      runtime: { resvg: 'wasm' },
      prerender: { resvg: 'wasm' },
    },
  },

  app: {
    head: {
      title: 'NoteColab',
      meta: [
        { name: 'description', content: 'Collaborative note sharing for Obsidian' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      ],
    },
  },

  runtimeConfig: {
    public: {
      apiUrl: 'https://notecolab.com',
    },
  },

  ssr: true,

  compatibilityDate: '2024-11-01',

  nitro: {
    preset: 'node-server',
    routeRules: {
      '/**': {
        headers: {
          // Nuxt emits a small inline hydration payload. Keep scripts restricted
          // to this origin while allowing that framework-generated bootstrap.
          'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' https: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
          'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
          'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
        },
      },
      '/downloads/main.js': {
        headers: {
          'Content-Disposition': 'attachment; filename="main.js"',
          'Cache-Control': 'no-cache, must-revalidate',
          'CDN-Cache-Control': 'no-store',
        },
      },
      '/downloads/manifest.json': {
        headers: {
          'Content-Disposition': 'attachment; filename="manifest.json"',
          'Cache-Control': 'no-cache, must-revalidate',
          'CDN-Cache-Control': 'no-store',
        },
      },

    },
  },
})
