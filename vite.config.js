import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],
    server: {
        proxy: {
            '/api/gemini': {
                target: 'https://generativelanguage.googleapis.com',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api\/gemini/, ''),
            },
            '/api/local-ocr': {
                target: 'http://127.0.0.1:8000',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api\/local-ocr/, '/api/local-ocr'),
            },
            '/api/google': {
                target: 'https://maps.googleapis.com',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api\/google/, ''),
            },
            '/api/groq': {
                target: 'https://api.groq.com',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api\/groq/, ''),
            }
        }
    }
})
