import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vitejs.dev/config/
export default defineConfig({
  // Flask sirve el bundle desde /static, asi que el build tiene que referenciar
  // los assets con ese prefijo. En dev el propio server de Vite tambien sirve
  // bajo /static/ (incluido public/: favicon.png e img/wedo-logo.png).
  base: '/static/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 3000,
    // OJO: no proxear /static. Colisiona con base y el dev server terminaria
    // mandando al backend sus propios modulos y el cliente de HMR, con lo cual
    // npm run dev no sirve nada. Solo se proxean las rutas del backend.
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/download': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      // El 302 a /login cuando no hay sesion tiene que llegar al browser tal
      // cual para que apiFetch() lo detecte.
      '/login': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/logout': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      }
    }
  }
})
